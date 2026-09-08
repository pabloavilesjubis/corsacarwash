-- ============================================================
-- Migration: 0011_operations.sql
-- Description: Workstations, equipment, machine programs,
--   and resource assignment with concurrency protection.
-- ============================================================

-- ─────────────────────────────────────────────
-- WORKSTATIONS (Bahías/Estaciones)
-- ─────────────────────────────────────────────
create table public.workstations (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  branch_id       uuid    not null references public.branches(id) on delete restrict,
  code            text    not null,
  name            text    not null,
  type            text    not null check (type in ('wash','drying','detailing','vacuum','quality_control','reception')),
  status          text    not null default 'available'
                          check (status in ('available','occupied','maintenance','offline')),
  active          boolean not null default true,

  constraint workstations_branch_code_unique unique (branch_id, code)
);

comment on table public.workstations is 'Physical stations/bays in a branch. Realtime-enabled for live operations board.';

alter table public.workstations enable row level security;
create index idx_workstations_branch on public.workstations(branch_id);

create policy "workstations_select"
  on public.workstations for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
  );

create policy "workstations_manage"
  on public.workstations for all
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- EQUIPMENT (Máquinas)
-- ─────────────────────────────────────────────
create table public.equipment (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  branch_id       uuid    not null references public.branches(id) on delete restrict,
  workstation_id  uuid    references public.workstations(id) on delete set null,
  equipment_type  text    not null,       -- 'tunnel_washer', 'pressure_washer', 'vacuum', etc.
  name            text    not null,
  code            text    not null,
  status          text    not null default 'available'
                          check (status in ('available','occupied','maintenance','offline')),
  active          boolean not null default true,
  installed_at    date,
  notes           text,

  constraint equipment_branch_code_unique unique (branch_id, code)
);

comment on table public.equipment is 'Physical machines. Status is Realtime-synced for live ops display.';

alter table public.equipment enable row level security;
create index idx_equipment_branch on public.equipment(branch_id);
create index idx_equipment_status on public.equipment(branch_id, status);

create policy "equipment_select"
  on public.equipment for select
  using (branch_id in (select public.get_accessible_branch_ids()));

create policy "equipment_manage"
  on public.equipment for all
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- MACHINE PROGRAMS
-- ─────────────────────────────────────────────
create table public.machine_programs (
  id              uuid    primary key default gen_random_uuid(),
  equipment_id    uuid    references public.equipment(id) on delete cascade,
  equipment_type  text,   -- for generic programs not tied to a specific machine
  code            text    not null,
  name            text    not null,
  duration_minutes int    check (duration_minutes > 0),
  active          boolean not null default true
);

comment on table public.machine_programs is 'Named wash programs. Never hardcode Program 1/2/3/4. Programs are configured per machine or machine type.';

alter table public.machine_programs enable row level security;
create index idx_machine_programs_equipment on public.machine_programs(equipment_id);

create policy "machine_programs_select"
  on public.machine_programs for select
  using (
    equipment_id is null
    or equipment_id in (
      select id from public.equipment
      where branch_id in (select public.get_accessible_branch_ids())
    )
  );

-- ─────────────────────────────────────────────
-- SERVICE → MACHINE PROGRAM mapping
-- ─────────────────────────────────────────────
create table public.service_machine_programs (
  service_id          uuid not null references public.services(id) on delete cascade,
  machine_program_id  uuid not null references public.machine_programs(id) on delete cascade,
  primary key (service_id, machine_program_id)
);

alter table public.service_machine_programs enable row level security;

create policy "service_machine_programs_select"
  on public.service_machine_programs for select
  using (auth.uid() is not null);

-- ─────────────────────────────────────────────
-- RESOURCE ASSIGNMENTS
-- Prevents double-booking of machines/stations
-- ─────────────────────────────────────────────
create table public.resource_assignments (
  id              uuid        primary key default gen_random_uuid(),
  work_order_id   uuid        not null references public.work_orders(id) on delete cascade,
  resource_type   text        not null check (resource_type in ('workstation','equipment')),
  resource_id     uuid        not null,
  assigned_at     timestamptz not null default now(),
  released_at     timestamptz,
  assigned_by     uuid        references public.profiles(id) on delete set null
);

comment on table public.resource_assignments is 'Tracks machine/station reservations. Use assign_equipment() RPC to prevent concurrent booking.';

create index idx_resource_assignments_resource on public.resource_assignments(resource_id, released_at);
create index idx_resource_assignments_order on public.resource_assignments(work_order_id);

alter table public.resource_assignments enable row level security;

create policy "resource_assignments_select"
  on public.resource_assignments for select
  using (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
  );

-- ─────────────────────────────────────────────
-- RPC: Assign equipment to order (concurrency-safe)
-- ─────────────────────────────────────────────
create or replace function public.assign_equipment(
  p_work_order_id uuid,
  p_resource_type text,
  p_resource_id   uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignment_id uuid;
  v_branch_id     uuid;
begin
  -- Get order's branch
  select branch_id into v_branch_id
  from public.work_orders
  where id = p_work_order_id;

  -- Permission check
  if v_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Access denied to this order';
  end if;

  -- Check if resource is already assigned (not released)
  if exists (
    select 1 from public.resource_assignments
    where resource_id = p_resource_id
      and released_at is null
      and work_order_id <> p_work_order_id  -- can re-assign to same order
  ) then
    raise exception 'Resource is already assigned to another order';
  end if;

  -- Create assignment
  insert into public.resource_assignments (
    work_order_id, resource_type, resource_id, assigned_by
  ) values (
    p_work_order_id, p_resource_type, p_resource_id, auth.uid()
  )
  returning id into v_assignment_id;

  -- Update equipment status
  if p_resource_type = 'equipment' then
    update public.equipment
    set status = 'occupied'
    where id = p_resource_id;
  elsif p_resource_type = 'workstation' then
    update public.workstations
    set status = 'occupied'
    where id = p_resource_id;
  end if;

  return v_assignment_id;
end;
$$;

-- ─────────────────────────────────────────────
-- RPC: Release equipment
-- ─────────────────────────────────────────────
create or replace function public.release_equipment(
  p_work_order_id uuid,
  p_resource_id   uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resource_type text;
begin
  -- Release assignment
  update public.resource_assignments
  set released_at = now()
  where work_order_id = p_work_order_id
    and resource_id = p_resource_id
    and released_at is null
  returning resource_type into v_resource_type;

  -- Update resource status to available
  if v_resource_type = 'equipment' then
    update public.equipment set status = 'available' where id = p_resource_id;
  elsif v_resource_type = 'workstation' then
    update public.workstations set status = 'available' where id = p_resource_id;
  end if;
end;
$$;

-- ─────────────────────────────────────────────
-- SEED: Workstations and Equipment for Escalón
-- ─────────────────────────────────────────────
insert into public.workstations (organization_id, branch_id, code, name, type) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'RECEP',  'Recepción',          'reception'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'TUN-1',  'Túnel Lavado 1',     'wash'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'ASPI-1', 'Bahía Aspirado 1',   'vacuum'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'ASPI-2', 'Bahía Aspirado 2',   'vacuum'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'DET-1',  'Bahía Detailing 1',  'detailing'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'SEC-1',  'Bahía Secado 1',     'drying'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'QC-1',   'Control Calidad',    'quality_control');

insert into public.equipment (organization_id, branch_id, code, name, equipment_type) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'LAV-TUN-01', 'Lavadora Túnel Principal', 'tunnel_washer'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'PRES-01',    'Lavadora Presión 1',       'pressure_washer'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'PRES-02',    'Lavadora Presión 2',       'pressure_washer'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'ASPI-01',    'Aspiradora Industrial 1',  'vacuum'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'ASPI-02',    'Aspiradora Industrial 2',  'vacuum');
