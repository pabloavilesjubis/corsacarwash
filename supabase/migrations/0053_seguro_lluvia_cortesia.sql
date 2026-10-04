-- ============================================================
-- Migration: 0053_seguro_lluvia_cortesia.sql
-- Description: Seguro de lluvia de CORTESÍA, desde el POS.
--
--   El cajero regala el seguro: misma obligación (48 horas, la misma placa,
--   un PRO sin costo si llueve), precio cero y marcada como cortesía para que
--   Seguros de lluvia la distinga de las vendidas.
--
--   Dos caminos, una sola función:
--     · con la orden que se está cobrando: el POS registra la venta y después
--       llama a esta función con la orden. No va dentro de pos_register_sale
--       porque no hay plata de por medio: si fallara después del cobro, nadie
--       pagó por algo que no existe, y se repite sola desde el botón;
--     · sin orden: el modal del POS la llama sin work_order_id.
--
--   No genera línea de venta ni factura: una cortesía no es un ingreso.
--
--   Permiso propio (rain.courtesy) para poder quitárselo a un rol sin tocar la
--   venta del seguro. Arranca en los mismos roles que rain.sell.
-- ============================================================

alter table public.rain_policies
  add column if not exists courtesy boolean not null default false;

comment on column public.rain_policies.courtesy is
  'Seguro regalado desde el POS (precio cero). Misma vigencia y mismo canje que uno vendido.';

-- Columna nueva al final: create or replace view sólo admite agregarlas ahí.
create or replace view public.v_rain_policies as
select
  p.id,
  p.organization_id,
  p.branch_id,
  b.name                                   as branch_name,
  p.work_order_id,
  wo.order_number,
  p.customer_id,
  coalesce(nullif(trim(c.trade_name), ''),
           nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
           c.legal_name,
           'Cliente')                      as customer_name,
  c.phone                                  as customer_phone,
  p.vehicle_id,
  p.plate,
  nullif(trim(concat_ws(' ', v.brand, v.model, v.color)), '') as vehicle_label,
  p.price,
  p.issued_at,
  p.valid_until,
  p.status,
  public.corsa_estado_poliza(p.status, p.valid_until) as estado,
  round(extract(epoch from (p.valid_until - now())) / 3600.0, 1) as horas_restantes,
  p.redeemed_at,
  p.redeemed_work_order_id,
  p.notes,
  (p.issued_at at time zone 'America/El_Salvador')::date  as issued_day,
  p.courtesy
from public.rain_policies p
left join public.branches   b  on b.id = p.branch_id
left join public.customers  c  on c.id = p.customer_id
left join public.vehicles   v  on v.id = p.vehicle_id
left join public.work_orders wo on wo.id = p.work_order_id;


insert into public.permissions (code, module, description) values
  ('rain.courtesy', 'rain', 'Dar seguro de lluvia de cortesía en caja')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select rp.role_id, c.id
from public.role_permissions rp
join public.permissions s on s.id = rp.permission_id and s.code = 'rain.sell'
cross join public.permissions c
where c.code = 'rain.courtesy'
on conflict do nothing;


create or replace function public.rain_policy_courtesy(
  p_branch_id     uuid,
  p_customer_id   uuid,
  p_vehicle_id    uuid,
  p_work_order_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid;
  v_plate   text;
  v_id      uuid;
  v_desde   timestamptz := now();
  v_hasta   timestamptz := now() + interval '48 hours';
  v_nombre  text;
  v_wo      record;
begin
  if not public.has_permission('rain.courtesy') then
    raise exception 'No autorizado: se requiere rain.courtesy' using errcode = '42501';
  end if;
  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;
  select organization_id into v_org from public.branches where id = p_branch_id;

  -- Las mismas reglas que el seguro vendido (0039): titular y placa.
  if p_customer_id is null then
    raise exception 'La cortesía necesita un cliente identificado: no se puede dar a Consumidor Final'
      using errcode = '22023';
  end if;
  select coalesce(nullif(trim(trade_name), ''),
                  nullif(trim(concat_ws(' ', first_name, last_name)), ''),
                  legal_name, 'Cliente')
    into v_nombre
    from public.customers where id = p_customer_id and organization_id = v_org;
  if v_nombre is null then
    raise exception 'El cliente no existe en esta organización' using errcode = '22023';
  end if;

  -- Como en el seguro vendido, el carro no tiene que estar a nombre del
  -- titular: en flotilla es de la empresa, no del cliente que maneja.
  select plate into v_plate from public.vehicles
   where id = p_vehicle_id and organization_id = v_org;
  if v_plate is null or trim(v_plate) = '' then
    raise exception 'El vehículo no tiene placa registrada: sin placa el seguro no se puede reclamar'
      using errcode = '22023';
  end if;

  if p_work_order_id is not null then
    select id, status into v_wo from public.work_orders
     where id = p_work_order_id and organization_id = v_org;
    if v_wo.id is null then
      raise exception 'No existe esa venta' using errcode = 'P0002';
    end if;
    if v_wo.status = 'cancelled' then
      raise exception 'La venta está anulada' using errcode = '22023';
    end if;
    -- Un reintento desde el POS no regala un segundo seguro con la misma venta.
    select id, issued_at, valid_until into v_id, v_desde, v_hasta
      from public.rain_policies
     where work_order_id = p_work_order_id and courtesy and status <> 'cancelled'
     limit 1;
  end if;

  if v_id is null then
    v_desde := now();
    v_hasta := now() + interval '48 hours';
    insert into public.rain_policies (
      organization_id, branch_id, work_order_id, customer_id, vehicle_id,
      plate, price, issued_at, valid_until, status, courtesy, notes, created_by
    ) values (
      v_org, p_branch_id, p_work_order_id, p_customer_id, p_vehicle_id,
      upper(trim(v_plate)), 0, v_desde, v_hasta, 'active', true, 'Cortesía', auth.uid()
    )
    returning id into v_id;
  end if;

  return jsonb_build_object(
    'id',            v_id,
    'plate',         upper(trim(v_plate)),
    'price',         0,
    'courtesy',      true,
    'customer_name', v_nombre,
    'issued_at',     v_desde,
    'valid_until',   v_hasta
  );
end;
$$;

comment on function public.rain_policy_courtesy(uuid, uuid, uuid, uuid) is
  'Seguro de lluvia de cortesía: 48 horas, precio cero. Con orden (agregada al cobro) o sin orden (modal del POS).';

revoke all on function public.rain_policy_courtesy(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.rain_policy_courtesy(uuid, uuid, uuid, uuid) to authenticated;
