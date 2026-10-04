-- ═══════════════════════════════════════════════════════════════════════
-- 0067 — Vehículos del grupo empresarial, sin cliente todavía
--
-- En una carga masiva a un grupo, un carro cuya fila no dice de qué empresa
-- es no se le asigna a ninguna a ciegas: queda del GRUPO, sin cliente.
--   · vehicles.customer_id deja de ser obligatorio; vehicles.business_group_id
--     dice de qué grupo es. Uno de los dos tiene que estar;
--   · en el POS, con cualquier cliente del grupo en caja, esos carros se ven
--     junto con las placas de los demás miembros;
--   · desde Grupos empresariales se le asigna después el cliente
--     (grupo_asignar_vehiculo), que queda en el historial de dueños.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.vehicles alter column customer_id drop not null;
alter table public.vehicles
  add column if not exists business_group_id uuid references public.business_groups(id) on delete restrict;
comment on column public.vehicles.business_group_id is
  'Grupo empresarial dueño del carro cuando todavía no tiene cliente asignado (0067).';

alter table public.vehicles drop constraint if exists vehicles_tiene_dueno;
alter table public.vehicles
  add constraint vehicles_tiene_dueno check (customer_id is not null or business_group_id is not null);

create index if not exists idx_vehicles_grupo_sin_cliente
  on public.vehicles (business_group_id) where customer_id is null;


-- Asigna un carro del grupo a uno de sus clientes. Sólo carros del grupo, y
-- sólo a clientes del mismo grupo.
create or replace function public.grupo_asignar_vehiculo(p_vehicle_id uuid, p_customer_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_veh public.vehicles;
  v_grupo_cliente uuid;
begin
  if not (public.has_permission('vehicles.update') or public.has_permission('customers.update')) then
    raise exception 'No autorizado: se requiere vehicles.update' using errcode = '42501';
  end if;

  select * into v_veh from public.vehicles
   where id = p_vehicle_id and organization_id = public.get_my_organization_id()
   for update;
  if v_veh.id is null then raise exception 'No existe ese vehículo' using errcode = 'P0002'; end if;
  if v_veh.business_group_id is null then
    raise exception 'Ese vehículo no es de un grupo empresarial' using errcode = '22023';
  end if;

  select business_group_id into v_grupo_cliente from public.customers
   where id = p_customer_id and organization_id = public.get_my_organization_id();
  if v_grupo_cliente is distinct from v_veh.business_group_id then
    raise exception 'El cliente no es de ese grupo empresarial' using errcode = '22023';
  end if;

  update public.vehicles
     set customer_id = p_customer_id, updated_by = auth.uid(), updated_at = now()
   where id = p_vehicle_id;

  update public.vehicle_ownership_history set valid_to = now()
   where vehicle_id = p_vehicle_id and valid_to is null;
  insert into public.vehicle_ownership_history (vehicle_id, customer_id, reason, transferred_by)
  values (p_vehicle_id, p_customer_id, 'Asignado desde el grupo empresarial', auth.uid());
end;
$$;
revoke all on function public.grupo_asignar_vehiculo(uuid, uuid) from public, anon;
grant execute on function public.grupo_asignar_vehiculo(uuid, uuid) to authenticated;
