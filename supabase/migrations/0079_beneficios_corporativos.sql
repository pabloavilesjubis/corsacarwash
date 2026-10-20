-- ═══════════════════════════════════════════════════════════════════════
-- 0079 — Beneficios corporativos
--
-- Una empresa aliada da a sus empleados, como beneficio, una tarifa especial
-- en CORSA. No es una flotilla: los carros son de cada empleado, y cada uno
-- paga su lavado (contado o como sea), sólo que al precio del beneficio.
--
--   corporate_benefits                 la empresa aliada, su código para el
--                                      enlace de registro y el aspirado
--   corporate_benefit_service_prices   PRO/ÉLITE/SIGNATURE, único o por tamaño
--                                      (el mismo modelo que flotillas, 0050)
--   corporate_benefit_members          qué cliente es empleado de qué empresa,
--                                      con su número de carnet
--
-- El empleado se registra solo con el enlace de su empresa
-- (/beneficio?c=<código>) y queda activo de inmediato, para todos sus carros.
-- CORSA lo puede desactivar. El POS, al elegir al cliente, cobra los precios
-- del beneficio (después del tarifario especial del cliente, 0071, y antes
-- que los del grupo empresarial, 0054).
--
-- El uso se cuenta con v_lavados (0074): los carros lavados por cada miembro
-- desde que se registró. No se toca la venta.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. Tablas
-- ─────────────────────────────────────────────
create table if not exists public.corporate_benefits (
  id               uuid          primary key default gen_random_uuid(),
  organization_id  uuid          not null references public.organizations(id) on delete cascade,
  name             text          not null check (char_length(trim(name)) between 1 and 120),
  -- Lo que va en el enlace. Difícil de adivinar: quien lo tiene se registra
  -- como empleado de esa empresa.
  code             text          not null check (code ~ '^[A-Z0-9]{8}$'),
  contact_name     text          check (contact_name is null or char_length(contact_name) <= 120),
  contact_email    text          check (contact_email is null or char_length(contact_email) <= 100),
  active           boolean       not null default true,
  aspirado_enabled boolean       not null default false,
  aspirado_price   numeric(10,2) check (aspirado_price is null or aspirado_price >= 0),
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),
  updated_by       uuid          default auth.uid() references public.profiles(id) on delete set null,
  unique (code)
);

comment on table public.corporate_benefits is
  'Beneficio corporativo (0079): empresa aliada cuyos empleados pagan una tarifa especial. code va en /beneficio?c=.';

create table if not exists public.corporate_benefit_service_prices (
  benefit_id    uuid          not null references public.corporate_benefits(id) on delete cascade,
  service_code  text          not null check (service_code in ('PRO', 'ELITE', 'SIGNATURE')),
  per_size      boolean       not null default false,
  price         numeric(10,2),
  price_s       numeric(10,2),
  price_m       numeric(10,2),
  price_l       numeric(10,2),
  updated_at    timestamptz   not null default now(),
  updated_by    uuid          default auth.uid() references public.profiles(id) on delete set null,
  primary key (benefit_id, service_code),
  constraint corporate_benefit_service_prices_complete check (
    case when per_size
      then price_s is not null and price_m is not null and price_l is not null
      else price is not null
    end
  ),
  constraint corporate_benefit_service_prices_non_negative check (
    coalesce(price, 0) >= 0 and coalesce(price_s, 0) >= 0
    and coalesce(price_m, 0) >= 0 and coalesce(price_l, 0) >= 0
  )
);

comment on table public.corporate_benefit_service_prices is
  'Precio del beneficio corporativo por servicio (PRO/ELITE/SIGNATURE), único o por tamaño (0079).';

create table if not exists public.corporate_benefit_members (
  id               uuid          primary key default gen_random_uuid(),
  organization_id  uuid          not null references public.organizations(id) on delete cascade,
  benefit_id       uuid          not null references public.corporate_benefits(id) on delete cascade,
  customer_id      uuid          not null references public.customers(id) on delete cascade,
  -- Tal como lo escribió el empleado; la comparación usa la versión normalizada.
  carnet           text          not null check (char_length(trim(carnet)) between 1 and 30),
  normalized_carnet text         generated always as (upper(regexp_replace(carnet, '[^A-Za-z0-9]', '', 'g'))) stored,
  active           boolean       not null default true,
  -- Desde cuándo goza del beneficio: el uso se cuenta a partir de acá.
  enrolled_at      timestamptz   not null default now(),
  deactivated_at   timestamptz,
  source           text          not null default 'web' check (source in ('web', 'caja')),
  created_at       timestamptz   not null default now()
);

comment on table public.corporate_benefit_members is
  'Empleado (cliente) inscrito en un beneficio corporativo, con su carnet (0079). Un cliente, un beneficio activo.';

-- Un carnet, un empleado activo por empresa; un cliente, un beneficio activo.
create unique index if not exists corporate_benefit_members_carnet_activo
  on public.corporate_benefit_members (benefit_id, normalized_carnet) where active;
create unique index if not exists corporate_benefit_members_cliente_activo
  on public.corporate_benefit_members (customer_id) where active;
create index if not exists idx_corporate_benefit_members_benefit
  on public.corporate_benefit_members (benefit_id);

-- ─────────────────────────────────────────────
-- 2. Permisos: leer, cualquiera de la organización (el POS); editar, quien
--    negocia precios (corporate.manage), como el tarifario de 0071.
-- ─────────────────────────────────────────────
alter table public.corporate_benefits               enable row level security;
alter table public.corporate_benefit_service_prices enable row level security;
alter table public.corporate_benefit_members        enable row level security;

drop policy if exists "corporate_benefits_select" on public.corporate_benefits;
create policy "corporate_benefits_select" on public.corporate_benefits for select
  using (organization_id = public.get_my_organization_id());

drop policy if exists "corporate_benefits_manage" on public.corporate_benefits;
create policy "corporate_benefits_manage" on public.corporate_benefits for all
  using (organization_id = public.get_my_organization_id() and public.has_permission('corporate.manage'))
  with check (organization_id = public.get_my_organization_id() and public.has_permission('corporate.manage'));

drop policy if exists "corporate_benefit_service_prices_select" on public.corporate_benefit_service_prices;
create policy "corporate_benefit_service_prices_select" on public.corporate_benefit_service_prices for select
  using (benefit_id in (select b.id from public.corporate_benefits b
                         where b.organization_id = public.get_my_organization_id()));

drop policy if exists "corporate_benefit_service_prices_manage" on public.corporate_benefit_service_prices;
create policy "corporate_benefit_service_prices_manage" on public.corporate_benefit_service_prices for all
  using (benefit_id in (select b.id from public.corporate_benefits b
                         where b.organization_id = public.get_my_organization_id())
         and public.has_permission('corporate.manage'))
  with check (benefit_id in (select b.id from public.corporate_benefits b
                              where b.organization_id = public.get_my_organization_id())
              and public.has_permission('corporate.manage'));

drop policy if exists "corporate_benefit_members_select" on public.corporate_benefit_members;
create policy "corporate_benefit_members_select" on public.corporate_benefit_members for select
  using (organization_id = public.get_my_organization_id());

-- El cliente y el beneficio tienen que ser de la organización.
drop policy if exists "corporate_benefit_members_manage" on public.corporate_benefit_members;
create policy "corporate_benefit_members_manage" on public.corporate_benefit_members for all
  using (organization_id = public.get_my_organization_id() and public.has_permission('corporate.manage'))
  with check (organization_id = public.get_my_organization_id()
              and public.has_permission('corporate.manage')
              and exists (select 1 from public.customers c
                           where c.id = customer_id and c.organization_id = public.get_my_organization_id())
              and exists (select 1 from public.corporate_benefits b
                           where b.id = benefit_id and b.organization_id = public.get_my_organization_id()));

revoke all on public.corporate_benefits, public.corporate_benefit_service_prices, public.corporate_benefit_members from anon;
grant select, insert, update, delete
  on public.corporate_benefits, public.corporate_benefit_service_prices, public.corporate_benefit_members
  to authenticated;
grant all
  on public.corporate_benefits, public.corporate_benefit_service_prices, public.corporate_benefit_members
  to service_role;

-- ─────────────────────────────────────────────
-- 3. Formulario público: el nombre de la empresa para el encabezado
-- ─────────────────────────────────────────────
create or replace function public.public_benefit_info(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('nombre', b.name)
    from public.corporate_benefits b
   where b.code = upper(trim(coalesce(p_code, ''))) and b.active
   limit 1;
$$;

comment on function public.public_benefit_info(text) is
  'Formulario público de beneficio corporativo (0079): sólo el nombre de la empresa del código, o null.';

revoke all on function public.public_benefit_info(text) from public;
grant execute on function public.public_benefit_info(text) to anon, authenticated;

-- ─────────────────────────────────────────────
-- 4. Registro público del empleado
--
-- Como public_customer_signup (0055/0056) para una persona, más el carnet.
-- Si el DUI ya es de un cliente, no se toca su ficha: sólo se lo inscribe en
-- el beneficio (los carros nuevos se agregan en caja).
-- ─────────────────────────────────────────────
create or replace function public.public_benefit_signup(
  p_code  text,
  p_datos jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_benefit    public.corporate_benefits%rowtype;
  v_org        uuid;
  v_nombre     text := nullif(trim(p_datos->>'nombre'), '');
  v_apellido   text := nullif(trim(p_datos->>'apellido'), '');
  v_carnet     text := nullif(trim(p_datos->>'carnet'), '');
  v_carnet_n   text;
  v_dui        text := nullif(regexp_replace(coalesce(p_datos->>'dui', ''), '[^0-9]', '', 'g'), '');
  v_tel        text := nullif(regexp_replace(coalesce(p_datos->>'telefono', ''), '[^0-9]', '', 'g'), '');
  v_pais       text := coalesce(nullif(regexp_replace(coalesce(p_datos->>'codigo_pais', ''), '[^0-9]', '', 'g'), ''), '503');
  v_telefono   text;
  v_correo     text := nullif(lower(trim(p_datos->>'correo')), '');
  v_vehiculos  jsonb := coalesce(p_datos->'vehiculos', '[]'::jsonb);
  v_customer   uuid;
  v_existente  boolean := false;
  v_v          jsonb;
  v_placa      text;
  v_tamano     text;
  v_tipo_veh   uuid;
  v_creados    text[] := '{}';
  v_omitidos   text[] := '{}';
begin
  -- ── Empresa del enlace ──
  select * into v_benefit
    from public.corporate_benefits
   where code = upper(trim(coalesce(p_code, ''))) and active
   limit 1;
  if v_benefit.id is null then
    raise exception 'Este enlace de beneficio no es válido o ya no está vigente. Pedile uno nuevo a tu empresa.' using errcode = '22023';
  end if;
  v_org := v_benefit.organization_id;

  -- ── Freno contra abuso ──
  if (select count(*) from public.corporate_benefit_members
       where benefit_id = v_benefit.id and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'Hay muchos registros en este momento. Intentá de nuevo en unos minutos.' using errcode = '54000';
  end if;

  -- ── Validaciones ──
  if coalesce((p_datos->>'acepta')::boolean, false) is not true then
    raise exception 'Tenés que aceptar el uso de tus datos para registrarte.' using errcode = '22023';
  end if;
  if v_nombre is null or v_apellido is null then
    raise exception 'Escribí tu nombre y tu apellido.' using errcode = '22023';
  end if;
  if greatest(char_length(v_nombre), char_length(v_apellido)) > 60 then
    raise exception 'Uno de los nombres es demasiado largo.' using errcode = '22023';
  end if;
  v_carnet_n := upper(regexp_replace(coalesce(v_carnet, ''), '[^A-Za-z0-9]', '', 'g'));
  if v_carnet is null or char_length(v_carnet) > 30 or v_carnet_n = '' then
    raise exception 'Escribí tu número de carnet de la empresa.' using errcode = '22023';
  end if;
  if v_pais !~ '^[0-9]{1,4}$' then
    raise exception 'Revisá el código de país del teléfono.' using errcode = '22023';
  end if;
  if v_pais = '503' then
    if v_tel is null or v_tel !~ '^[0-9]{8}$' then
      raise exception 'El teléfono tiene que tener 8 dígitos.' using errcode = '22023';
    end if;
    v_telefono := v_tel;
  else
    if v_tel is null or char_length(v_tel) < 4 or char_length(v_pais || v_tel) > 15 then
      raise exception 'Revisá el número de teléfono.' using errcode = '22023';
    end if;
    v_telefono := '+' || v_pais || ' ' || v_tel;
  end if;
  if v_correo is not null and (v_correo !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_correo) > 100) then
    raise exception 'El correo no es válido.' using errcode = '22023';
  end if;
  if v_dui is not null and v_dui !~ '^[0-9]{9}$' then
    raise exception 'El DUI tiene que tener 9 dígitos.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_vehiculos) <> 'array' or jsonb_array_length(v_vehiculos) = 0 then
    raise exception 'Agregá al menos un vehículo.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_vehiculos) > 10 then
    raise exception 'Podés registrar hasta 10 vehículos; el resto, en caja.' using errcode = '22023';
  end if;
  for v_v in select * from jsonb_array_elements(v_vehiculos) loop
    v_placa := upper(regexp_replace(coalesce(v_v->>'placa', ''), '[^A-Za-z0-9]', '', 'g'));
    if v_placa !~ '^[A-Z0-9]{3,10}$' then
      raise exception 'Revisá la placa «%»: tiene que tener entre 3 y 10 letras o números.', coalesce(v_v->>'placa', '')
        using errcode = '22023';
    end if;
    if coalesce(v_v->>'tamano', '') not in ('S', 'M', 'L') then
      raise exception 'Elegí el tamaño del vehículo %.', v_placa using errcode = '22023';
    end if;
  end loop;

  -- ── Carnet ya usado en esta empresa ──
  if exists (select 1 from public.corporate_benefit_members
              where benefit_id = v_benefit.id and active and normalized_carnet = v_carnet_n) then
    raise exception 'Ese número de carnet ya está registrado en el beneficio. Si es tuyo, avisale al cajero.' using errcode = '22023';
  end if;

  -- ── ¿Ya es cliente? Se lo inscribe sin tocar su ficha ──
  if v_dui is not null then
    select id into v_customer from public.customers
     where organization_id = v_org and active and normalized_dui = v_dui
     limit 1;
  end if;

  if v_customer is not null then
    v_existente := true;
    if exists (select 1 from public.corporate_benefit_members where customer_id = v_customer and active) then
      return jsonb_build_object('ok', true, 'existente', true, 'ya_inscrito', true);
    end if;
  else
    insert into public.customers (
      organization_id, customer_type, first_name, last_name,
      dui, phone, email, fiscal_document_type, fiscal_doc_type,
      source, notes, active
    ) values (
      v_org, 'individual', v_nombre, v_apellido,
      case when v_dui is not null then substr(v_dui, 1, 8) || '-' || substr(v_dui, 9, 1) end,
      v_telefono, v_correo, 'fcf',
      case when v_dui is not null then '13' end,
      'web', 'Registro por beneficio corporativo: ' || v_benefit.name, true
    )
    returning id into v_customer;

    for v_v in select * from jsonb_array_elements(v_vehiculos) loop
      v_placa := upper(regexp_replace(v_v->>'placa', '[^A-Za-z0-9]', '', 'g'));
      v_tamano := v_v->>'tamano';

      if exists (select 1 from public.vehicles
                  where organization_id = v_org and active and normalized_plate = v_placa)
         or v_placa = any(v_creados) then
        v_omitidos := v_omitidos || v_placa;
        continue;
      end if;

      select id into v_tipo_veh from public.vehicle_types
       where organization_id = v_org and active
         and size_category = case v_tamano when 'S' then 'small' when 'M' then 'medium' else 'large' end
       order by sort_order limit 1;
      if v_tipo_veh is null then
        raise exception 'Falta configurar los tipos de vehículo de la sucursal.' using errcode = '22023';
      end if;

      insert into public.vehicles (organization_id, customer_id, vehicle_type_id, plate, brand, model, color, active)
      values (v_org, v_customer, v_tipo_veh, v_placa,
              nullif(left(trim(coalesce(v_v->>'marca', '')), 40), ''),
              nullif(left(trim(coalesce(v_v->>'modelo', '')), 40), ''),
              nullif(left(trim(coalesce(v_v->>'color', '')), 30), ''),
              true);
      v_creados := v_creados || v_placa;
    end loop;
  end if;

  insert into public.corporate_benefit_members (organization_id, benefit_id, customer_id, carnet, source)
  values (v_org, v_benefit.id, v_customer, v_carnet, 'web');

  return jsonb_build_object('ok', true, 'existente', v_existente, 'empresa', v_benefit.name,
                            'vehiculos', to_jsonb(v_creados), 'omitidos', to_jsonb(v_omitidos));
end;
$$;

comment on function public.public_benefit_signup(text, jsonb) is
  'Registro público del empleado de una empresa con beneficio corporativo (0079): crea cliente y carros (o usa el existente por DUI) y lo inscribe con su carnet.';

revoke all on function public.public_benefit_signup(text, jsonb) from public;
grant execute on function public.public_benefit_signup(text, jsonb) to anon, authenticated;
