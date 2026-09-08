-- ============================================================
-- Migration: 0018_employees.sql
-- Description: Employee positions, employees (distinct from users),
--   shifts, and resolves forward references from prior migrations.
-- ============================================================

-- ─────────────────────────────────────────────
-- EMPLOYEE POSITIONS
-- ─────────────────────────────────────────────
create table public.employee_positions (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  name            text    not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table public.employee_positions enable row level security;

create policy "employee_positions_select"
  on public.employee_positions for select
  using (organization_id = public.get_my_organization_id());

create policy "employee_positions_manage"
  on public.employee_positions for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('employees.manage')
  );

-- ─────────────────────────────────────────────
-- EMPLOYEES
-- IMPORTANT: Employees != Users.
-- A washer may be an employee without system access.
-- A manager may be both an employee and a user.
-- ─────────────────────────────────────────────
create table public.employees (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete restrict,
  branch_id       uuid        not null references public.branches(id) on delete restrict,
  user_id         uuid        references public.profiles(id) on delete set null,  -- OPTIONAL
  employee_code   text        not null,
  first_name      text        not null,
  last_name       text        not null,
  phone           text,
  email           text,
  position_id     uuid        references public.employee_positions(id) on delete set null,
  hire_date       date,
  termination_date date,
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint employees_org_code_unique unique (organization_id, employee_code)
);

comment on table public.employees is 'Physical employees. Not all employees have a user_id (system login). Separation is intentional.';
comment on column public.employees.user_id is 'Optional link to profiles. Only employees who need system access have this.';

create trigger employees_updated_at
  before update on public.employees
  for each row execute function public.set_updated_at();

create index idx_employees_organization on public.employees(organization_id);
create index idx_employees_branch on public.employees(branch_id);
create index idx_employees_user_id on public.employees(user_id) where user_id is not null;
create index idx_employees_active on public.employees(branch_id, active);

alter table public.employees enable row level security;

create policy "employees_select"
  on public.employees for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('employees.read')
  );

create policy "employees_manage"
  on public.employees for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('employees.manage')
  );

-- ─────────────────────────────────────────────
-- EMPLOYEE SHIFTS
-- ─────────────────────────────────────────────
create table public.employee_shifts (
  id          uuid        primary key default gen_random_uuid(),
  employee_id uuid        not null references public.employees(id) on delete cascade,
  branch_id   uuid        not null references public.branches(id) on delete restrict,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  status      text        not null default 'scheduled'
                          check (status in ('scheduled','active','completed','absent')),
  notes       text,
  created_at  timestamptz not null default now()
);

create index idx_shifts_employee on public.employee_shifts(employee_id);
create index idx_shifts_branch_date on public.employee_shifts(branch_id, starts_at);

alter table public.employee_shifts enable row level security;

create policy "employee_shifts_select"
  on public.employee_shifts for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('employees.read')
  );

-- ─────────────────────────────────────────────
-- Resolve FK references from prior migrations
-- ─────────────────────────────────────────────

-- work_order_assignments.employee_id → employees
alter table public.work_order_assignments
  add constraint wo_assignments_employee_fk
  foreign key (employee_id) references public.employees(id) on delete restrict;

-- work_order_reworks.responsible_employee_id → employees
alter table public.work_order_reworks
  add constraint wo_reworks_employee_fk
  foreign key (responsible_employee_id) references public.employees(id) on delete set null;

-- work_order_quality_checks.checked_by → employees
alter table public.work_order_quality_checks
  add constraint wo_quality_employee_fk
  foreign key (checked_by) references public.employees(id) on delete set null;

-- tip_distributions.employee_id → employees
alter table public.tip_distributions
  add constraint tip_distributions_employee_fk
  foreign key (employee_id) references public.employees(id) on delete restrict;

-- ─────────────────────────────────────────────
-- SEED: Employee positions
-- ─────────────────────────────────────────────
insert into public.employee_positions (organization_id, name) values
  ('00000000-0000-0000-0000-000000000001', 'Lavador'),
  ('00000000-0000-0000-0000-000000000001', 'Detallador'),
  ('00000000-0000-0000-0000-000000000001', 'Supervisor'),
  ('00000000-0000-0000-0000-000000000001', 'Cajero/a'),
  ('00000000-0000-0000-0000-000000000001', 'Recepcionista'),
  ('00000000-0000-0000-0000-000000000001', 'Gerente de Sucursal');
