-- ============================================================
-- Migration: 0077_bi_promociones_demanda_costos.sql
-- Description: Inteligencia de negocio, etapa 3: cupones y promociones,
--              concentración de la demanda, y la base para costos/margen.
--
--   CUPONES PREPAGADOS (voucher_batches, service_vouchers)
--   Un cupón vendido NO es un descuento: es plata cobrada por adelantado. Se
--   reconoce el día de la venta (order_kind voucher_sale) y su canje es un
--   lavado de $0. Por eso no hay «ticket promedio con cupón»: compararía
--   tickets de $0 contra tickets pagados.
--   · Vendidos / regalados: lotes creados en el período (sin los de una venta
--     anulada).
--   · Canjeados: cupones con redeemed_at en el período.
--   · Tasa de canje: de los cupones vendidos en el período, cuántos ya se
--     canjearon (no tienen vencimiento: la tasa crece con el tiempo).
--   · Pendiente de canje: valor de los cupones vendidos activos, hoy.
--
--   SEGURO DE LLUVIA (rain_policies): vendidos, cortesías y canjes.
--
--   DESCUENTOS: work_orders.discount_total. Hoy ningún flujo del POS aplica
--   descuentos ni registra cupones de descuento (coupons, coupon_redemptions,
--   work_order_discounts están vacías); no hay campaña ni origen.
--
--   DEMANDA: los ciclos del PLC (todos los carros, también los de Consumidor
--   Final) por día de la semana y hora local.
--
--   COSTOS (cost_items): sólo la estructura. Sin costos cargados no se
--   calcula ningún margen.
-- ============================================================


-- ─────────────────────────────────────────────
-- 1. Promociones
-- ─────────────────────────────────────────────
create or replace function public.bi_promociones(p_desde date, p_hasta date, p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ramas uuid[] := public.bi_alcance(p_branch_id);
  v_org   uuid   := public.get_my_organization_id();
begin
  if p_hasta < p_desde or p_hasta - p_desde > 3660 then
    raise exception 'Rango de fechas inválido' using errcode = '22023';
  end if;
  return (
    with lotes as (
      select vb.*
        from public.voucher_batches vb
        left join public.work_orders wo on wo.id = vb.work_order_id
       where vb.organization_id = v_org
         and vb.branch_id = any(v_ramas)
         and vb.created_at >= public.bi_inicio(p_desde)
         and vb.created_at <  public.bi_inicio(p_hasta + 1)
         and coalesce(wo.status, '') <> 'cancelled'
    ),
    cupones_del_periodo as (
      select sv.* from public.service_vouchers sv join lotes l on l.id = sv.batch_id
    ),
    canjes as (
      select sv.*
        from public.service_vouchers sv
        join public.work_orders wo on wo.id = sv.redeemed_work_order_id
       where sv.organization_id = v_org
         and wo.branch_id = any(v_ramas)
         and sv.redeemed_at >= public.bi_inicio(p_desde)
         and sv.redeemed_at <  public.bi_inicio(p_hasta + 1)
    ),
    seguros as (
      select rp.*
        from public.rain_policies rp
       where rp.organization_id = v_org
         and rp.branch_id = any(v_ramas)
         and rp.issued_at >= public.bi_inicio(p_desde)
         and rp.issued_at <  public.bi_inicio(p_hasta + 1)
         and rp.status <> 'cancelled'
    )
    select jsonb_build_object(
      'cupones', jsonb_build_object(
        'lotes_vendidos',     (select count(*) from lotes where not is_gift),
        'vendidos',           (select coalesce(sum(quantity), 0) from lotes where not is_gift),
        'regalados',          (select coalesce(sum(quantity), 0) from lotes where is_gift),
        'monto_vendido',      (select coalesce(sum(total), 0) from lotes where not is_gift),
        'vendidos_canjeados', (select count(*) from cupones_del_periodo where not is_gift and status = 'redeemed'),
        'vendidos_anulados',  (select count(*) from cupones_del_periodo where status = 'void'),
        'canjeados',          (select count(*) from canjes),
        'valor_canjeado',     (select coalesce(sum(unit_value), 0) from canjes),
        'pendiente_valor',    (select coalesce(sum(sv.unit_value), 0) from public.service_vouchers sv
                                 join public.voucher_batches vb on vb.id = sv.batch_id
                                where sv.organization_id = v_org and vb.branch_id = any(v_ramas)
                                  and sv.status = 'active' and not sv.is_gift),
        'pendiente_cantidad', (select count(*) from public.service_vouchers sv
                                 join public.voucher_batches vb on vb.id = sv.batch_id
                                where sv.organization_id = v_org and vb.branch_id = any(v_ramas)
                                  and sv.status = 'active')
      ),
      'seguros', jsonb_build_object(
        'vendidos',   (select count(*) from seguros where not courtesy),
        'monto',      (select coalesce(sum(price), 0) from seguros where not courtesy),
        'cortesias',  (select count(*) from seguros where courtesy),
        'canjeados',  (select count(*) from seguros where status = 'redeemed'),
        'canjeados_en_periodo', (select count(*) from public.rain_policies rp
                                  where rp.organization_id = v_org and rp.branch_id = any(v_ramas)
                                    and rp.redeemed_at >= public.bi_inicio(p_desde)
                                    and rp.redeemed_at <  public.bi_inicio(p_hasta + 1))
      ),
      'descuentos', (select coalesce(sum(wo.discount_total), 0)
                       from public.work_orders wo
                      where wo.organization_id = v_org and wo.branch_id = any(v_ramas)
                        and wo.status <> 'cancelled'
                        and wo.created_at >= public.bi_inicio(p_desde)
                        and wo.created_at <  public.bi_inicio(p_hasta + 1))
    )
  );
end;
$$;

revoke all on function public.bi_promociones(date, date, uuid) from public, anon;
grant execute on function public.bi_promociones(date, date, uuid) to authenticated;


-- ─────────────────────────────────────────────
-- 2. Demanda: lavados de máquina por día de la semana y hora local
-- ─────────────────────────────────────────────
create or replace function public.bi_demanda(p_desde date, p_hasta date)
returns table (dia_semana smallint, hora smallint, lavados integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.bi_alcance(null);
  if p_hasta < p_desde or p_hasta - p_desde > 3660 then
    raise exception 'Rango de fechas inválido' using errcode = '22023';
  end if;
  return query
  select extract(dow from (c.started_at at time zone 'America/El_Salvador'))::smallint,
         extract(hour from (c.started_at at time zone 'America/El_Salvador'))::smallint,
         count(*)::int
    from public.plc_wash_cycles c
   where c.organization_id = public.get_my_organization_id()
     and c.started_at >= public.bi_inicio(p_desde)
     and c.started_at <  public.bi_inicio(p_hasta + 1)
     and public.corsa_cuenta_como_lavado(c.status)
   group by 1, 2
   order by 1, 2;
end;
$$;

revoke all on function public.bi_demanda(date, date) from public, anon;
grant execute on function public.bi_demanda(date, date) to authenticated;


-- ─────────────────────────────────────────────
-- 3. Costos (segunda etapa: margen)
--
--    Cada fila es un costo con su base de reparto:
--      por_lavado        químico, agua o energía medida por ciclo;
--      por_mes           mano de obra fija, mantenimiento, alquiler: se
--                        reparte entre los lavados del mes;
--      por_hora_maquina  energía o desgaste por hora de máquina lavando.
--    service_code null = todos los servicios; machine_id null = todas las
--    máquinas. Vigencia por fechas para no reescribir la historia cuando un
--    costo cambie. Con esto, el margen de contribución por servicio será
--    ingreso promedio − Σ costos por lavado − parte de los mensuales.
-- ─────────────────────────────────────────────
create table if not exists public.cost_items (
  id              uuid          primary key default gen_random_uuid(),
  organization_id uuid          not null references public.organizations(id) on delete cascade,
  branch_id       uuid          references public.branches(id) on delete cascade,
  machine_id      text,
  service_code    text          check (service_code is null or service_code in ('PRO', 'ELITE', 'SIGNATURE')),
  category        text          not null check (category in ('quimicos', 'agua', 'electricidad', 'mano_obra', 'mantenimiento', 'otro')),
  basis           text          not null check (basis in ('por_lavado', 'por_mes', 'por_hora_maquina')),
  amount          numeric(12,4) not null check (amount >= 0),
  effective_from  date          not null,
  effective_to    date          check (effective_to is null or effective_to >= effective_from),
  description     text,
  created_at      timestamptz   not null default now(),
  created_by      uuid          default auth.uid() references public.profiles(id) on delete set null
);

comment on table public.cost_items is
  'Costos para el margen (0077, segunda etapa): químicos, agua, electricidad, mano de obra, mantenimiento; por lavado, por mes o por hora de máquina, con vigencia.';

create index if not exists idx_cost_items_org_vigencia on public.cost_items(organization_id, effective_from);

alter table public.cost_items enable row level security;

drop policy if exists "cost_items_select" on public.cost_items;
create policy "cost_items_select" on public.cost_items for select
  using (organization_id = public.get_my_organization_id() and public.has_permission('settings.manage'));
drop policy if exists "cost_items_manage" on public.cost_items;
create policy "cost_items_manage" on public.cost_items for all
  using (organization_id = public.get_my_organization_id() and public.has_permission('settings.manage'))
  with check (organization_id = public.get_my_organization_id() and public.has_permission('settings.manage'));

revoke all on public.cost_items from anon;
grant select, insert, update, delete on public.cost_items to authenticated;
