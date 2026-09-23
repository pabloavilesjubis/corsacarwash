-- ============================================================
-- Pruebas de 0045_credito_de_clientes.sql
--
--   psql … -f supabase/tests/0045_prereq.sql
--   psql … -f supabase/migrations/0045_credito_de_clientes.sql
--   psql … -f supabase/tests/0045_datos.sql
--   psql … -f supabase/tests/0045_credito.test.sql
--
-- La concurrencia va aparte, con pgbench:
--   pgbench -c 20 -j 8 -t 1 -n -f supabase/tests/0045_concurrencia.sql
-- ============================================================

\set CLIENTE '22222222-2222-2222-2222-222222222222'

-- Punto de partida limpio.
delete from public.corporate_credit_events;
delete from public.accounts_receivable;
delete from public.corporate_accounts;
update public.corsa_test_estado set permisos = array['corporate.manage','payments.create'];

-- ── El límite es obligatorio ─────────────────────────────────
-- Sin esto se podría habilitar crédito «ilimitado» por olvido.
do $$
declare fallo int := 0;
begin
  begin perform public.credito_habilitar('22222222-2222-2222-2222-222222222222', 0);
  exception when others then fallo := fallo + 1; end;
  begin perform public.credito_habilitar('22222222-2222-2222-2222-222222222222', null);
  exception when others then fallo := fallo + 1; end;
  begin perform public.credito_habilitar('22222222-2222-2222-2222-222222222222', -100);
  exception when others then fallo := fallo + 1; end;
  assert fallo = 3, format('Se pudo habilitar crédito sin límite (%s de 3 rechazos)', fallo);
end $$;

-- ── Habilitar exige corporate.manage ─────────────────────────
-- Se verifica en la función y no en la pantalla: una pantalla se esconde con
-- un if, la API se llama igual desde cualquier lado.
do $$
declare permitio boolean := false;
begin
  update public.corsa_test_estado set permisos = array['customers.read','customers.update'];
  begin
    perform public.credito_habilitar('22222222-2222-2222-2222-222222222222', 500);
    permitio := true;
  exception when others then null;
  end;
  update public.corsa_test_estado set permisos = array['corporate.manage','payments.create'];
  assert not permitio, 'Se habilitó crédito sin el permiso corporate.manage';
end $$;

-- ── El camino feliz ──────────────────────────────────────────
do $$
declare d jsonb;
begin
  perform public.credito_habilitar('22222222-2222-2222-2222-222222222222', 500, 15);
  d := public.credito_disponible('22222222-2222-2222-2222-222222222222');
  assert (d->>'habilitado')::boolean, 'No quedó habilitado';
  assert (d->>'limite')::numeric = 500, 'Límite mal guardado';
  assert (d->>'disponible')::numeric = 500, 'Disponible inicial distinto del límite';

  d := public.credito_cobrar('22222222-2222-2222-2222-222222222222', 120);
  assert (d->>'saldo')::numeric = 120, 'El saldo no subió';
  assert (d->>'disponible')::numeric = 380, 'El disponible no bajó';
  assert not (d->>'excedido')::boolean, 'Marcó excedido dentro del cupo';

  -- El cargo tiene que dejar la cuenta por cobrar, no sólo mover el saldo.
  assert (select count(*) from public.accounts_receivable
           where customer_id = '22222222-2222-2222-2222-222222222222') = 1,
    'No se registró la cuenta por cobrar';
  assert (select due_date from public.accounts_receivable limit 1)
         = (now() at time zone 'America/El_Salvador')::date + 15,
    'El vencimiento no respeta credit_days';
end $$;

-- ── Al límite se bloquea ─────────────────────────────────────
do $$
declare paso boolean := false;
begin
  begin
    perform public.credito_cobrar('22222222-2222-2222-2222-222222222222', 400);
    paso := true;
  exception when others then null;
  end;
  assert not paso, 'Se cobró por encima del límite sin autorización';
  assert (select current_balance from public.corporate_accounts) = 120,
    'Un cobro rechazado movió el saldo';
end $$;

-- ── Forzar necesita corporate.credit_override ────────────────
do $$
declare paso boolean := false; d jsonb;
begin
  begin
    perform public.credito_cobrar('22222222-2222-2222-2222-222222222222', 400, null, true);
    paso := true;
  exception when others then null;
  end;
  assert not paso, 'Se forzó el cobro sin el permiso de override';

  update public.corsa_test_estado
     set permisos = array['corporate.manage','payments.create','corporate.credit_override'];
  d := public.credito_cobrar('22222222-2222-2222-2222-222222222222', 400, null, true, 'cliente de años');
  assert (d->>'excedido')::boolean, 'No se marcó como excedido';
  assert (d->>'saldo')::numeric = 520, 'El saldo autorizado quedó mal';

  -- Quién autorizó tiene que quedar escrito, no sólo que se autorizó.
  assert (select count(*) from public.corporate_credit_events
           where event_type = 'CHARGE_OVERRIDE' and authorized_by is not null) = 1,
    'La autorización no quedó en auditoría';
  update public.corsa_test_estado set permisos = array['corporate.manage','payments.create'];
end $$;

-- ── El abono libera cupo ─────────────────────────────────────
-- Sin esto el límite dejaría de ser un límite y sería un tope de por vida.
do $$
declare d jsonb;
begin
  d := public.credito_registrar_pago('22222222-2222-2222-2222-222222222222', 300);
  assert (d->>'saldo')::numeric = 220, 'El abono no bajó el saldo';
  assert (d->>'disponible')::numeric = 280, 'El abono no liberó cupo';

  -- El saldo de la cuenta y la suma de las cuotas tienen que coincidir, o el
  -- disponible mentiría.
  assert (select coalesce(sum(balance),0) from public.accounts_receivable
           where customer_id = '22222222-2222-2222-2222-222222222222')
         = (select current_balance from public.corporate_accounts),
    'El saldo de la cuenta no cuadra con las cuentas por cobrar';
end $$;

-- ── No se puede abonar más de lo que se debe ─────────────────
do $$
declare paso boolean := false;
begin
  begin perform public.credito_registrar_pago('22222222-2222-2222-2222-222222222222', 9999);
        paso := true;
  exception when others then null; end;
  assert not paso, 'Se aceptó un abono mayor que el saldo';
end $$;

-- ── Revocar no borra la deuda ────────────────────────────────
do $$
declare d jsonb;
begin
  perform public.credito_deshabilitar('22222222-2222-2222-2222-222222222222', 'prueba');
  d := public.credito_disponible('22222222-2222-2222-2222-222222222222');
  assert not (d->>'habilitado')::boolean, 'Siguió habilitado tras revocar';
  assert (select current_balance from public.corporate_accounts) = 220,
    'Revocar el crédito borró el saldo que se sigue debiendo';

  -- Y con el crédito revocado no se puede seguir cobrando.
  declare paso boolean := false;
  begin
    begin perform public.credito_cobrar('22222222-2222-2222-2222-222222222222', 10);
          paso := true;
    exception when others then null; end;
    assert not paso, 'Se cobró al crédito con la cuenta revocada';
  end;
end $$;

\echo '  Todas las pruebas de 0045 pasaron.'
