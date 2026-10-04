-- ═══════════════════════════════════════════════════════════════════════
-- 0054 — Grupos empresariales
--
-- Empresas y personas «hermanas»: varios clientes, cada uno con sus carros,
-- que se facturan entre sí según el día («hoy este carro lo paga la otra
-- empresa»). Un grupo une a esos clientes:
--
--   · en Clientes, cada cliente pertenece a un grupo o a ninguno
--     (customers.business_group_id);
--   · en el POS, con un cliente del grupo en caja, se pueden elegir las placas
--     de cualquier miembro y facturar a cualquier miembro;
--   · el grupo tiene precios negociados por servicio, con el mismo modelo que
--     las flotillas (0050): PRO/ÉLITE/SIGNATURE, único o por tamaño, más el
--     aspirado a precio único. Un servicio que el grupo no negoció se cobra a
--     tarifa de lista.
--
-- Permisos: crear un grupo y unir clientes es parte de editar clientes
-- (customers.create / customers.update). Los precios negociados, como en las
-- flotillas, piden corporate.manage.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.business_groups (
  id               uuid          primary key default gen_random_uuid(),
  organization_id  uuid          not null references public.organizations(id) on delete cascade,
  name             text          not null check (length(trim(name)) > 0),
  notes            text,
  -- El aspirado negociado del grupo; null/false = tarifa de lista.
  aspirado_enabled boolean       not null default false,
  aspirado_price   numeric(10,2) check (aspirado_price is null or aspirado_price >= 0),
  active           boolean       not null default true,
  created_at       timestamptz   not null default now(),
  created_by       uuid,
  updated_at       timestamptz   not null default now()
);

comment on table public.business_groups is
  'Grupo empresarial: clientes hermanos que en el POS comparten placas, se facturan entre sí y tienen precios negociados (0054).';

-- Dos grupos con el mismo nombre serían indistinguibles en el selector.
create unique index if not exists business_groups_nombre_uidx
  on public.business_groups (organization_id, lower(trim(name)));

alter table public.customers
  add column if not exists business_group_id uuid references public.business_groups(id) on delete set null;

comment on column public.customers.business_group_id is
  'Grupo empresarial al que pertenece el cliente (uno o ninguno). 0054.';

create index if not exists idx_customers_business_group
  on public.customers (business_group_id) where business_group_id is not null;


create table if not exists public.business_group_prices (
  group_id      uuid          not null references public.business_groups(id) on delete cascade,
  service_code  text          not null check (service_code in ('PRO', 'ELITE', 'SIGNATURE')),
  per_size      boolean       not null default false,
  price         numeric(10,2),
  price_s       numeric(10,2),
  price_m       numeric(10,2),
  price_l       numeric(10,2),
  updated_at    timestamptz   not null default now(),
  updated_by    uuid          references public.profiles(id) on delete set null,
  primary key (group_id, service_code),
  constraint business_group_prices_complete check (
    case when per_size
      then price_s is not null and price_m is not null and price_l is not null
      else price is not null
    end
  ),
  constraint business_group_prices_non_negative check (
    coalesce(price, 0) >= 0 and coalesce(price_s, 0) >= 0
    and coalesce(price_m, 0) >= 0 and coalesce(price_l, 0) >= 0
  )
);

comment on table public.business_group_prices is
  'Precio negociado por grupo empresarial y servicio, igual que fleet_service_prices (0050).';


-- ── RLS ──
alter table public.business_groups enable row level security;
alter table public.business_group_prices enable row level security;

drop policy if exists "business_groups_select" on public.business_groups;
create policy "business_groups_select" on public.business_groups for select
  using (organization_id = public.get_my_organization_id());

drop policy if exists "business_groups_insert" on public.business_groups;
create policy "business_groups_insert" on public.business_groups for insert
  with check (organization_id = public.get_my_organization_id()
              and (public.has_permission('customers.create') or public.has_permission('customers.update')));

-- Renombrar o desactivar es editar clientes. El aspirado negociado se cambia
-- con la misma pantalla que los precios, y ahí se pide corporate.manage (abajo).
drop policy if exists "business_groups_update" on public.business_groups;
create policy "business_groups_update" on public.business_groups for update
  using (organization_id = public.get_my_organization_id() and public.has_permission('customers.update'))
  with check (organization_id = public.get_my_organization_id() and public.has_permission('customers.update'));

drop policy if exists "business_group_prices_select" on public.business_group_prices;
create policy "business_group_prices_select" on public.business_group_prices for select
  using (group_id in (select g.id from public.business_groups g
                       where g.organization_id = public.get_my_organization_id()));

drop policy if exists "business_group_prices_manage" on public.business_group_prices;
create policy "business_group_prices_manage" on public.business_group_prices for all
  using (group_id in (select g.id from public.business_groups g
                       where g.organization_id = public.get_my_organization_id())
         and public.has_permission('corporate.manage'))
  with check (group_id in (select g.id from public.business_groups g
                            where g.organization_id = public.get_my_organization_id())
              and public.has_permission('corporate.manage'));

-- El aspirado negociado vive en business_groups, cuya política de update es la
-- de clientes. Sin esto, quien edita clientes podría cambiar un precio
-- negociado sin corporate.manage.
create or replace function public.business_groups_guard_aspirado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (case when tg_op = 'INSERT'
           then new.aspirado_enabled or new.aspirado_price is not null
           else new.aspirado_enabled is distinct from old.aspirado_enabled
                or new.aspirado_price is distinct from old.aspirado_price
      end)
     and not public.has_permission('corporate.manage') then
    raise exception 'No autorizado: los precios negociados del grupo requieren corporate.manage'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists business_groups_guard_aspirado on public.business_groups;
create trigger business_groups_guard_aspirado
  before insert or update on public.business_groups
  for each row execute function public.business_groups_guard_aspirado();

-- Un cliente sólo puede unirse a un grupo de su misma organización.
create or replace function public.customers_check_business_group()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.business_group_id is not null and not exists (
    select 1 from public.business_groups g
     where g.id = new.business_group_id and g.organization_id = new.organization_id
  ) then
    raise exception 'El grupo empresarial no es de esta organización' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists customers_check_business_group on public.customers;
create trigger customers_check_business_group
  before insert or update of business_group_id on public.customers
  for each row execute function public.customers_check_business_group();

grant select, insert, update on public.business_groups to authenticated;
grant select, insert, update, delete on public.business_group_prices to authenticated;
