-- ============================================================
-- Migration: 0072_metricas_de_cliente.sql
-- Description: Lavados, visitas y acumulado por cliente.
--
--   La ficha del cliente y el POS leen v_customer_metrics (0025), pero esa
--   vista nunca llegó a producción: por eso las fichas decían «Sin visitas» y
--   la lista de Clientes no mostraba la última visita aunque el POS sí guarda
--   el cliente en cada orden (work_orders.customer_id).
--
--   QUÉ ES UN LAVADO
--   Una línea de la orden cuyo servicio tiene programa de máquina (PRO, ÉLITE,
--   SIGNATURE). Así una orden de varios carros (0057) cuenta un lavado por
--   carro, y el aspirado, el seguro o un adicional suelto no cuentan. Se
--   cuentan todos, al contado o al crédito; sólo quedan fuera las órdenes
--   anuladas. Una venta a Consumidor Final no tiene cliente al que sumarle.
--
--   SECURITY INVOKER
--   La vista de 0025 corría con los permisos de su dueño y mostraba datos de
--   cualquier organización. Ésta respeta el RLS de customers y work_orders:
--   cada usuario ve las métricas de lo que ya puede ver.
-- ============================================================

drop view if exists public.v_customer_metrics;

create view public.v_customer_metrics
with (security_invoker = true) as
with ordenes as (
  select wo.customer_id,
         count(*)                as total_orders,
         sum(wo.total)           as lifetime_value,
         max(wo.created_at)      as last_visit_at,
         min(wo.created_at)      as first_visit_at
    from public.work_orders wo
   where wo.customer_id is not null
     and wo.status <> 'cancelled'
   group by wo.customer_id
),
lavados as (
  select wo.customer_id,
         sum(i.quantity)::int    as total_washes
    from public.work_order_items i
    join public.work_orders wo on wo.id = i.work_order_id
    join public.services s     on s.id = i.service_id
   where wo.customer_id is not null
     and wo.status <> 'cancelled'
     and s.machine_program is not null
   group by wo.customer_id
)
select
  c.id                                     as customer_id,
  c.organization_id,
  c.customer_type,
  coalesce(nullif(trim(c.trade_name), ''),
           nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
           c.legal_name,
           'Cliente')                      as display_name,
  c.phone,
  c.email,
  coalesce(o.total_orders, 0)::int         as total_orders,
  coalesce(l.total_washes, 0)              as total_washes,
  coalesce(o.lifetime_value, 0)            as lifetime_value,
  o.last_visit_at,
  o.first_visit_at,
  -- En días calendario de El Salvador: «hoy» es hoy en la caja, no en UTC.
  ((now() at time zone 'America/El_Salvador')::date
     - (o.last_visit_at at time zone 'America/El_Salvador')::date) as days_since_last_visit,
  -- El POS (pos.service) la pide; todavía no hay segmentación en la base.
  null::text                               as segment
from public.customers c
left join ordenes o on o.customer_id = c.id
left join lavados l on l.customer_id = c.id
where c.active = true;

comment on view public.v_customer_metrics is
  'Por cliente: órdenes, lavados (líneas con programa de máquina, contado y crédito), acumulado y última visita. Sin anuladas. security_invoker (0072).';

revoke all on public.v_customer_metrics from anon;
grant select on public.v_customer_metrics to authenticated, service_role;
