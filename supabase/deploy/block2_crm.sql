-- ============================================================
-- Migration: 0006_rls_foundation.sql
-- Description: Row Level Security helpers and base policies.
--
--   RLS Strategy:
--   1. All business tables have RLS enabled
--   2. Helper functions derive context from JWT claims
--   3. Three layers of access control:
--      a) Organization isolation (organization_id match)
--      b) Branch access (user_branch_access or org-wide role)
--      c) Permission check (specific permission code)
--   4. Super Admin role bypasses all restrictions
--   5. Service role (server-side) bypasses RLS via Supabase default
--
--   SECURITY NOTE: Never expose service_role key in frontend.
--   All financial mutations go through RPC functions (security definer).
-- ============================================================

-- ─────────────────────────────────────────────
-- HELPER: Get current user's organization_id
-- Reads from profiles table (source of truth)
-- ─────────────────────────────────────────────
create or replace function public.get_my_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.profiles
  where id = auth.uid()
  limit 1;
$$;

comment on function public.get_my_organization_id() is
  'Returns the organization_id of the currently authenticated user. Used in RLS policies.';

-- ─────────────────────────────────────────────
-- HELPER: Check if user has a specific permission
-- Traverses: user → roles → role_permissions → permissions
-- ─────────────────────────────────────────────
create or replace function public.has_permission(permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p       on p.id = rp.permission_id
    join public.roles r             on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and p.code = permission_code
      and r.active = true
  );
$$;

comment on function public.has_permission(text) is
  'Returns true if the current user has the given permission code via any of their active roles.';

-- ─────────────────────────────────────────────
-- HELPER: Check if user is Super Admin
-- ─────────────────────────────────────────────
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and r.name = 'Super Admin'
      and r.is_system = true
      and r.active = true
  );
$$;

-- ─────────────────────────────────────────────
-- HELPER: Check if user has org-wide role
-- (Admin or above — can see all branches)
-- ─────────────────────────────────────────────
create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and r.name in ('Super Admin', 'Administrador')
      and r.is_system = true
      and r.active = true
  );
$$;

-- ─────────────────────────────────────────────
-- HELPER: Get list of branches user can access
-- ─────────────────────────────────────────────
create or replace function public.get_accessible_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  -- Org admins can access all branches in their org
  select b.id
  from public.branches b
  where b.organization_id = public.get_my_organization_id()
    and public.is_org_admin()

  union

  -- Other users: only their explicitly granted branches
  select uba.branch_id
  from public.user_branch_access uba
  where uba.user_id = auth.uid()
    and uba.can_read = true
    and not public.is_org_admin();
$$;

-- ─────────────────────────────────────────────
-- RLS POLICIES — organizations
-- ─────────────────────────────────────────────
-- Users can only see their own organization
create policy "organizations_select_own"
  on public.organizations for select
  using (id = public.get_my_organization_id());

-- Only Super Admin can update organization settings
create policy "organizations_update_super_admin"
  on public.organizations for update
  using (public.is_super_admin());

-- ─────────────────────────────────────────────
-- RLS POLICIES — branches
-- ─────────────────────────────────────────────
create policy "branches_select_accessible"
  on public.branches for select
  using (
    organization_id = public.get_my_organization_id()
    and id in (select public.get_accessible_branch_ids())
  );

create policy "branches_manage_admin"
  on public.branches for all
  using (
    organization_id = public.get_my_organization_id()
    and public.is_org_admin()
  );

-- ─────────────────────────────────────────────
-- RLS POLICIES — profiles
-- ─────────────────────────────────────────────

-- Admins can read all profiles in their org
create policy "profiles_select_org"
  on public.profiles for select
  using (
    organization_id = public.get_my_organization_id()
    and (
      id = auth.uid()                    -- own profile always visible
      or public.has_permission('users.manage')
      or public.is_org_admin()
    )
  );

-- Only admins can insert profiles (invites done via admin)
create policy "profiles_insert_admin"
  on public.profiles for insert
  with check (
    organization_id = public.get_my_organization_id()
    and public.has_permission('users.manage')
  );

-- ─────────────────────────────────────────────
-- RLS POLICIES — roles
-- ─────────────────────────────────────────────
create policy "roles_select_org"
  on public.roles for select
  using (organization_id = public.get_my_organization_id());

create policy "roles_manage_admin"
  on public.roles for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('users.manage')
    and (is_system = false or public.is_super_admin())  -- can't touch system roles unless super admin
  );

-- ─────────────────────────────────────────────
-- RLS POLICIES — permissions (read-only for all authenticated users)
-- ─────────────────────────────────────────────
create policy "permissions_select_authenticated"
  on public.permissions for select
  using (auth.uid() is not null);

-- ─────────────────────────────────────────────
-- RLS POLICIES — role_permissions
-- ─────────────────────────────────────────────
create policy "role_permissions_select_org"
  on public.role_permissions for select
  using (
    role_id in (
      select id from public.roles
      where organization_id = public.get_my_organization_id()
    )
  );

create policy "role_permissions_manage_admin"
  on public.role_permissions for all
  using (
    role_id in (
      select id from public.roles
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('users.manage')
  );

-- ─────────────────────────────────────────────
-- RLS POLICIES — user_roles
-- ─────────────────────────────────────────────
create policy "user_roles_select_own_or_admin"
  on public.user_roles for select
  using (
    user_id = auth.uid()
    or public.has_permission('users.manage')
  );

create policy "user_roles_manage_admin"
  on public.user_roles for all
  using (public.has_permission('users.manage'));

-- ─────────────────────────────────────────────
-- RLS POLICIES — user_branch_access
-- ─────────────────────────────────────────────
create policy "user_branch_access_select_own_or_admin"
  on public.user_branch_access for select
  using (
    user_id = auth.uid()
    or public.has_permission('users.manage')
  );

create policy "user_branch_access_manage_admin"
  on public.user_branch_access for all
  using (public.has_permission('users.manage'));
-- ============================================================
-- Migration: 0007_customers.sql
-- Description: Customer master data — supports both individuals
--   and companies. Normalized fields for reliable deduplication.
-- ============================================================

create table public.customers (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete restrict,

  -- Type
  customer_type       text        not null check (customer_type in ('individual', 'company')),

  -- Individual fields
  first_name          text,
  last_name           text,

  -- Company fields
  legal_name          text,
  trade_name          text,

  -- Tax / ID documents (El Salvador)
  dui                 text,                    -- Documento Único de Identidad
  normalized_dui      text                     -- digits only, for dedup/search
    generated always as (regexp_replace(coalesce(dui, ''), '[^0-9]', '', 'g')) stored,
  nit                 text,                    -- Número de Identificación Tributaria
  normalized_nit      text
    generated always as (regexp_replace(coalesce(nit, ''), '[^0-9]', '', 'g')) stored,
  nrc                 text,                    -- Número de Registro de Contribuyente
  normalized_nrc      text
    generated always as (regexp_replace(coalesce(nrc, ''), '[^0-9]', '', 'g')) stored,

  -- Contact
  phone               text,
  normalized_phone    text                     -- digits only
    generated always as (regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g')) stored,
  whatsapp            text,
  email               text,

  -- Address
  address             text,
  billing_address     text,

  -- Preferences
  preferred_branch_id uuid        references public.branches(id) on delete set null,
  source              text        check (source in ('walk_in','web','referral','fleet','corporate','other')),

  notes               text,
  active              boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid        references public.profiles(id) on delete set null,
  updated_by          uuid        references public.profiles(id) on delete set null,

  -- Integrity constraints
  constraint customers_individual_has_name check (
    customer_type = 'company'
    or (first_name is not null and first_name <> '')
  ),
  constraint customers_company_has_legal_name check (
    customer_type = 'individual'
    or (legal_name is not null and legal_name <> '')
  )
);

comment on table public.customers is 'Customer master: individuals and companies. Normalized fields enable deduplication.';
comment on column public.customers.normalized_dui is 'Auto-generated: DUI digits only. Used for duplicate detection and search.';
comment on column public.customers.normalized_phone is 'Auto-generated: phone digits only. Used for duplicate detection.';

create trigger customers_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
create index idx_customers_organization_id on public.customers(organization_id);
create index idx_customers_normalized_phone on public.customers(normalized_phone) where normalized_phone is not null;
create index idx_customers_normalized_dui on public.customers(normalized_dui) where normalized_dui <> '';
create index idx_customers_normalized_nit on public.customers(normalized_nit) where normalized_nit <> '';
create index idx_customers_email on public.customers(email) where email is not null;
create index idx_customers_active on public.customers(organization_id, active);

-- Trigram index for fuzzy name search
create index idx_customers_name_trgm on public.customers
  using gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(trade_name,'') || ' ' || coalesce(legal_name,'')) gin_trgm_ops);

-- ─────────────────────────────────────────────
-- DEDUPLICATION FUNCTION
-- Check for potential duplicate customers before creating
-- ─────────────────────────────────────────────
create or replace function public.find_duplicate_customers(
  p_organization_id   uuid,
  p_phone             text default null,
  p_email             text default null,
  p_dui               text default null,
  p_nit               text default null
)
returns table (
  id              uuid,
  customer_type   text,
  full_name       text,
  phone           text,
  email           text,
  match_field     text
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct
    c.id,
    c.customer_type,
    case
      when c.customer_type = 'individual'
        then trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))
      else coalesce(c.trade_name, c.legal_name)
    end as full_name,
    c.phone,
    c.email,
    case
      when p_phone is not null
        and regexp_replace(p_phone, '[^0-9+]', '', 'g') = c.normalized_phone then 'phone'
      when p_email is not null
        and lower(p_email) = lower(c.email) then 'email'
      when p_dui is not null
        and regexp_replace(p_dui, '[^0-9]', '', 'g') = c.normalized_dui then 'dui'
      when p_nit is not null
        and regexp_replace(p_nit, '[^0-9]', '', 'g') = c.normalized_nit then 'nit'
    end as match_field
  from public.customers c
  where c.organization_id = p_organization_id
    and c.active = true
    and (
      (p_phone is not null and regexp_replace(p_phone, '[^0-9+]', '', 'g') != '' and regexp_replace(p_phone, '[^0-9+]', '', 'g') = c.normalized_phone)
      or (p_email is not null and p_email != '' and lower(p_email) = lower(c.email))
      or (p_dui is not null and regexp_replace(p_dui, '[^0-9]', '', 'g') != '' and regexp_replace(p_dui, '[^0-9]', '', 'g') = c.normalized_dui)
      or (p_nit is not null and regexp_replace(p_nit, '[^0-9]', '', 'g') != '' and regexp_replace(p_nit, '[^0-9]', '', 'g') = c.normalized_nit)
    );
$$;

-- ─────────────────────────────────────────────
-- RLS POLICIES
-- ─────────────────────────────────────────────
alter table public.customers enable row level security;

create policy "customers_select"
  on public.customers for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('customers.read')
  );

create policy "customers_insert"
  on public.customers for insert
  with check (
    organization_id = public.get_my_organization_id()
    and public.has_permission('customers.create')
  );

create policy "customers_update"
  on public.customers for update
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('customers.update')
  );

-- Soft delete only — no hard delete policy
-- Physical records are preserved; use active=false
-- ============================================================
-- Migration: 0008_vehicles.sql
-- Description: Vehicle types, vehicles, ownership history,
--   and vehicle media storage references.
-- ============================================================

-- ─────────────────────────────────────────────
-- VEHICLE TYPES
-- ─────────────────────────────────────────────
create table public.vehicle_types (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  code            text    not null,
  name            text    not null,
  size_category   text    not null check (size_category in ('small','medium','large','xl')),
  active          boolean not null default true,
  sort_order      int     not null default 0,

  constraint vehicle_types_org_code_unique unique (organization_id, code)
);

comment on table public.vehicle_types is 'Configurable vehicle types. Prices, machine programs, and services reference these.';

alter table public.vehicle_types enable row level security;
create index idx_vehicle_types_organization_id on public.vehicle_types(organization_id);

create policy "vehicle_types_select"
  on public.vehicle_types for select
  using (organization_id = public.get_my_organization_id());

create policy "vehicle_types_manage_admin"
  on public.vehicle_types for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('settings.manage')
  );

-- ── Seed: Vehicle types for CORSA ────────────────────────────
insert into public.vehicle_types (organization_id, code, name, size_category, sort_order) values
  ('00000000-0000-0000-0000-000000000001', 'SEDAN',       'Sedán',          'medium', 1),
  ('00000000-0000-0000-0000-000000000001', 'HATCHBACK',   'Hatchback',      'small',  2),
  ('00000000-0000-0000-0000-000000000001', 'SUV',         'SUV',            'large',  3),
  ('00000000-0000-0000-0000-000000000001', 'PICKUP',      'Pickup',         'large',  4),
  ('00000000-0000-0000-0000-000000000001', 'VAN',         'Van',            'xl',     5),
  ('00000000-0000-0000-0000-000000000001', 'MICROBUS',    'Microbús',       'xl',     6),
  ('00000000-0000-0000-0000-000000000001', 'MOTORCYCLE',  'Motocicleta',    'small',  7),
  ('00000000-0000-0000-0000-000000000001', 'COMMERCIAL',  'Comercial/Carga','xl',     8),
  ('00000000-0000-0000-0000-000000000001', 'OTHER',       'Otro',           'medium', 9);

-- ─────────────────────────────────────────────
-- VEHICLES
-- ─────────────────────────────────────────────
create table public.vehicles (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete restrict,
  customer_id     uuid        not null references public.customers(id) on delete restrict,  -- current owner
  vehicle_type_id uuid        not null references public.vehicle_types(id) on delete restrict,
  plate           text,
  normalized_plate text                    -- uppercase, alphanumeric only
    generated always as (upper(regexp_replace(coalesce(plate, ''), '[^A-Za-z0-9]', '', 'g'))) stored,
  brand           text,
  model           text,
  year            int         check (year between 1900 and 2100),
  color           text,
  vin             text        unique,      -- Vehicle Identification Number
  notes           text,
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid        references public.profiles(id) on delete set null,
  updated_by      uuid        references public.profiles(id) on delete set null
);

comment on table public.vehicles is 'Vehicle registry. customer_id is the CURRENT owner. Full history in vehicle_ownership_history.';
comment on column public.vehicles.normalized_plate is 'Auto-generated: uppercase alphanumeric plate. Enables search regardless of format (P 812-004 = P812004).';

create trigger vehicles_updated_at
  before update on public.vehicles
  for each row execute function public.set_updated_at();

create index idx_vehicles_organization_id on public.vehicles(organization_id);
create index idx_vehicles_customer_id on public.vehicles(customer_id);
create index idx_vehicles_normalized_plate on public.vehicles(normalized_plate) where normalized_plate is not null and normalized_plate <> '';
create index idx_vehicles_plate_trgm on public.vehicles using gin(normalized_plate gin_trgm_ops);

alter table public.vehicles enable row level security;

create policy "vehicles_select"
  on public.vehicles for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('vehicles.read')
  );

create policy "vehicles_insert"
  on public.vehicles for insert
  with check (
    organization_id = public.get_my_organization_id()
    and public.has_permission('vehicles.create')
  );

create policy "vehicles_update"
  on public.vehicles for update
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('vehicles.update')
  );

-- ─────────────────────────────────────────────
-- VEHICLE OWNERSHIP HISTORY
-- ─────────────────────────────────────────────
create table public.vehicle_ownership_history (
  id              uuid        primary key default gen_random_uuid(),
  vehicle_id      uuid        not null references public.vehicles(id) on delete restrict,
  customer_id     uuid        not null references public.customers(id) on delete restrict,
  valid_from      timestamptz not null default now(),
  valid_to        timestamptz,             -- null = current owner
  reason          text,
  transferred_by  uuid        references public.profiles(id) on delete set null
);

comment on table public.vehicle_ownership_history is 'Immutable log of vehicle ownership changes. Use transfer_vehicle_ownership() RPC.';

alter table public.vehicle_ownership_history enable row level security;
create index idx_voh_vehicle_id on public.vehicle_ownership_history(vehicle_id);
create index idx_voh_customer_id on public.vehicle_ownership_history(customer_id);

create policy "vehicle_ownership_select"
  on public.vehicle_ownership_history for select
  using (
    vehicle_id in (
      select id from public.vehicles
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('vehicles.read')
  );

-- Ownership history is only written via RPC transfer_vehicle_ownership()

-- ─────────────────────────────────────────────
-- VEHICLE MEDIA
-- ─────────────────────────────────────────────
create table public.vehicle_media (
  id              uuid        primary key default gen_random_uuid(),
  vehicle_id      uuid        not null references public.vehicles(id) on delete restrict,
  work_order_id   uuid,                    -- optional, FK added after work_orders table
  media_type      text        not null check (media_type in ('general','front','rear','left','right','damage','document')),
  storage_path    text        not null,    -- path in Supabase Storage bucket 'vehicle-media'
  file_name       text,                   -- original filename (for display only)
  file_size       bigint,                 -- bytes
  mime_type       text,
  taken_at        timestamptz,
  uploaded_by     uuid        references public.profiles(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

comment on table public.vehicle_media is 'References to vehicle photos/documents stored in Supabase Storage bucket vehicle-media.';
comment on column public.vehicle_media.storage_path is 'Do NOT expose directly to client. Generate signed URLs via Supabase SDK.';

alter table public.vehicle_media enable row level security;
create index idx_vehicle_media_vehicle_id on public.vehicle_media(vehicle_id);

create policy "vehicle_media_select"
  on public.vehicle_media for select
  using (
    vehicle_id in (
      select id from public.vehicles
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('vehicles.read')
  );

create policy "vehicle_media_insert"
  on public.vehicle_media for insert
  with check (
    vehicle_id in (
      select id from public.vehicles
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('vehicles.create')
  );

-- ─────────────────────────────────────────────
-- RPC: Transfer vehicle ownership
-- Atomically:
--   1. Close current ownership record
--   2. Open new ownership record
--   3. Update vehicles.customer_id
-- ─────────────────────────────────────────────
create or replace function public.transfer_vehicle_ownership(
  p_vehicle_id      uuid,
  p_new_customer_id uuid,
  p_reason          text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  -- Verify permission
  if not public.has_permission('vehicles.transfer') then
    raise exception 'Permission denied: vehicles.transfer required';
  end if;

  -- Get organization for the vehicle
  select organization_id into v_org_id
  from public.vehicles
  where id = p_vehicle_id;

  if not found then
    raise exception 'Vehicle not found';
  end if;

  -- Verify org isolation
  if v_org_id <> public.get_my_organization_id() then
    raise exception 'Access denied';
  end if;

  -- Verify new customer is in same org
  if not exists (
    select 1 from public.customers
    where id = p_new_customer_id
      and organization_id = v_org_id
      and active = true
  ) then
    raise exception 'New customer not found or inactive';
  end if;

  -- Close current ownership record
  update public.vehicle_ownership_history
  set valid_to = now()
  where vehicle_id = p_vehicle_id
    and valid_to is null;

  -- Open new ownership record
  insert into public.vehicle_ownership_history (
    vehicle_id, customer_id, valid_from, reason, transferred_by
  ) values (
    p_vehicle_id, p_new_customer_id, now(), p_reason, auth.uid()
  );

  -- Update current owner on vehicle
  update public.vehicles
  set customer_id = p_new_customer_id,
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_vehicle_id;

end;
$$;

comment on function public.transfer_vehicle_ownership(uuid, uuid, text) is
  'Atomically transfers vehicle ownership. Preserves full history. Requires vehicles.transfer permission.';
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
