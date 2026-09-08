-- ============================================================
-- Migration: 0009_services.sql
-- Description: Service catalog, categories, pricing engine,
--   and tax rates. Price history is immutable.
-- ============================================================

-- ─────────────────────────────────────────────
-- SERVICE CATEGORIES
-- ─────────────────────────────────────────────
create table public.service_categories (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  name            text    not null,
  sort_order      int     not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table public.service_categories enable row level security;
create index idx_service_categories_org on public.service_categories(organization_id);

create policy "service_categories_select"
  on public.service_categories for select
  using (organization_id = public.get_my_organization_id());

create policy "service_categories_manage"
  on public.service_categories for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- SERVICES
-- ─────────────────────────────────────────────
create table public.services (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete restrict,
  category_id         uuid        references public.service_categories(id) on delete set null,
  code                text        not null,
  name                text        not null,
  description         text,
  estimated_minutes   int         check (estimated_minutes > 0),
  taxable             boolean     not null default true,
  active              boolean     not null default true,
  sort_order          int         not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint services_org_code_unique unique (organization_id, code)
);

comment on table public.services is 'Service catalog. Prices live in service_prices. Never hardcode prices in services.';

create trigger services_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

alter table public.services enable row level security;
create index idx_services_organization_id on public.services(organization_id);
create index idx_services_category_id on public.services(category_id);

create policy "services_select"
  on public.services for select
  using (organization_id = public.get_my_organization_id());

create policy "services_manage"
  on public.services for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- TAX RATES
-- ─────────────────────────────────────────────
create table public.tax_rates (
  id                uuid    primary key default gen_random_uuid(),
  organization_id   uuid    not null references public.organizations(id) on delete restrict,
  name              text    not null,          -- 'IVA'
  rate              numeric(5,4) not null,     -- 0.1300 = 13%
  applicable_from   date    not null,
  applicable_to     date,                      -- null = currently active
  active            boolean not null default true
);

comment on table public.tax_rates is 'Tax rates by date range. El Salvador IVA = 13%. Never hardcode in application code.';

alter table public.tax_rates enable row level security;

create policy "tax_rates_select"
  on public.tax_rates for select
  using (organization_id = public.get_my_organization_id());

create policy "tax_rates_manage"
  on public.tax_rates for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- SERVICE PRICES
-- Supports:
--   - Base org-level price (branch_id IS NULL)
--   - Branch override (branch_id IS NOT NULL)
--   - Price history (effective_from/to date ranges)
-- ─────────────────────────────────────────────
create table public.service_prices (
  id              uuid          primary key default gen_random_uuid(),
  organization_id uuid          not null references public.organizations(id) on delete restrict,
  branch_id       uuid          references public.branches(id) on delete cascade,  -- null = org-wide
  service_id      uuid          not null references public.services(id) on delete restrict,
  vehicle_type_id uuid          not null references public.vehicle_types(id) on delete restrict,
  price           numeric(10,2) not null check (price >= 0),
  effective_from  date          not null default current_date,
  effective_to    date,                    -- null = currently active
  active          boolean       not null default true,
  created_at      timestamptz   not null default now(),
  created_by      uuid          references public.profiles(id) on delete set null
);

comment on table public.service_prices is 'Immutable price history. To change a price, deactivate old and create new. Orders snapshot price at time of sale.';
comment on column public.service_prices.branch_id is 'NULL = base organization price. Non-null = branch override (takes precedence).';

alter table public.service_prices enable row level security;
create index idx_service_prices_org on public.service_prices(organization_id);
create index idx_service_prices_service on public.service_prices(service_id);
create index idx_service_prices_vehicle_type on public.service_prices(vehicle_type_id);
create index idx_service_prices_active on public.service_prices(organization_id, active, effective_from, effective_to);

create policy "service_prices_select"
  on public.service_prices for select
  using (organization_id = public.get_my_organization_id());

create policy "service_prices_manage"
  on public.service_prices for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- RPC: Get effective price for a service
-- Priority: branch override > org base price
-- Returns NULL if no price configured
-- ─────────────────────────────────────────────
create or replace function public.get_service_price(
  p_service_id      uuid,
  p_vehicle_type_id uuid,
  p_branch_id       uuid,
  p_date            date default current_date
)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  -- Branch-specific price takes priority over org-wide
  select coalesce(
    -- 1) Branch override
    (select price from public.service_prices
      where service_id = p_service_id
        and vehicle_type_id = p_vehicle_type_id
        and branch_id = p_branch_id
        and active = true
        and effective_from <= p_date
        and (effective_to is null or effective_to >= p_date)
      order by effective_from desc
      limit 1),
    -- 2) Org-wide price
    (select price from public.service_prices
      where service_id = p_service_id
        and vehicle_type_id = p_vehicle_type_id
        and branch_id is null
        and active = true
        and effective_from <= p_date
        and (effective_to is null or effective_to >= p_date)
      order by effective_from desc
      limit 1)
  );
$$;

comment on function public.get_service_price(uuid, uuid, uuid, date) is
  'Returns the effective price for a service+vehicle_type+branch combination on a given date. Branch overrides org price.';

-- ─────────────────────────────────────────────
-- SEED: TAX RATES
-- ─────────────────────────────────────────────
insert into public.tax_rates (organization_id, name, rate, applicable_from, active)
values (
  '00000000-0000-0000-0000-000000000001',
  'IVA',
  0.1300,  -- 13% IVA El Salvador
  '2024-01-01',
  true
);

-- ─────────────────────────────────────────────
-- SEED: SERVICE CATEGORIES
-- ─────────────────────────────────────────────
insert into public.service_categories (id, organization_id, name, sort_order) values
  ('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0000-000000000001', 'Lavado', 1),
  ('00000000-0000-0000-0003-000000000002', '00000000-0000-0000-0000-000000000001', 'Detailing', 2),
  ('00000000-0000-0000-0003-000000000003', '00000000-0000-0000-0000-000000000001', 'Servicios Especiales', 3);

-- ─────────────────────────────────────────────
-- SEED: SERVICES
-- ─────────────────────────────────────────────
insert into public.services (id, organization_id, category_id, code, name, description, estimated_minutes, taxable, sort_order) values
  -- Lavado
  ('00000000-0000-0000-0004-000000000001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000001',
   'LAV-BASIC',  'Lavado Básico',    'Lavado exterior, secado y limpieza de vidrios',              20, true, 1),
  ('00000000-0000-0000-0004-000000000002', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000001',
   'LAV-COMP',   'Lavado Completo',  'Lavado exterior, aspirado, tablero, vidrios, aromatizante', 35, true, 2),
  ('00000000-0000-0000-0004-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000001',
   'LAV-PREM',   'Premium + Encerado','Lavado completo más encerado manual',                       50, true, 3),
  ('00000000-0000-0000-0004-000000000004', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000001',
   'ASPIRADO',   'Aspirado Profundo', 'Aspirado detallado de interior, alfombras y asientos',      30, true, 4),
  -- Detailing
  ('00000000-0000-0000-0004-000000000005', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000002',
   'ENCERADO',   'Encerado Manual',   'Aplicación de cera protectora manual',                      40, true, 1),
  ('00000000-0000-0000-0004-000000000006', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000002',
   'PULIDO-FAR', 'Pulido de Faros',   'Restauración y pulido de faros opacos',                     45, true, 2),
  ('00000000-0000-0000-0004-000000000007', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000002',
   'VESTIDURAS', 'Tratamiento Vestiduras','Limpieza profunda de cuero, vinil o tela',               60, true, 3),
  ('00000000-0000-0000-0004-000000000008', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000002',
   'DETAILING',  'Detailing Completo','Servicio completo de detailing exterior e interior',        120, true, 4),
  -- Servicios Especiales
  ('00000000-0000-0000-0004-000000000009', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000003',
   'LAV-MOTOR',  'Lavado de Motor',   'Limpieza y desengrase de compartimiento de motor',           40, true, 1),
  ('00000000-0000-0000-0004-000000000010', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0003-000000000003',
   'DESINFEC',   'Desinfección',      'Ozonización y desinfección de interior',                     30, true, 2);

-- ─────────────────────────────────────────────
-- SEED: SERVICE PRICES (base org prices for all vehicle types)
-- Prices in USD
-- ─────────────────────────────────────────────
-- Helper: insert price for all vehicle types at once using a cross join
insert into public.service_prices (organization_id, service_id, vehicle_type_id, price, effective_from)
select
  '00000000-0000-0000-0000-000000000001' as organization_id,
  s.id as service_id,
  vt.id as vehicle_type_id,
  case
    -- LAV-BASIC
    when s.code = 'LAV-BASIC' and vt.code in ('SEDAN','HATCHBACK')  then 5.00
    when s.code = 'LAV-BASIC' and vt.code in ('SUV','PICKUP','VAN') then 6.00
    when s.code = 'LAV-BASIC' and vt.code in ('MICROBUS','COMMERCIAL') then 8.00
    when s.code = 'LAV-BASIC' and vt.code = 'MOTORCYCLE'            then 4.00
    when s.code = 'LAV-BASIC' and vt.code = 'OTHER'                 then 6.00
    -- LAV-COMP
    when s.code = 'LAV-COMP' and vt.code in ('SEDAN','HATCHBACK')   then 10.00
    when s.code = 'LAV-COMP' and vt.code in ('SUV','PICKUP','VAN')  then 12.00
    when s.code = 'LAV-COMP' and vt.code in ('MICROBUS','COMMERCIAL') then 15.00
    when s.code = 'LAV-COMP' and vt.code = 'MOTORCYCLE'             then 7.00
    when s.code = 'LAV-COMP' and vt.code = 'OTHER'                  then 12.00
    -- LAV-PREM
    when s.code = 'LAV-PREM' and vt.code in ('SEDAN','HATCHBACK')   then 18.00
    when s.code = 'LAV-PREM' and vt.code in ('SUV','PICKUP','VAN')  then 22.00
    when s.code = 'LAV-PREM' and vt.code in ('MICROBUS','COMMERCIAL') then 28.00
    when s.code = 'LAV-PREM' and vt.code = 'MOTORCYCLE'             then 12.00
    when s.code = 'LAV-PREM' and vt.code = 'OTHER'                  then 22.00
    -- ASPIRADO
    when s.code = 'ASPIRADO' and vt.code in ('SEDAN','HATCHBACK')   then 8.00
    when s.code = 'ASPIRADO' and vt.code in ('SUV','PICKUP','VAN')  then 10.00
    when s.code = 'ASPIRADO' and vt.code in ('MICROBUS','COMMERCIAL') then 14.00
    when s.code = 'ASPIRADO' and vt.code = 'MOTORCYCLE'             then 5.00
    when s.code = 'ASPIRADO' and vt.code = 'OTHER'                  then 10.00
    -- ENCERADO
    when s.code = 'ENCERADO' and vt.code in ('SEDAN','HATCHBACK')   then 15.00
    when s.code = 'ENCERADO' and vt.code in ('SUV','PICKUP','VAN')  then 20.00
    when s.code = 'ENCERADO' and vt.code in ('MICROBUS','COMMERCIAL') then 25.00
    when s.code = 'ENCERADO' and vt.code = 'MOTORCYCLE'             then 10.00
    when s.code = 'ENCERADO' and vt.code = 'OTHER'                  then 20.00
    -- PULIDO-FAR (fixed price regardless of size)
    when s.code = 'PULIDO-FAR' then 15.00
    -- VESTIDURAS
    when s.code = 'VESTIDURAS' and vt.code in ('SEDAN','HATCHBACK') then 25.00
    when s.code = 'VESTIDURAS' and vt.code in ('SUV','PICKUP','VAN') then 30.00
    when s.code = 'VESTIDURAS' and vt.code in ('MICROBUS','COMMERCIAL') then 40.00
    when s.code = 'VESTIDURAS' and vt.code = 'MOTORCYCLE'            then 15.00
    when s.code = 'VESTIDURAS' and vt.code = 'OTHER'                 then 30.00
    -- DETAILING
    when s.code = 'DETAILING' and vt.code in ('SEDAN','HATCHBACK')  then 80.00
    when s.code = 'DETAILING' and vt.code in ('SUV','PICKUP','VAN') then 100.00
    when s.code = 'DETAILING' and vt.code in ('MICROBUS','COMMERCIAL') then 130.00
    when s.code = 'DETAILING' and vt.code = 'MOTORCYCLE'             then 50.00
    when s.code = 'DETAILING' and vt.code = 'OTHER'                  then 100.00
    -- LAV-MOTOR
    when s.code = 'LAV-MOTOR' and vt.code in ('SEDAN','HATCHBACK')  then 15.00
    when s.code = 'LAV-MOTOR' and vt.code in ('SUV','PICKUP','VAN') then 20.00
    when s.code = 'LAV-MOTOR' and vt.code in ('MICROBUS','COMMERCIAL') then 25.00
    when s.code = 'LAV-MOTOR' and vt.code = 'MOTORCYCLE'             then 10.00
    when s.code = 'LAV-MOTOR' and vt.code = 'OTHER'                  then 20.00
    -- DESINFEC
    when s.code = 'DESINFEC' and vt.code in ('SEDAN','HATCHBACK')   then 12.00
    when s.code = 'DESINFEC' and vt.code in ('SUV','PICKUP','VAN')  then 15.00
    when s.code = 'DESINFEC' and vt.code in ('MICROBUS','COMMERCIAL') then 20.00
    when s.code = 'DESINFEC' and vt.code = 'MOTORCYCLE'              then 8.00
    when s.code = 'DESINFEC' and vt.code = 'OTHER'                   then 15.00
    else 10.00  -- fallback (should not occur)
  end as price,
  '2026-01-01'::date as effective_from
from public.services s
cross join public.vehicle_types vt
where s.organization_id = '00000000-0000-0000-0000-000000000001'
  and vt.organization_id = '00000000-0000-0000-0000-000000000001';
