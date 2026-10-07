-- ============================================================
-- Migration: 0074_lavado_por_carro.sql
-- Description: El lavado es la unidad: un carro lavado, con su vehículo.
--
--   VISITA = CARRO LAVADO
--   Un CCF o un FCF puede llevar varios carros (0057). Para contar lavados,
--   visitas o recurrencia por cliente se cuenta la LÍNEA de lavado, no la
--   orden ni la factura.
--
--   EL VEHÍCULO DE CADA LÍNEA
--   work_orders.vehicle_id guarda un solo carro (el primero en una orden de
--   varios); las demás placas sólo quedaban en el texto de la línea
--   («ÉLITE L · P68 B12», «Seguro de lluvia · Placa P09 8F4»). Ahora cada
--   línea lleva su vehicle_id:
--     · si la descripción trae placa, el vehículo de esa placa en la
--       organización (vehicles.normalized_plate: mayúsculas, sin espacios);
--       si la placa no existe, null —nunca el primer carro de la orden, que
--       sería otro—;
--     · si no trae placa (venta de un carro), el vehículo de la orden.
--   Lo pone un trigger al insertar, así lo llevan pos_register_sale,
--   pos_register_sale_multi y cualquier camino futuro sin tocar el cobro. Las
--   líneas existentes se completan con la misma regla.
--
--   v_lavados
--   Una fila por carro lavado (servicio con programa de máquina: PRO, ÉLITE,
--   SIGNATURE), sin órdenes anuladas, contado o crédito, con o sin cobro (un
--   canje de cupón o de seguro es un lavado de $0). Es la definición que usan
--   Inteligencia de negocio y el Resumen del día.
-- ============================================================

alter table public.work_order_items
  add column if not exists vehicle_id uuid references public.vehicles(id) on delete set null;

create index if not exists idx_work_order_items_vehicle
  on public.work_order_items(vehicle_id) where vehicle_id is not null;

comment on column public.work_order_items.vehicle_id is
  'Carro de esta línea (0074). En una orden de varios carros cada línea tiene el suyo; work_orders.vehicle_id es sólo el primero.';

create or replace function public.corsa_vehiculo_de_linea(p_work_order_id uuid, p_descripcion text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_vehiculo uuid;
  v_placa    text;
begin
  select organization_id, vehicle_id into v_org, v_vehiculo
    from public.work_orders where id = p_work_order_id;

  -- «… · P68 B12» o «… · Placa P09 8F4»: lo que va después del punto medio.
  v_placa := substring(coalesce(p_descripcion, '') from '·\s*(?:[Pp]laca\s+)?(.+)$');
  v_placa := upper(regexp_replace(coalesce(v_placa, ''), '[^A-Za-z0-9]', '', 'g'));

  if v_placa <> '' then
    return (select v.id from public.vehicles v
             where v.organization_id = v_org and v.normalized_plate = v_placa
             order by v.active desc, v.created_at
             limit 1);
  end if;
  return v_vehiculo;
end;
$$;

revoke all on function public.corsa_vehiculo_de_linea(uuid, text) from public, anon, authenticated;

create or replace function public.work_order_items_set_vehicle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.vehicle_id is null then
    new.vehicle_id := public.corsa_vehiculo_de_linea(new.work_order_id, new.description_snapshot);
  end if;
  return new;
end;
$$;

drop trigger if exists work_order_items_set_vehicle on public.work_order_items;
create trigger work_order_items_set_vehicle
  before insert on public.work_order_items
  for each row execute function public.work_order_items_set_vehicle();

-- Las líneas que ya existen, con la misma regla.
update public.work_order_items
   set vehicle_id = public.corsa_vehiculo_de_linea(work_order_id, description_snapshot)
 where vehicle_id is null;


-- ─────────────────────────────────────────────
-- v_lavados: un carro lavado por fila
-- ─────────────────────────────────────────────
drop view if exists public.v_lavados;

create view public.v_lavados
with (security_invoker = true) as
select
  i.id                                                   as item_id,
  wo.id                                                  as work_order_id,
  wo.organization_id,
  wo.branch_id,
  wo.created_at,
  (wo.created_at at time zone 'America/El_Salvador')::date as fecha,
  wo.customer_id,
  i.vehicle_id,
  upper(s.code)                                          as servicio,
  i.quantity                                             as lavados,
  i.total                                                as monto,
  wo.order_kind,
  wo.facturacion_diferida,
  -- Canje de cupón o de seguro: el carro se lavó, pero no ingresó plata hoy.
  (i.total = 0)                                          as sin_cobro
from public.work_order_items i
join public.work_orders wo on wo.id = i.work_order_id
join public.services s     on s.id = i.service_id
where wo.status <> 'cancelled'
  and s.machine_program is not null;

comment on view public.v_lavados is
  'Un carro lavado por fila (PRO/ÉLITE/SIGNATURE), sin anuladas, contado o crédito, con su vehículo (0074). security_invoker.';

revoke all on public.v_lavados from anon;
grant select on public.v_lavados to authenticated, service_role;
