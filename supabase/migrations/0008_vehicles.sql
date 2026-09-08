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
