-- ============================================================
-- Pruebas de 0043_motor_fiscal_dte.sql
--
-- Se corren contra un Postgres descartable, no contra producción:
--
--   docker run -d --rm --name corsa-fiscal-test -e POSTGRES_PASSWORD=test \
--     -e POSTGRES_DB=corsa_test -p 55433:5432 postgres:16-alpine
--   psql ... -f supabase/tests/0043_prereq.sql
--   psql ... -f supabase/migrations/0043_motor_fiscal_dte.sql
--   psql ... -f supabase/tests/0043_motor_fiscal_dte.test.sql
--
-- La prueba de concurrencia va aparte porque necesita pgbench:
--
--   pgbench -U postgres -d corsa_test -c 50 -j 8 -t 1 -n -f 0043_concurrencia.sql
--
-- Cada bloque falla ruidosamente con `assert`. Un `select` que "se ve bien"
-- no es una prueba: la numeración fiscal no admite revisión a ojo.
-- ============================================================

\set ORG '11111111-1111-1111-1111-111111111111'
\set BR  '22222222-2222-2222-2222-222222222222'

-- ── Punto de partida conocido ────────────────────────────────
delete from public.fiscal_audit_events;
delete from public.fiscal_documents;
update public.fiscal_correlatives set last_minted = 125, reserved = '{}', released = '{}';

-- ── Idempotencia: la misma llave no crea un segundo documento ─
do $$
declare a bigint; b bigint; n int;
begin
  select correlative into a from public.fiscal_open_document(
    'T:idem', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01');
  select correlative into b from public.fiscal_open_document(
    'T:idem', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01');
  select count(*) into n from public.fiscal_documents where idempotency_key = 'T:idem';
  assert a = b,  format('El doble clic dio correlativos distintos: %s y %s', a, b);
  assert n = 1,  format('El doble clic creó %s documentos', n);
end $$;

-- ── Sin huecos: un rechazado vuelve a la bolsa y se reutiliza ─
-- Es el escenario exacto donde ERP-PAAJ deja hueco: se devuelve un número que
-- NO es el más alto en vuelo.
do $$
declare a bigint; b bigint; c bigint;
begin
  delete from public.fiscal_audit_events; delete from public.fiscal_documents;
  update public.fiscal_correlatives set last_minted = 125, reserved = '{}', released = '{}';

  select correlative into a from public.fiscal_open_document('T:A','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','01');
  select correlative into b from public.fiscal_open_document('T:B','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','01');
  perform public.fiscal_mark_rejected((select id from public.fiscal_documents where idempotency_key='T:A'), '{}'::jsonb, 'prueba');
  perform public.fiscal_mark_accepted((select id from public.fiscal_documents where idempotency_key='T:B'), 'SELLO', '{}'::jsonb);
  select correlative into c from public.fiscal_open_document('T:C','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','01');

  assert a = 126 and b = 127, format('Reserva inesperada: a=%s b=%s', a, b);
  assert c = a, format('Quedó hueco: se rechazó el %s y la siguiente venta tomó el %s', a, c);
end $$;

-- ── Un reintento NO devuelve el correlativo ──────────────────
-- Hacienda pudo haber recibido el documento sin que nos llegara la respuesta.
-- Liberar el número permitiría que otra venta lo usara y terminaríamos con dos
-- documentos con el mismo numeroControl ante el MH.
do $$
declare d bigint; e bigint; libres bigint[];
begin
  delete from public.fiscal_audit_events; delete from public.fiscal_documents;
  update public.fiscal_correlatives set last_minted = 200, reserved = '{}', released = '{}';

  select correlative into d from public.fiscal_open_document('T:D','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','01');
  perform public.fiscal_mark_retry((select id from public.fiscal_documents where idempotency_key='T:D'), 'timeout');
  select released into libres from public.fiscal_correlatives where dte_type = '01';
  select correlative into e from public.fiscal_open_document('T:E','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','01');

  assert coalesce(array_length(libres,1),0) = 0, 'El reintento devolvió el correlativo a la bolsa';
  assert e = d + 1, format('Tras el reintento la siguiente venta tomó %s en vez de %s', e, d+1);
  assert (select attempt_count from public.fiscal_documents where idempotency_key='T:D') = 1,
    'No se contó el intento';
end $$;

-- ── Sembrar sube, nunca baja ─────────────────────────────────
do $$
declare antes bigint; despues bigint;
begin
  select last_minted into antes from public.fiscal_correlatives where dte_type='01';
  select last_minted into despues from public.fiscal_seed_correlative(
    '11111111-1111-1111-1111-111111111111','01','M001','P001', 1, 'prueba');
  assert despues = antes,
    format('Sembrar en 1 hizo retroceder la secuencia de %s a %s', antes, despues);
end $$;

-- ── Sin sembrar no se emite ──────────────────────────────────
-- Arrancar en 1 cuando el contribuyente ya emitió miles duplicaría numeración
-- ante Hacienda, y eso no se arregla después.
do $$
declare fallo boolean := false;
begin
  insert into public.fiscal_correlatives (organization_id, dte_type, establishment_code, pos_code)
  values ('11111111-1111-1111-1111-111111111111','03','M001','P001')
  on conflict do nothing;
  begin
    perform public.fiscal_open_document('T:F','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','03');
  exception when others then fallo := true;
  end;
  assert fallo, 'Se pudo emitir contra una secuencia sin sembrar';
end $$;

-- ── El numeroControl sigue siendo único entre los vivos ───────
-- Reutilizar los rechazados NO puede abrir la puerta a que dos documentos
-- VIVOS compartan numeroControl: eso sí sería un duplicado real ante el MH.
do $$
declare choque boolean := false; id_rechazado uuid;
begin
  delete from public.fiscal_audit_events; delete from public.fiscal_documents;
  update public.fiscal_correlatives set last_minted = 300, reserved = '{}', released = '{}';

  perform public.fiscal_open_document('T:U1','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','01');
  select id into id_rechazado from public.fiscal_documents where idempotency_key = 'T:U1';
  perform public.fiscal_mark_rejected(id_rechazado, '{}'::jsonb, 'prueba');

  -- La siguiente venta reutiliza el número del rechazado.
  perform public.fiscal_open_document('T:U2','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','01');
  assert (select correlative from public.fiscal_documents where idempotency_key='T:U2') = 301,
    'No se reutilizó el correlativo rechazado';

  -- Revivir el rechazado dejaría DOS vivos con el mismo numeroControl.
  begin
    update public.fiscal_documents set status = 'ACCEPTED' where id = id_rechazado;
  exception when unique_violation then choque := true;
  end;
  assert choque, 'Dos documentos vivos pudieron compartir numeroControl';
end $$;

\echo '  Todas las pruebas de 0043 pasaron.'
