-- ═══════════════════════════════════════════════════════════════════════
-- 0080 — Beneficio corporativo desde caja y desde Clientes
--
-- En 0079 sólo el empleado (con el enlace de su empresa) o quien negocia
-- precios (corporate.manage) podía inscribir a alguien en un beneficio. El
-- cajero también tiene que poder: el empleado llega a caja sin haberse
-- registrado, y se lo da de alta ahí con su carnet.
--
-- benefit_enroll lo inscribe con el permiso de crear o editar clientes, que
-- es el que ya tiene quien da de alta en caja. Sólo inscribe: los precios y
-- las bajas siguen siendo de corporate.manage.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.benefit_enroll(
  p_customer_id uuid,
  p_benefit_id  uuid,
  p_carnet      text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid := public.get_my_organization_id();
  v_carnet   text := nullif(trim(coalesce(p_carnet, '')), '');
  v_carnet_n text := upper(regexp_replace(coalesce(p_carnet, ''), '[^A-Za-z0-9]', '', 'g'));
  v_id       uuid;
begin
  if v_org is null
     or not (public.has_permission('customers.create') or public.has_permission('customers.update')
             or public.has_permission('corporate.manage')) then
    raise exception 'No tenés permiso para inscribir clientes en un beneficio.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and organization_id = v_org and active) then
    raise exception 'El cliente no existe.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.corporate_benefits where id = p_benefit_id and organization_id = v_org and active) then
    raise exception 'El beneficio no existe o está pausado.' using errcode = '22023';
  end if;
  if v_carnet is null or char_length(v_carnet) > 30 or v_carnet_n = '' then
    raise exception 'Escribí el número de carnet de la empresa.' using errcode = '22023';
  end if;
  if exists (select 1 from public.corporate_benefit_members where customer_id = p_customer_id and active) then
    raise exception 'El cliente ya tiene un beneficio corporativo activo.' using errcode = '22023';
  end if;
  if exists (select 1 from public.corporate_benefit_members
              where benefit_id = p_benefit_id and active and normalized_carnet = v_carnet_n) then
    raise exception 'Ese número de carnet ya está registrado en el beneficio.' using errcode = '22023';
  end if;

  insert into public.corporate_benefit_members (organization_id, benefit_id, customer_id, carnet, source)
  values (v_org, p_benefit_id, p_customer_id, v_carnet, 'caja')
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.benefit_enroll(uuid, uuid, text) is
  'Inscribe un cliente en un beneficio corporativo desde caja o Clientes (0080). Pide permiso de crear/editar clientes.';

revoke all on function public.benefit_enroll(uuid, uuid, text) from public, anon;
grant execute on function public.benefit_enroll(uuid, uuid, text) to authenticated, service_role;
