-- ═══════════════════════════════════════════════════════════════════════
-- 0070 — El push del cierre de caja, con el día completo y bien ordenado
--
-- Al cerrar la caja se manda a los celulares con push un resumen del DÍA de
-- la sucursal (si hubo más de un turno, todos):
--   · ventas totales (contado + crédito);
--   · lavados vendidos (lavados cobrados, sin cortesías ni canjes) y el
--     ticket promedio = ventas totales / lavados vendidos;
--   · lavados dados = vendidos + los que salieron sin cobro (canje de seguro
--     de lluvia, canje de cupón, cortesía);
--   · efectivo: inicial, ingresos, egresos (retiros), remesas y lo que queda.
-- caja_resumen_dia arma las cifras; caja_notificar_dia las manda;
-- caja_enviar_resumen_dia deja reenviarlo a mano.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.caja_resumen_dia(p_branch_id uuid, p_fecha date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_branch   public.branches;
  v_ventas   numeric(12,2);
  v_credito  numeric(12,2);
  v_vendidos int;
  v_gratis   int;
  v_ses      jsonb;
  v_n        int;
  v_ini      numeric(12,2);
  v_ing      numeric(12,2);
  v_egr      numeric(12,2);
  v_rem      numeric(12,2);
  v_fin      numeric(12,2);
  v_abierta  boolean;
begin
  select * into v_branch from public.branches where id = p_branch_id;

  -- Ventas del día: todo lo cobrado o cargado a crédito, sin lo anulado.
  select coalesce(sum(wo.total), 0),
         coalesce(sum(wo.total) filter (where exists (
           select 1 from public.accounts_receivable ar where ar.work_order_id = wo.id)), 0)
    into v_ventas, v_credito
    from public.work_orders wo
   where wo.branch_id = p_branch_id
     and wo.status <> 'cancelled'
     and wo.order_kind in ('service', 'voucher_sale', 'addon_sale')
     and (wo.created_at at time zone 'America/El_Salvador')::date = p_fecha;

  -- Lavados: cada carro es una línea de PRO/ÉLITE/SIGNATURE. Cobrado (> $0)
  -- en una venta = vendido; en $0 (canje de seguro o de cupón, cortesía) =
  -- dado sin cobro.
  select count(*) filter (where wo.order_kind = 'service' and i.unit_price > 0),
         count(*) filter (where i.unit_price = 0)
    into v_vendidos, v_gratis
    from public.work_order_items i
    join public.work_orders wo on wo.id = i.work_order_id
    join public.services s on s.id = i.service_id and s.code in ('PRO', 'ELITE', 'SIGNATURE')
   where wo.branch_id = p_branch_id
     and wo.status <> 'cancelled'
     and wo.order_kind in ('service', 'voucher_redemption')
     and (wo.created_at at time zone 'America/El_Salvador')::date = p_fecha;

  -- La caja del día: todos los turnos que abrieron ese día, en orden.
  select coalesce(jsonb_agg(coalesce(s.resumen, public.caja_resumen_datos(s.id)) order by s.opened_at), '[]'::jsonb),
         count(*)
    into v_ses, v_n
    from public.cash_sessions s
    join public.cash_registers r on r.id = s.cash_register_id
   where r.branch_id = p_branch_id
     and (s.opened_at at time zone 'America/El_Salvador')::date = p_fecha;

  select (v_ses->0->>'efectivo_inicial')::numeric,
         coalesce(sum((x->>'ingresos_efectivo')::numeric), 0),
         coalesce(sum((x->>'egresos_efectivo')::numeric), 0),
         coalesce(sum((x->>'remesa')::numeric), 0)
    into v_ini, v_ing, v_egr, v_rem
    from jsonb_array_elements(v_ses) x;
  v_abierta := coalesce(v_ses->(v_n - 1)->>'estado', '') = 'open';
  v_fin := case when v_n = 0 then null
                when v_abierta then (v_ses->(v_n - 1)->>'efectivo_disponible')::numeric
                else (v_ses->(v_n - 1)->>'efectivo_final')::numeric end;

  return jsonb_build_object(
    'organization_id',  v_branch.organization_id,
    'branch_id',        p_branch_id,
    'sucursal',         v_branch.name,
    'fecha',            p_fecha,
    'ventas_totales',   v_ventas,
    'ventas_contado',   v_ventas - v_credito,
    'ventas_credito',   v_credito,
    'lavados_vendidos', v_vendidos,
    'lavados_sin_cobro', v_gratis,
    'lavados_dados',    v_vendidos + v_gratis,
    'ticket_promedio',  case when v_vendidos > 0 then round(v_ventas / v_vendidos, 2) else 0 end,
    'turnos',           v_n,
    'efectivo_inicial', v_ini,
    'ingresos_efectivo', v_ing,
    'egresos_efectivo', v_egr,
    'remesas',          v_rem,
    'efectivo_final',   v_fin,
    'caja_abierta',     v_abierta
  );
end;
$$;
revoke all on function public.caja_resumen_dia(uuid, date) from public, anon, authenticated;
grant execute on function public.caja_resumen_dia(uuid, date) to service_role;


create or replace function public.caja_notificar_dia(p_branch_id uuid, p_fecha date, p_clave text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r jsonb := public.caja_resumen_dia(p_branch_id, p_fecha);
  m text := 'FM999,999,990.00';
  v_cuerpo text;
begin
  v_cuerpo := concat_ws(E'\n',
    format('%s · %s', r->>'sucursal', to_char(p_fecha, 'DD/MM/YYYY')),
    format('Ventas totales: $%s (contado $%s · crédito $%s)',
      to_char((r->>'ventas_totales')::numeric, m), to_char((r->>'ventas_contado')::numeric, m),
      to_char((r->>'ventas_credito')::numeric, m)),
    format('Lavados vendidos: %s · ticket promedio $%s', r->>'lavados_vendidos', to_char((r->>'ticket_promedio')::numeric, m)),
    format('Lavados dados: %s (%s vendidos + %s cortesía/seguro/cupón)',
      r->>'lavados_dados', r->>'lavados_vendidos', r->>'lavados_sin_cobro'),
    format('Efectivo inicial: $%s', to_char(coalesce((r->>'efectivo_inicial')::numeric, 0), m)),
    format('Ingresos en efectivo: $%s', to_char((r->>'ingresos_efectivo')::numeric, m)),
    format('Egresos de caja: $%s', to_char((r->>'egresos_efectivo')::numeric, m)),
    format('Remesas: $%s', to_char((r->>'remesas')::numeric, m)),
    format('%s: $%s', case when (r->>'caja_abierta')::boolean then 'En caja ahora' else 'Monto final en caja' end,
      to_char(coalesce((r->>'efectivo_final')::numeric, 0), m)));

  return public.corsa_emitir_notificacion(
    p_org       => (r->>'organization_id')::uuid,
    p_tipo      => 'CASH_CLOSE',
    p_clave     => p_clave,
    p_titulo    => format('💵 Cierre de caja · %s', r->>'sucursal'),
    p_cuerpo    => v_cuerpo,
    p_deep_link => '/cierres-caja',
    p_metadata  => jsonb_build_object('resumen_dia', r),
    p_severidad => 'INFO'
  );
end;
$$;
revoke all on function public.caja_notificar_dia(uuid, date, text) from public, anon, authenticated;
grant execute on function public.caja_notificar_dia(uuid, date, text) to service_role;


-- Reenviar a mano el resumen de un día (desde Cierres de caja).
create or replace function public.caja_enviar_resumen_dia(p_branch_id uuid, p_fecha date)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not (public.has_permission('cash.close') or public.has_permission('cash.override')) then
    raise exception 'No autorizado: se requiere cash.close' using errcode = '42501';
  end if;
  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;
  return public.caja_notificar_dia(p_branch_id, p_fecha,
    'cash-day-' || p_branch_id::text || '-' || p_fecha::text || '-' || extract(epoch from now())::bigint::text);
end;
$$;
revoke all on function public.caja_enviar_resumen_dia(uuid, date) from public, anon;
grant execute on function public.caja_enviar_resumen_dia(uuid, date) to authenticated;


create or replace function public.caja_cerrar(p_session_id uuid, p_remesa numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_s          public.cash_sessions;
  v_disponible numeric(12,2);
  v_resumen    jsonb;
begin
  v_s := public.caja_de_sesion(p_session_id, 'cash.close');
  select * into v_s from public.cash_sessions where id = p_session_id for update;
  if v_s.status <> 'open' then
    raise exception 'La caja ya está cerrada' using errcode = '22023';
  end if;
  if p_remesa is null or p_remesa < 0 then
    raise exception 'La remesa no puede ser negativa' using errcode = '22023';
  end if;

  v_disponible := (public.caja_resumen_datos(p_session_id)->>'efectivo_disponible')::numeric;
  if round(p_remesa, 2) > v_disponible then
    raise exception 'La remesa no puede ser mayor que el efectivo en caja (%)', to_char(v_disponible, 'FM999,999,990.00')
      using errcode = '22023';
  end if;

  if p_remesa > 0 then
    insert into public.cash_movements (cash_session_id, type, amount, reference_type, description, created_by)
    values (p_session_id, 'deposit', -round(p_remesa, 2), 'remesa', 'Remesa de efectivo', auth.uid());
  end if;

  update public.cash_sessions
     set closed_at = now(), closed_by = auth.uid(), status = 'closed', remesa = round(p_remesa, 2)
   where id = p_session_id;

  v_resumen := public.caja_resumen_datos(p_session_id);
  update public.cash_sessions
     set resumen       = v_resumen,
         expected_cash = (v_resumen->>'efectivo_final')::numeric,
         counted_cash  = (v_resumen->>'efectivo_final')::numeric,
         difference    = 0
   where id = p_session_id;

  -- El push resume el DÍA de la sucursal (todos sus turnos), no sólo éste
  -- (0070). Si falla, el cierre queda igual.
  begin
    perform public.caja_notificar_dia(
      (v_resumen->>'branch_id')::uuid,
      (v_s.opened_at at time zone 'America/El_Salvador')::date,
      'cash-close-' || p_session_id::text);
  exception when others then
    raise warning 'No se pudo emitir la notificación del cierre %: %', p_session_id, sqlerrm;
  end;

  return v_resumen;
end;
$$;
revoke all on function public.caja_cerrar(uuid, numeric) from public, anon;
grant execute on function public.caja_cerrar(uuid, numeric) to authenticated;
