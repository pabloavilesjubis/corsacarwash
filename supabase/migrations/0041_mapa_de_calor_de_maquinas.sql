-- ============================================================
-- Migration: 0041_mapa_de_calor_de_maquinas.sql
-- Description: El mapa de calor deja de mirar la caja y mira las máquinas.
--
--   El tablero dibujaba la ocupación con v_sales_heatmap, que cuenta órdenes
--   de venta. Eso responde «cuándo cobramos», que no es lo mismo que «cuándo
--   trabajan las máquinas»: un lavado de flotilla se factura a fin de mes, un
--   canje de cupón no genera cobro, y una venta se registra cuando el cajero
--   llega a marcarla —a veces media hora después de que el carro entró—.
--
--   Para decidir turnos y mantenimiento lo que sirve es cuándo corrió la
--   máquina, y eso lo sabe el PLC al segundo. Esta vista cuenta lavados reales
--   por día de la semana y hora, con el mismo criterio de conteo que el resto
--   del módulo (corsa_cuenta_como_lavado), y en hora de El Salvador.
--
--   LA SUCURSAL SALE DEL GATEWAY: los ciclos no tienen sucursal, la tiene el
--   gateway que los reportó. Puede venir en null si nadie se la asignó todavía,
--   y en ese caso la vista la deja en null en lugar de inventarla — el tablero
--   sabe qué hacer con eso.
-- ============================================================

drop view if exists public.v_plc_heatmap cascade;
create view public.v_plc_heatmap as
select
  c.organization_id,
  g.branch_id,
  c.machine_id,
  -- dow de Postgres: 0 = domingo. El tablero reordena para arrancar en lunes.
  extract(dow  from c.started_at at time zone 'America/El_Salvador')::int as day_of_week,
  to_char(c.started_at at time zone 'America/El_Salvador', 'Day')         as day_name,
  extract(hour from c.started_at at time zone 'America/El_Salvador')::int as hour_of_day,
  count(*)                                             as washes,
  count(*) filter (where c.service_type = 'PRO')       as pro,
  count(*) filter (where c.service_type = 'ELITE')     as elite,
  count(*) filter (where c.service_type = 'SIGNATURE') as signature,
  round(avg(c.duration_seconds))::int                  as avg_seconds
from public.plc_wash_cycles c
left join public.plc_gateways g
       on g.organization_id = c.organization_id
      and g.gateway_id = c.gateway_id
where public.corsa_cuenta_como_lavado(c.status)
group by 1, 2, 3, 4, 5, 6;

comment on view public.v_plc_heatmap is
  'Lavados por día de la semana y hora, en hora de El Salvador. Mide uso de las máquinas, no facturación.';

grant select on public.v_plc_heatmap to authenticated, service_role;
