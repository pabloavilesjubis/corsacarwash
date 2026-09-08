-- ============================================================
-- Migration: 0015_memberships.sql
-- Description: Membership plans, benefits, customer memberships,
--   and usage tracking with concurrency protection.
-- ============================================================

-- ─────────────────────────────────────────────
-- MEMBERSHIP PLANS
-- ─────────────────────────────────────────────
create table public.membership_plans (
  id                uuid          primary key default gen_random_uuid(),
  organization_id   uuid          not null references public.organizations(id) on delete restrict,
  name              text          not null,
  description       text,
  billing_frequency text          not null check (billing_frequency in ('monthly','annual','one_time')),
  price             numeric(10,2) not null check (price >= 0),
  vehicle_type_id   uuid          references public.vehicle_types(id) on delete restrict,  -- null = any
  max_vehicles      int           not null default 1,
  active            boolean       not null default true,
  sort_order        int           not null default 0,
  created_at        timestamptz   not null default now()
);

alter table public.membership_plans enable row level security;

create policy "membership_plans_select"
  on public.membership_plans for select
  using (organization_id = public.get_my_organization_id());

create policy "membership_plans_manage"
  on public.membership_plans for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('memberships.manage')
  );

-- ─────────────────────────────────────────────
-- MEMBERSHIP PLAN BENEFITS
-- Each plan can have multiple benefits.
-- Benefits define what the member gets (services, discounts, etc.)
-- ─────────────────────────────────────────────
create table public.membership_plan_benefits (
  id                  uuid          primary key default gen_random_uuid(),
  plan_id             uuid          not null references public.membership_plans(id) on delete cascade,
  service_id          uuid          not null references public.services(id) on delete restrict,
  quantity_per_period int,                     -- null if unlimited
  unlimited           boolean       not null default false,
  discount_percentage numeric(5,2)  not null default 0 check (discount_percentage between 0 and 100),
  cooldown_hours      int           not null default 0,  -- min hours between uses
  branch_restriction  uuid          references public.branches(id) on delete set null,  -- null = any branch
  active              boolean       not null default true,

  constraint benefit_quantity_or_unlimited check (
    unlimited = true or quantity_per_period is not null
  )
);

create index idx_membership_plan_benefits_plan on public.membership_plan_benefits(plan_id);

alter table public.membership_plan_benefits enable row level security;

create policy "membership_plan_benefits_select"
  on public.membership_plan_benefits for select
  using (
    plan_id in (
      select id from public.membership_plans
      where organization_id = public.get_my_organization_id()
    )
  );

-- ─────────────────────────────────────────────
-- CUSTOMER MEMBERSHIPS
-- ─────────────────────────────────────────────
create table public.customer_memberships (
  id                  uuid          primary key default gen_random_uuid(),
  customer_id         uuid          not null references public.customers(id) on delete restrict,
  plan_id             uuid          not null references public.membership_plans(id) on delete restrict,
  vehicle_id          uuid          references public.vehicles(id) on delete set null,
  starts_at           date          not null,
  expires_at          date          not null,
  next_billing_at     date,
  status              text          not null default 'active'
                                    check (status in ('pending','active','past_due','suspended','cancelled','expired')),
  price_snapshot      numeric(10,2) not null,  -- price at time of purchase (immutable)
  auto_renew          boolean       not null default true,
  cancellation_reason text,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),

  constraint memberships_dates_valid check (expires_at > starts_at)
);

comment on table public.customer_memberships is 'Active and historical memberships. Use apply_membership_benefit() RPC for concurrency safety.';
comment on column public.customer_memberships.price_snapshot is 'Price at subscription time. Immutable historical record.';

create trigger customer_memberships_updated_at
  before update on public.customer_memberships
  for each row execute function public.set_updated_at();

create index idx_customer_memberships_customer on public.customer_memberships(customer_id);
create index idx_customer_memberships_status on public.customer_memberships(status, expires_at);
create index idx_customer_memberships_vehicle on public.customer_memberships(vehicle_id);

alter table public.customer_memberships enable row level security;

create policy "customer_memberships_select"
  on public.customer_memberships for select
  using (
    customer_id in (
      select id from public.customers
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('memberships.read')
  );

-- ─────────────────────────────────────────────
-- MEMBERSHIP USAGE
-- Every use is recorded — even for unlimited plans.
-- Enables analytics and chargeback evidence.
-- ─────────────────────────────────────────────
create table public.membership_usage (
  id              uuid          primary key default gen_random_uuid(),
  membership_id   uuid          not null references public.customer_memberships(id) on delete restrict,
  work_order_id   uuid          not null references public.work_orders(id) on delete restrict,
  benefit_id      uuid          not null references public.membership_plan_benefits(id) on delete restrict,
  service_id      uuid          not null references public.services(id) on delete restrict,
  vehicle_id      uuid          references public.vehicles(id) on delete set null,
  used_at         timestamptz   not null default now(),
  retail_value    numeric(10,2) not null,  -- what the service would have cost
  benefit_applied text          not null   -- description of benefit applied
);

create index idx_membership_usage_membership on public.membership_usage(membership_id);
create index idx_membership_usage_order on public.membership_usage(work_order_id);

alter table public.membership_usage enable row level security;

create policy "membership_usage_select"
  on public.membership_usage for select
  using (
    membership_id in (
      select cm.id from public.customer_memberships cm
      join public.customers c on c.id = cm.customer_id
      where c.organization_id = public.get_my_organization_id()
    )
    and public.has_permission('memberships.read')
  );

-- ─────────────────────────────────────────────
-- RPC: Apply membership benefit (concurrency-safe)
-- Lock the membership row to prevent double-use.
-- Verifies: active status, vehicle match, benefit limits, cooldown.
-- ─────────────────────────────────────────────
create or replace function public.apply_membership_benefit(
  p_membership_id   uuid,
  p_benefit_id      uuid,
  p_work_order_id   uuid,
  p_vehicle_id      uuid,
  p_retail_value    numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership    record;
  v_benefit       record;
  v_used_count    int;
  v_last_use      timestamptz;
  v_period_start  date;
  v_usage_id      uuid;
  v_benefit_desc  text;
begin
  -- Permission
  if not public.has_permission('orders.create') then
    raise exception 'Permission denied';
  end if;

  -- Lock membership to prevent concurrent use
  select * into v_membership
  from public.customer_memberships
  where id = p_membership_id
  for update;

  if not found then
    raise exception 'Membership not found';
  end if;

  -- Verify membership is active
  if v_membership.status <> 'active' then
    raise exception 'Membership is not active (status: %)', v_membership.status;
  end if;

  -- Verify not expired
  if v_membership.expires_at < current_date then
    raise exception 'Membership has expired';
  end if;

  -- Verify vehicle if membership is vehicle-specific
  if v_membership.vehicle_id is not null and v_membership.vehicle_id <> p_vehicle_id then
    raise exception 'This membership is not valid for this vehicle';
  end if;

  -- Get benefit details
  select * into v_benefit
  from public.membership_plan_benefits
  where id = p_benefit_id
    and plan_id = v_membership.plan_id
    and active = true;

  if not found then
    raise exception 'Benefit not found or inactive';
  end if;

  -- Check cooldown
  if v_benefit.cooldown_hours > 0 then
    select max(used_at) into v_last_use
    from public.membership_usage
    where membership_id = p_membership_id
      and benefit_id = p_benefit_id;

    if v_last_use is not null
      and v_last_use + (v_benefit.cooldown_hours || ' hours')::interval > now() then
      raise exception 'Benefit is in cooldown. Available after: %',
        v_last_use + (v_benefit.cooldown_hours || ' hours')::interval;
    end if;
  end if;

  -- Check quantity limit (per period) if not unlimited
  if not v_benefit.unlimited and v_benefit.quantity_per_period is not null then
    -- Period start = beginning of current billing cycle
    v_period_start := v_membership.starts_at;
    while v_period_start + interval '1 month' <= current_date loop
      v_period_start := v_period_start + interval '1 month';
    end loop;

    select count(*) into v_used_count
    from public.membership_usage
    where membership_id = p_membership_id
      and benefit_id = p_benefit_id
      and used_at >= v_period_start::timestamptz;

    if v_used_count >= v_benefit.quantity_per_period then
      raise exception 'Benefit limit reached for this period (% of %)',
        v_used_count, v_benefit.quantity_per_period;
    end if;
  end if;

  -- Determine benefit description
  if v_benefit.unlimited then
    v_benefit_desc := 'Incluido en membresía (ilimitado)';
  elsif v_benefit.discount_percentage > 0 then
    v_benefit_desc := v_benefit.discount_percentage || '% descuento por membresía';
  else
    v_benefit_desc := 'Incluido en membresía';
  end if;

  -- Record usage
  insert into public.membership_usage (
    membership_id, work_order_id, benefit_id, service_id,
    vehicle_id, retail_value, benefit_applied
  ) values (
    p_membership_id, p_work_order_id, p_benefit_id, v_benefit.service_id,
    p_vehicle_id, p_retail_value, v_benefit_desc
  )
  returning id into v_usage_id;

  return jsonb_build_object(
    'usage_id',           v_usage_id,
    'benefit_applied',    v_benefit_desc,
    'discount_percentage', v_benefit.discount_percentage,
    'retail_value',       p_retail_value
  );
end;
$$;

comment on function public.apply_membership_benefit(uuid, uuid, uuid, uuid, numeric) is
  'Atomically applies a membership benefit. Prevents concurrent double-use via row lock. Validates status, cooldown, and limits.';

-- ─────────────────────────────────────────────
-- SEED: Membership plans for CORSA
-- ─────────────────────────────────────────────
-- Get vehicle type IDs for seeding
do $$
declare
  v_sedan_id   uuid;
  v_suv_id     uuid;
  v_plan_basic uuid := gen_random_uuid();
  v_plan_sed   uuid := gen_random_uuid();
  v_plan_suv   uuid := gen_random_uuid();
begin
  select id into v_sedan_id from public.vehicle_types
  where organization_id = '00000000-0000-0000-0000-000000000001' and code = 'SEDAN';

  select id into v_suv_id from public.vehicle_types
  where organization_id = '00000000-0000-0000-0000-000000000001' and code = 'SUV';

  -- Plan: Básico (discount plan, no free washes)
  insert into public.membership_plans (id, organization_id, name, description, billing_frequency, price, max_vehicles, sort_order)
  values (v_plan_basic, '00000000-0000-0000-0000-000000000001',
    'Básico', '10% descuento en todos los lavados', 'monthly', 9.99, 1, 1);

  insert into public.membership_plan_benefits (plan_id, service_id, unlimited, discount_percentage)
  select v_plan_basic, id, false, 10
  from public.services
  where organization_id = '00000000-0000-0000-0000-000000000001'
    and code in ('LAV-BASIC','LAV-COMP','LAV-PREM');

  -- Plan: Ilimitado Sedán (unlimited washes for sedans)
  insert into public.membership_plans (id, organization_id, name, description, billing_frequency, price, vehicle_type_id, max_vehicles, sort_order)
  values (v_plan_sed, '00000000-0000-0000-0000-000000000001',
    'Ilimitado Sedán', 'Lavado completo ilimitado para Sedán', 'monthly', 29.99, v_sedan_id, 1, 2);

  insert into public.membership_plan_benefits (plan_id, service_id, unlimited, cooldown_hours)
  select v_plan_sed, id, true, 12
  from public.services
  where organization_id = '00000000-0000-0000-0000-000000000001'
    and code = 'LAV-COMP';

  -- Plan: Ilimitado SUV/Pickup
  insert into public.membership_plans (id, organization_id, name, description, billing_frequency, price, vehicle_type_id, max_vehicles, sort_order)
  values (v_plan_suv, '00000000-0000-0000-0000-000000000001',
    'Ilimitado SUV', 'Lavado completo ilimitado para SUV/Pickup', 'monthly', 39.99, v_suv_id, 1, 3);

  insert into public.membership_plan_benefits (plan_id, service_id, unlimited, cooldown_hours)
  select v_plan_suv, id, true, 12
  from public.services
  where organization_id = '00000000-0000-0000-0000-000000000001'
    and code = 'LAV-COMP';
end;
$$;
-- ============================================================
-- Migration: 0016_promotions.sql
-- Description: Promotions, coupons, redemptions,
--   and work order discounts audit trail.
-- ============================================================

create table public.promotions (
  id                uuid          primary key default gen_random_uuid(),
  organization_id   uuid          not null references public.organizations(id) on delete restrict,
  name              text          not null,
  description       text,
  type              text          not null check (type in ('percentage','fixed_amount','bundle','free_service')),
  value             numeric(10,2),               -- percentage (0-100) or fixed amount
  service_id        uuid          references public.services(id) on delete set null,  -- if applicable
  min_order_amount  numeric(10,2),               -- minimum purchase to apply
  starts_at         timestamptz   not null default now(),
  ends_at           timestamptz,                 -- null = no expiry
  usage_limit       int,                         -- total uses allowed
  per_customer_limit int,                        -- uses per customer
  active            boolean       not null default true,
  created_at        timestamptz   not null default now()
);

alter table public.promotions enable row level security;

create policy "promotions_select"
  on public.promotions for select
  using (organization_id = public.get_my_organization_id());

create policy "promotions_manage"
  on public.promotions for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- COUPONS
-- ─────────────────────────────────────────────
create table public.coupons (
  id            uuid        primary key default gen_random_uuid(),
  promotion_id  uuid        not null references public.promotions(id) on delete cascade,
  code          text        not null unique,
  customer_id   uuid        references public.customers(id) on delete set null,  -- null = public
  used_count    int         not null default 0,
  max_uses      int         not null default 1,
  expires_at    timestamptz,
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);

create index idx_coupons_code on public.coupons(code);
create index idx_coupons_customer on public.coupons(customer_id);

alter table public.coupons enable row level security;

create policy "coupons_select"
  on public.coupons for select
  using (
    promotion_id in (
      select id from public.promotions
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('discounts.apply')
  );

-- ─────────────────────────────────────────────
-- COUPON REDEMPTIONS
-- ─────────────────────────────────────────────
create table public.coupon_redemptions (
  id              uuid          primary key default gen_random_uuid(),
  coupon_id       uuid          not null references public.coupons(id) on delete restrict,
  work_order_id   uuid          not null references public.work_orders(id) on delete restrict,
  customer_id     uuid          references public.customers(id) on delete set null,
  amount_saved    numeric(10,2) not null,
  redeemed_at     timestamptz   not null default now(),
  redeemed_by     uuid          references public.profiles(id) on delete set null
);

create index idx_coupon_redemptions_coupon on public.coupon_redemptions(coupon_id);
create index idx_coupon_redemptions_order on public.coupon_redemptions(work_order_id);

alter table public.coupon_redemptions enable row level security;

create policy "coupon_redemptions_select"
  on public.coupon_redemptions for select
  using (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('discounts.apply')
  );

-- ─────────────────────────────────────────────
-- WORK ORDER DISCOUNTS (audit trail)
-- Every discount applied must have a reason.
-- Manual overrides require approval.
-- ─────────────────────────────────────────────
create table public.work_order_discounts (
  id              uuid          primary key default gen_random_uuid(),
  work_order_id   uuid          not null references public.work_orders(id) on delete restrict,
  type            text          not null check (type in ('manual','coupon','membership','promotion','employee','goodwill')),
  amount          numeric(10,2) not null check (amount > 0),
  reason          text          not null,  -- reason is ALWAYS required
  coupon_id       uuid          references public.coupons(id) on delete set null,
  promotion_id    uuid          references public.promotions(id) on delete set null,
  applied_by      uuid          not null references public.profiles(id) on delete restrict,
  approved_by     uuid          references public.profiles(id) on delete set null,
  requires_approval boolean     not null default false,
  created_at      timestamptz   not null default now()
);

comment on table public.work_order_discounts is 'Audit trail for all discounts. Every discount must have a reason. Overrides require approved_by.';
comment on column public.work_order_discounts.reason is 'REQUIRED for all discounts. Used for audit and analytics.';

create index idx_wo_discounts_order on public.work_order_discounts(work_order_id);

alter table public.work_order_discounts enable row level security;

create policy "wo_discounts_select"
  on public.work_order_discounts for select
  using (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('discounts.apply')
  );

create policy "wo_discounts_insert"
  on public.work_order_discounts for insert
  with check (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
    and (
      public.has_permission('discounts.apply')
      or public.has_permission('discounts.override')
    )
  );
-- ============================================================
-- Migration: 0017_appointments.sql
-- Description: Appointment scheduling. Prepared for availability
--   and capacity management. No overbooking enforcement yet.
-- ============================================================

create table public.appointments (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete restrict,
  branch_id                 uuid        not null references public.branches(id) on delete restrict,
  customer_id               uuid        references public.customers(id) on delete set null,
  vehicle_id                uuid        references public.vehicles(id) on delete set null,
  scheduled_at              timestamptz not null,
  estimated_duration_minutes int,
  status                    text        not null default 'scheduled'
                                        check (status in ('scheduled','confirmed','arrived','in_service','cancelled','no_show','completed')),
  notes                     text,
  created_by                uuid        references public.profiles(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.appointments is 'Appointment scheduling. Linked to work_orders.appointment_id when customer arrives.';

create trigger appointments_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

create index idx_appointments_branch_date on public.appointments(branch_id, scheduled_at);
create index idx_appointments_customer on public.appointments(customer_id);
create index idx_appointments_status on public.appointments(branch_id, status);

alter table public.appointments enable row level security;

create policy "appointments_select"
  on public.appointments for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('appointments.read')
  );

create policy "appointments_insert"
  on public.appointments for insert
  with check (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('appointments.manage')
  );

create policy "appointments_update"
  on public.appointments for update
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('appointments.manage')
  );

-- Now add FK from work_orders to appointments (deferred since appointments comes after work_orders)
alter table public.work_orders
  add constraint work_orders_appointment_fk
  foreign key (appointment_id) references public.appointments(id) on delete set null;
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
-- ============================================================
-- Migration: 0019_corporate.sql
-- Description: Corporate accounts, fleets, fleet vehicles,
--   fleet contracts, negotiated pricing, and accounts receivable.
-- ============================================================

-- ─────────────────────────────────────────────
-- CORPORATE ACCOUNTS
-- One-to-one extension of a company customer.
-- Tracks credit limit, balance, and blocking.
-- ─────────────────────────────────────────────
create table public.corporate_accounts (
  id              uuid          primary key default gen_random_uuid(),
  customer_id     uuid          not null unique references public.customers(id) on delete restrict,
  credit_limit    numeric(10,2) not null default 0 check (credit_limit >= 0),
  credit_days     int           not null default 30,
  credit_status   text          not null default 'active'
                                check (credit_status in ('active','suspended','blocked')),
  current_balance numeric(10,2) not null default 0,  -- denormalized; source of truth is AR
  blocked         boolean       not null default false,
  block_reason    text,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

comment on table public.corporate_accounts is 'Credit account for company customers. current_balance is denormalized for fast checks.';
comment on column public.corporate_accounts.current_balance is 'Denormalized. Recalculate from accounts_receivable when needed. Used for fast credit checks.';

create trigger corporate_accounts_updated_at
  before update on public.corporate_accounts
  for each row execute function public.set_updated_at();

alter table public.corporate_accounts enable row level security;

create policy "corporate_accounts_select"
  on public.corporate_accounts for select
  using (
    customer_id in (
      select id from public.customers
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.read')
  );

create policy "corporate_accounts_manage"
  on public.corporate_accounts for all
  using (
    customer_id in (
      select id from public.customers
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.manage')
  );

-- ─────────────────────────────────────────────
-- RPC: Check corporate credit availability
-- ─────────────────────────────────────────────
create or replace function public.check_corporate_credit(
  p_customer_id uuid,
  p_amount      numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account record;
  v_available numeric(10,2);
begin
  select * into v_account
  from public.corporate_accounts
  where customer_id = p_customer_id
  for share;  -- shared lock: read-consistent but allow others to read

  if not found then
    return jsonb_build_object(
      'approved', false,
      'reason', 'No corporate account found'
    );
  end if;

  if v_account.blocked then
    return jsonb_build_object(
      'approved', false,
      'reason', coalesce(v_account.block_reason, 'Account is blocked')
    );
  end if;

  if v_account.credit_status <> 'active' then
    return jsonb_build_object(
      'approved', false,
      'reason', 'Account status: ' || v_account.credit_status
    );
  end if;

  v_available := v_account.credit_limit - v_account.current_balance;

  if p_amount > v_available then
    return jsonb_build_object(
      'approved', false,
      'reason', 'Insufficient credit',
      'credit_limit', v_account.credit_limit,
      'current_balance', v_account.current_balance,
      'available', v_available,
      'requested', p_amount
    );
  end if;

  return jsonb_build_object(
    'approved', true,
    'available', v_available,
    'credit_limit', v_account.credit_limit,
    'current_balance', v_account.current_balance
  );
end;
$$;

-- ─────────────────────────────────────────────
-- FLEETS
-- ─────────────────────────────────────────────
create table public.fleets (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  customer_id     uuid    not null references public.customers(id) on delete restrict,
  name            text    not null,
  code            text    not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table public.fleets enable row level security;
create index idx_fleets_customer on public.fleets(customer_id);

create policy "fleets_select"
  on public.fleets for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('corporate.read')
  );

create policy "fleets_manage"
  on public.fleets for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('corporate.manage')
  );

-- ─────────────────────────────────────────────
-- FLEET VEHICLES
-- ─────────────────────────────────────────────
create table public.fleet_vehicles (
  id          uuid        primary key default gen_random_uuid(),
  fleet_id    uuid        not null references public.fleets(id) on delete cascade,
  vehicle_id  uuid        not null references public.vehicles(id) on delete restrict,
  cost_center text,                      -- for billing allocation
  active      boolean     not null default true,
  added_at    timestamptz not null default now(),

  constraint fleet_vehicles_unique unique (fleet_id, vehicle_id)
);

alter table public.fleet_vehicles enable row level security;
create index idx_fleet_vehicles_fleet on public.fleet_vehicles(fleet_id);

create policy "fleet_vehicles_select"
  on public.fleet_vehicles for select
  using (
    fleet_id in (
      select id from public.fleets
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.read')
  );

-- ─────────────────────────────────────────────
-- FLEET CONTRACTS
-- ─────────────────────────────────────────────
create table public.fleet_contracts (
  id                uuid          primary key default gen_random_uuid(),
  fleet_id          uuid          not null references public.fleets(id) on delete restrict,
  starts_at         date          not null,
  ends_at           date,
  billing_frequency text          check (billing_frequency in ('weekly','biweekly','monthly')),
  credit_limit      numeric(10,2),
  credit_days       int           default 30,
  terms             text,
  active            boolean       not null default true,
  created_at        timestamptz   not null default now()
);

alter table public.fleet_contracts enable row level security;

create policy "fleet_contracts_select"
  on public.fleet_contracts for select
  using (
    fleet_id in (
      select id from public.fleets
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.read')
  );

-- ─────────────────────────────────────────────
-- CUSTOMER/FLEET PRICE AGREEMENTS
-- Negotiated prices override standard service_prices.
-- ─────────────────────────────────────────────
create table public.customer_price_agreements (
  id                uuid          primary key default gen_random_uuid(),
  organization_id   uuid          not null references public.organizations(id) on delete restrict,
  customer_id       uuid          references public.customers(id) on delete cascade,
  fleet_id          uuid          references public.fleets(id) on delete cascade,
  service_id        uuid          not null references public.services(id) on delete restrict,
  vehicle_type_id   uuid          references public.vehicle_types(id) on delete restrict,  -- null = any
  negotiated_price  numeric(10,2) not null check (negotiated_price >= 0),
  effective_from    date          not null default current_date,
  effective_to      date,
  active            boolean       not null default true,
  created_by        uuid          references public.profiles(id) on delete set null,
  created_at        timestamptz   not null default now(),

  -- Must have either customer or fleet
  constraint price_agreements_target_check check (
    (customer_id is not null) or (fleet_id is not null)
  )
);

create index idx_price_agreements_customer on public.customer_price_agreements(customer_id);
create index idx_price_agreements_fleet on public.customer_price_agreements(fleet_id);

alter table public.customer_price_agreements enable row level security;

create policy "price_agreements_select"
  on public.customer_price_agreements for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('corporate.read')
  );

create policy "price_agreements_manage"
  on public.customer_price_agreements for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('corporate.manage')
  );

-- ─────────────────────────────────────────────
-- ACCOUNTS RECEIVABLE
-- ─────────────────────────────────────────────
create table public.accounts_receivable (
  id              uuid          primary key default gen_random_uuid(),
  organization_id uuid          not null references public.organizations(id) on delete restrict,
  customer_id     uuid          not null references public.customers(id) on delete restrict,
  work_order_id   uuid          references public.work_orders(id) on delete restrict,
  invoice_id      uuid,         -- FK to invoices (added in 0025)
  due_date        date          not null,
  amount          numeric(10,2) not null check (amount > 0),
  balance         numeric(10,2) not null check (balance >= 0),
  status          text          not null default 'open'
                                check (status in ('open','partial','paid','overdue','void')),
  notes           text,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

comment on table public.accounts_receivable is 'Accounts receivable. Aging is calculated from due_date, never stored in buckets.';

create trigger ar_updated_at
  before update on public.accounts_receivable
  for each row execute function public.set_updated_at();

create index idx_ar_customer on public.accounts_receivable(customer_id);
create index idx_ar_status_due on public.accounts_receivable(status, due_date);
create index idx_ar_org_status on public.accounts_receivable(organization_id, status);

alter table public.accounts_receivable enable row level security;

create policy "ar_select"
  on public.accounts_receivable for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('ar.read')
  );

create policy "ar_manage"
  on public.accounts_receivable for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('finance.manage')
  );

-- ─────────────────────────────────────────────
-- VIEW: AR Aging (never stored; always calculated)
-- ─────────────────────────────────────────────
create or replace view public.ar_aging as
select
  ar.id,
  ar.organization_id,
  ar.customer_id,
  c.first_name || ' ' || coalesce(c.last_name, '') as customer_name,
  coalesce(c.trade_name, c.legal_name) as company_name,
  ar.due_date,
  ar.amount,
  ar.balance,
  ar.status,
  current_date - ar.due_date as days_overdue,
  case
    when current_date <= ar.due_date               then 'current'
    when current_date - ar.due_date <= 30          then '1_30'
    when current_date - ar.due_date <= 60          then '31_60'
    when current_date - ar.due_date <= 90          then '61_90'
    else '90_plus'
  end as aging_bucket,
  case when current_date <= ar.due_date            then ar.balance else 0 end as current_amount,
  case when current_date - ar.due_date between 1 and 30  then ar.balance else 0 end as days_1_30,
  case when current_date - ar.due_date between 31 and 60 then ar.balance else 0 end as days_31_60,
  case when current_date - ar.due_date between 61 and 90 then ar.balance else 0 end as days_61_90,
  case when current_date - ar.due_date > 90        then ar.balance else 0 end as days_90_plus
from public.accounts_receivable ar
join public.customers c on c.id = ar.customer_id
where ar.status not in ('paid','void');

comment on view public.ar_aging is 'AR aging buckets. Calculated from due_date — never stored. RLS applied via base table.';
-- ============================================================
-- Migration: 0020_procurement.sql
-- Description: Suppliers, accounts payable, purchase orders,
--   goods receipts, and expenses.
-- ============================================================

-- ─────────────────────────────────────────────
-- SUPPLIERS
-- ─────────────────────────────────────────────
create table public.suppliers (
  id                  uuid    primary key default gen_random_uuid(),
  organization_id     uuid    not null references public.organizations(id) on delete restrict,
  legal_name          text    not null,
  trade_name          text,
  nit                 text,
  nrc                 text,
  contact_name        text,
  phone               text,
  email               text,
  address             text,
  payment_terms_days  int     not null default 30,
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

alter table public.suppliers enable row level security;
create index idx_suppliers_org on public.suppliers(organization_id);

create policy "suppliers_select"
  on public.suppliers for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('ap.read')
  );

create policy "suppliers_manage"
  on public.suppliers for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('finance.manage')
  );

-- ─────────────────────────────────────────────
-- ACCOUNTS PAYABLE
-- ─────────────────────────────────────────────
create table public.accounts_payable (
  id                  uuid          primary key default gen_random_uuid(),
  organization_id     uuid          not null references public.organizations(id) on delete restrict,
  supplier_id         uuid          not null references public.suppliers(id) on delete restrict,
  purchase_order_id   uuid,         -- FK added after purchase_orders
  due_date            date          not null,
  amount              numeric(10,2) not null check (amount > 0),
  balance             numeric(10,2) not null check (balance >= 0),
  status              text          not null default 'open'
                                    check (status in ('open','partial','paid','overdue','void')),
  notes               text,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now()
);

create trigger ap_updated_at
  before update on public.accounts_payable
  for each row execute function public.set_updated_at();

create index idx_ap_supplier on public.accounts_payable(supplier_id);
create index idx_ap_status_due on public.accounts_payable(status, due_date);

alter table public.accounts_payable enable row level security;

create policy "ap_select"
  on public.accounts_payable for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('ap.read')
  );

create policy "ap_manage"
  on public.accounts_payable for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('finance.manage')
  );

-- ─────────────────────────────────────────────
-- PAYABLE PAYMENTS
-- ─────────────────────────────────────────────
create table public.payable_payments (
  id                    uuid          primary key default gen_random_uuid(),
  accounts_payable_id   uuid          not null references public.accounts_payable(id) on delete restrict,
  amount                numeric(10,2) not null check (amount > 0),
  payment_method        text,
  bank_account_id       uuid,         -- FK added after bank_accounts
  reference             text,
  payment_date          date          not null default current_date,
  created_by            uuid          references public.profiles(id) on delete set null,
  created_at            timestamptz   not null default now()
);

alter table public.payable_payments enable row level security;

create policy "payable_payments_select"
  on public.payable_payments for select
  using (
    accounts_payable_id in (
      select id from public.accounts_payable
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('ap.read')
  );

-- ─────────────────────────────────────────────
-- PURCHASE ORDERS
-- ─────────────────────────────────────────────
create table public.purchase_orders (
  id              uuid          primary key default gen_random_uuid(),
  organization_id uuid          not null references public.organizations(id) on delete restrict,
  branch_id       uuid          not null references public.branches(id) on delete restrict,
  supplier_id     uuid          not null references public.suppliers(id) on delete restrict,
  po_number       text          not null unique,
  status          text          not null default 'draft'
                                check (status in ('draft','sent','confirmed','partial','received','cancelled')),
  expected_date   date,
  total_amount    numeric(10,2),
  notes           text,
  created_by      uuid          references public.profiles(id) on delete set null,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

create trigger po_updated_at
  before update on public.purchase_orders
  for each row execute function public.set_updated_at();

create index idx_po_branch on public.purchase_orders(branch_id);
create index idx_po_supplier on public.purchase_orders(supplier_id);

alter table public.purchase_orders enable row level security;

create policy "purchase_orders_select"
  on public.purchase_orders for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('inventory.purchase')
  );

create policy "purchase_orders_manage"
  on public.purchase_orders for all
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('inventory.purchase')
  );

-- ─────────────────────────────────────────────
-- PURCHASE ORDER ITEMS
-- ─────────────────────────────────────────────
create table public.purchase_order_items (
  id                    uuid          primary key default gen_random_uuid(),
  purchase_order_id     uuid          not null references public.purchase_orders(id) on delete cascade,
  product_id            uuid          not null,  -- FK added after products table
  quantity              numeric(10,3) not null check (quantity > 0),
  unit_cost             numeric(10,4) not null check (unit_cost >= 0),
  total                 numeric(10,2) not null,
  received_quantity     numeric(10,3) not null default 0
);

alter table public.purchase_order_items enable row level security;

create policy "po_items_select"
  on public.purchase_order_items for select
  using (
    purchase_order_id in (
      select id from public.purchase_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
  );

-- ─────────────────────────────────────────────
-- GOODS RECEIPTS
-- ─────────────────────────────────────────────
create table public.goods_receipts (
  id                    uuid        primary key default gen_random_uuid(),
  purchase_order_id     uuid        not null references public.purchase_orders(id) on delete restrict,
  inventory_location_id uuid        not null,  -- FK added after inventory_locations
  receipt_date          date        not null default current_date,
  notes                 text,
  received_by           uuid        references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now()
);

alter table public.goods_receipts enable row level security;

create policy "goods_receipts_select"
  on public.goods_receipts for select
  using (
    purchase_order_id in (
      select id from public.purchase_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
  );

-- ─────────────────────────────────────────────
-- GOODS RECEIPT ITEMS
-- ─────────────────────────────────────────────
create table public.goods_receipt_items (
  id                        uuid          primary key default gen_random_uuid(),
  goods_receipt_id          uuid          not null references public.goods_receipts(id) on delete cascade,
  purchase_order_item_id    uuid          not null references public.purchase_order_items(id) on delete restrict,
  product_id                uuid          not null,  -- FK added after products table
  quantity_received         numeric(10,3) not null check (quantity_received > 0),
  unit_cost                 numeric(10,4) not null
);

alter table public.goods_receipt_items enable row level security;

create policy "goods_receipt_items_select"
  on public.goods_receipt_items for select
  using (
    goods_receipt_id in (
      select id from public.goods_receipts gr
      join public.purchase_orders po on po.id = gr.purchase_order_id
      where po.branch_id in (select public.get_accessible_branch_ids())
    )
  );

-- ─────────────────────────────────────────────
-- EXPENSE CATEGORIES
-- ─────────────────────────────────────────────
create table public.expense_categories (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  name            text    not null,
  parent_id       uuid    references public.expense_categories(id) on delete set null,
  active          boolean not null default true
);

alter table public.expense_categories enable row level security;

create policy "expense_categories_select"
  on public.expense_categories for select
  using (organization_id = public.get_my_organization_id());

-- ─────────────────────────────────────────────
-- EXPENSES
-- ─────────────────────────────────────────────
create table public.expenses (
  id                  uuid          primary key default gen_random_uuid(),
  organization_id     uuid          not null references public.organizations(id) on delete restrict,
  branch_id           uuid          not null references public.branches(id) on delete restrict,
  category_id         uuid          references public.expense_categories(id) on delete set null,
  supplier_id         uuid          references public.suppliers(id) on delete set null,
  description         text          not null,
  amount              numeric(10,2) not null check (amount > 0),
  tax_amount          numeric(10,2) not null default 0,
  payment_method_id   uuid          references public.payment_methods(id) on delete set null,
  expense_date        date          not null default current_date,
  attachment_path     text,         -- storage path in Supabase Storage
  notes               text,
  status              text          not null default 'approved'
                                    check (status in ('draft','pending_approval','approved','rejected')),
  created_by          uuid          references public.profiles(id) on delete set null,
  approved_by         uuid          references public.profiles(id) on delete set null,
  created_at          timestamptz   not null default now()
);

create index idx_expenses_branch_date on public.expenses(branch_id, expense_date desc);

alter table public.expenses enable row level security;

create policy "expenses_select"
  on public.expenses for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('expenses.read')
  );

create policy "expenses_manage"
  on public.expenses for all
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('expenses.manage')
  );

-- ─────────────────────────────────────────────
-- BANK ACCOUNTS
-- ─────────────────────────────────────────────
create table public.bank_accounts (
  id              uuid          primary key default gen_random_uuid(),
  organization_id uuid          not null references public.organizations(id) on delete restrict,
  bank_name       text          not null,
  account_number  text          not null,
  account_type    text,
  currency        text          not null default 'USD',
  current_balance numeric(12,2) not null default 0,
  active          boolean       not null default true,
  created_at      timestamptz   not null default now()
);

alter table public.bank_accounts enable row level security;

create policy "bank_accounts_select"
  on public.bank_accounts for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('finance.manage')
  );

-- ─────────────────────────────────────────────
-- BANK TRANSACTIONS
-- ─────────────────────────────────────────────
create table public.bank_transactions (
  id                uuid          primary key default gen_random_uuid(),
  bank_account_id   uuid          not null references public.bank_accounts(id) on delete restrict,
  type              text          not null check (type in ('credit','debit')),
  amount            numeric(10,2) not null check (amount > 0),
  description       text,
  reference         text,
  transaction_date  date          not null,
  reconciled        boolean       not null default false,
  created_at        timestamptz   not null default now()
);

alter table public.bank_transactions enable row level security;

create policy "bank_transactions_select"
  on public.bank_transactions for select
  using (
    bank_account_id in (
      select id from public.bank_accounts
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('finance.manage')
  );

-- ─────────────────────────────────────────────
-- BANK DEPOSITS
-- ─────────────────────────────────────────────
create table public.bank_deposits (
  id                uuid          primary key default gen_random_uuid(),
  bank_account_id   uuid          not null references public.bank_accounts(id) on delete restrict,
  cash_session_id   uuid          references public.cash_sessions(id) on delete set null,
  amount            numeric(10,2) not null check (amount > 0),
  deposit_date      date          not null default current_date,
  reference         text,
  created_by        uuid          references public.profiles(id) on delete set null,
  created_at        timestamptz   not null default now()
);

alter table public.bank_deposits enable row level security;

create policy "bank_deposits_select"
  on public.bank_deposits for select
  using (
    bank_account_id in (
      select id from public.bank_accounts
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('finance.manage')
  );

-- Resolve FK from payable_payments to bank_accounts
alter table public.payable_payments
  add constraint payable_payments_bank_fk
  foreign key (bank_account_id) references public.bank_accounts(id) on delete set null;

-- ─────────────────────────────────────────────
-- SEED: Expense categories
-- ─────────────────────────────────────────────
insert into public.expense_categories (organization_id, name) values
  ('00000000-0000-0000-0000-000000000001', 'Insumos de Lavado'),
  ('00000000-0000-0000-0000-000000000001', 'Mantenimiento de Equipo'),
  ('00000000-0000-0000-0000-000000000001', 'Servicios Públicos'),
  ('00000000-0000-0000-0000-000000000001', 'Nómina y Personal'),
  ('00000000-0000-0000-0000-000000000001', 'Renta e Instalaciones'),
  ('00000000-0000-0000-0000-000000000001', 'Marketing'),
  ('00000000-0000-0000-0000-000000000001', 'Administrativo'),
  ('00000000-0000-0000-0000-000000000001', 'Otros');
-- ============================================================
-- Migration: 0021_inventory.sql
-- Description: Product catalog, inventory locations, stock,
--   movements (ledger), lots, and service consumables.
--   Stock is NEVER modified directly — always via movements.
-- ============================================================

-- ─────────────────────────────────────────────
-- PRODUCT CATEGORIES
-- ─────────────────────────────────────────────
create table public.product_categories (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  name            text    not null,
  parent_id       uuid    references public.product_categories(id) on delete set null,
  active          boolean not null default true
);

alter table public.product_categories enable row level security;

create policy "product_categories_select"
  on public.product_categories for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('inventory.read')
  );

-- ─────────────────────────────────────────────
-- PRODUCTS
-- ─────────────────────────────────────────────
create table public.products (
  id              uuid          primary key default gen_random_uuid(),
  organization_id uuid          not null references public.organizations(id) on delete restrict,
  sku             text          not null,
  barcode         text,
  name            text          not null,
  category_id     uuid          references public.product_categories(id) on delete set null,
  unit_of_measure text          not null default 'unit',  -- unit, ml, L, kg, g
  product_type    text          not null default 'consumable'
                                check (product_type in ('consumable','retail','both')),
  cost            numeric(10,4),
  sale_price      numeric(10,2),
  taxable         boolean       not null default true,
  minimum_stock   numeric(10,3) not null default 0,
  active          boolean       not null default true,
  created_at      timestamptz   not null default now(),

  constraint products_org_sku_unique unique (organization_id, sku)
);

create index idx_products_org on public.products(organization_id);
create index idx_products_category on public.products(category_id);

alter table public.products enable row level security;

create policy "products_select"
  on public.products for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('inventory.read')
  );

create policy "products_manage"
  on public.products for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('inventory.adjust')
  );

-- ─────────────────────────────────────────────
-- INVENTORY LOCATIONS (per branch)
-- ─────────────────────────────────────────────
create table public.inventory_locations (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  branch_id       uuid    not null references public.branches(id) on delete restrict,
  name            text    not null,
  code            text    not null,
  active          boolean not null default true,

  constraint inv_locations_branch_code_unique unique (branch_id, code)
);

alter table public.inventory_locations enable row level security;

create policy "inv_locations_select"
  on public.inventory_locations for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('inventory.read')
  );

-- ─────────────────────────────────────────────
-- INVENTORY STOCK (current quantity per product/location)
-- WARNING: Never UPDATE directly. Always via inventory_movements.
-- ─────────────────────────────────────────────
create table public.inventory_stock (
  id                    uuid          primary key default gen_random_uuid(),
  product_id            uuid          not null references public.products(id) on delete restrict,
  inventory_location_id uuid          not null references public.inventory_locations(id) on delete restrict,
  quantity              numeric(10,3) not null default 0,
  average_cost          numeric(10,4) not null default 0,
  last_movement_at      timestamptz,

  constraint inv_stock_product_location_unique unique (product_id, inventory_location_id),
  constraint inv_stock_non_negative check (quantity >= 0)
);

comment on table public.inventory_stock is 'Current stock levels. NEVER update directly — always use inventory_movements and the record_inventory_movement() function.';

create index idx_inv_stock_product on public.inventory_stock(product_id);
create index idx_inv_stock_location on public.inventory_stock(inventory_location_id);

alter table public.inventory_stock enable row level security;

create policy "inv_stock_select"
  on public.inventory_stock for select
  using (
    inventory_location_id in (
      select il.id from public.inventory_locations il
      where il.branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('inventory.read')
  );

-- ─────────────────────────────────────────────
-- INVENTORY LOTS
-- For products requiring lot tracking (chemicals, etc.)
-- ─────────────────────────────────────────────
create table public.inventory_lots (
  id              uuid    primary key default gen_random_uuid(),
  product_id      uuid    not null references public.products(id) on delete restrict,
  lot_number      text    not null,
  expiration_date date,
  created_at      timestamptz not null default now()
);

alter table public.inventory_lots enable row level security;

create policy "inv_lots_select"
  on public.inventory_lots for select
  using (
    product_id in (
      select id from public.products
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('inventory.read')
  );

-- ─────────────────────────────────────────────
-- INVENTORY MOVEMENTS (append-only ledger)
-- This is the source of truth for all stock changes.
-- quantity > 0 = stock in, quantity < 0 = stock out
-- ─────────────────────────────────────────────
create table public.inventory_movements (
  id                    uuid          primary key default gen_random_uuid(),
  organization_id       uuid          not null references public.organizations(id) on delete restrict,
  product_id            uuid          not null references public.products(id) on delete restrict,
  inventory_location_id uuid          not null references public.inventory_locations(id) on delete restrict,
  lot_id                uuid          references public.inventory_lots(id) on delete set null,
  movement_type         text          not null
                                      check (movement_type in ('purchase','sale','usage','transfer','adjustment','return','waste')),
  quantity              numeric(10,3) not null,  -- positive = in, negative = out
  unit_cost             numeric(10,4),
  reference_id          uuid,         -- work_order_id or purchase_order_id
  reference_type        text,         -- 'work_order', 'purchase_order', 'goods_receipt'
  notes                 text,
  created_by            uuid          references public.profiles(id) on delete set null,
  created_at            timestamptz   not null default now()
);

comment on table public.inventory_movements is 'Append-only inventory ledger. Every stock change creates a movement. Never delete.';
comment on column public.inventory_movements.quantity is 'Positive = stock in, Negative = stock out.';

create index idx_inv_movements_product on public.inventory_movements(product_id, created_at desc);
create index idx_inv_movements_location on public.inventory_movements(inventory_location_id, created_at desc);

alter table public.inventory_movements enable row level security;

create policy "inv_movements_select"
  on public.inventory_movements for select
  using (
    inventory_location_id in (
      select il.id from public.inventory_locations il
      where il.branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('inventory.read')
  );

-- ─────────────────────────────────────────────
-- RPC: Record inventory movement (atomic)
-- Creates movement + updates stock in a single transaction.
-- Prevents stock from going negative.
-- ─────────────────────────────────────────────
create or replace function public.record_inventory_movement(
  p_product_id            uuid,
  p_inventory_location_id uuid,
  p_movement_type         text,
  p_quantity              numeric,    -- positive = in, negative = out
  p_unit_cost             numeric default null,
  p_reference_id          uuid default null,
  p_reference_type        text default null,
  p_lot_id                uuid default null,
  p_notes                 text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movement_id   uuid;
  v_current_qty   numeric;
  v_org_id        uuid;
  v_new_avg_cost  numeric;
  v_current_cost  numeric;
  v_current_stock numeric;
begin
  -- Permission check
  if not public.has_permission('inventory.adjust') then
    raise exception 'Permission denied: inventory.adjust required';
  end if;

  -- Get org_id from product
  select organization_id into v_org_id
  from public.products
  where id = p_product_id;

  if v_org_id <> public.get_my_organization_id() then
    raise exception 'Access denied';
  end if;

  -- Lock the stock row
  select quantity, average_cost
  into v_current_stock, v_current_cost
  from public.inventory_stock
  where product_id = p_product_id
    and inventory_location_id = p_inventory_location_id
  for update;

  -- If no stock row yet, stock is 0
  if not found then
    v_current_stock := 0;
    v_current_cost  := 0;
  end if;

  -- Prevent negative stock for outbound movements
  if p_quantity < 0 and (v_current_stock + p_quantity) < 0 then
    raise exception 'Insufficient stock. Current: %, Requested: %', v_current_stock, abs(p_quantity);
  end if;

  -- Calculate new average cost (weighted average, only for inbound)
  if p_quantity > 0 and p_unit_cost is not null then
    v_new_avg_cost := (v_current_stock * v_current_cost + p_quantity * p_unit_cost)
                    / (v_current_stock + p_quantity);
  else
    v_new_avg_cost := v_current_cost;
  end if;

  -- Insert movement record
  insert into public.inventory_movements (
    organization_id, product_id, inventory_location_id,
    lot_id, movement_type, quantity, unit_cost,
    reference_id, reference_type, notes, created_by
  ) values (
    v_org_id, p_product_id, p_inventory_location_id,
    p_lot_id, p_movement_type, p_quantity, p_unit_cost,
    p_reference_id, p_reference_type, p_notes, auth.uid()
  )
  returning id into v_movement_id;

  -- Upsert stock row
  insert into public.inventory_stock (
    product_id, inventory_location_id, quantity, average_cost, last_movement_at
  ) values (
    p_product_id, p_inventory_location_id,
    p_quantity, coalesce(v_new_avg_cost, 0), now()
  )
  on conflict (product_id, inventory_location_id) do update
  set quantity         = inventory_stock.quantity + p_quantity,
      average_cost     = coalesce(v_new_avg_cost, inventory_stock.average_cost),
      last_movement_at = now();

  return v_movement_id;
end;
$$;

comment on function public.record_inventory_movement(uuid, uuid, text, numeric, numeric, uuid, text, uuid, text) is
  'Atomically records an inventory movement and updates stock. Prevents negative stock. Use for all stock changes.';

-- ─────────────────────────────────────────────
-- SERVICE CONSUMABLES
-- Standard consumption per service (for cost calculation)
-- ─────────────────────────────────────────────
create table public.service_consumables (
  id                  uuid          primary key default gen_random_uuid(),
  service_id          uuid          not null references public.services(id) on delete cascade,
  product_id          uuid          not null references public.products(id) on delete restrict,
  quantity_estimated  numeric(10,3) not null check (quantity_estimated > 0),
  unit_of_measure     text,
  notes               text,

  constraint service_consumables_unique unique (service_id, product_id)
);

comment on table public.service_consumables is 'Standard product consumption per service. Used for standard cost calculation and inventory planning.';

alter table public.service_consumables enable row level security;

create policy "service_consumables_select"
  on public.service_consumables for select
  using (
    service_id in (
      select id from public.services
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('inventory.read')
  );

-- ─────────────────────────────────────────────
-- Resolve FK references from purchase/goods tables
-- ─────────────────────────────────────────────
alter table public.purchase_order_items
  add constraint poi_product_fk
  foreign key (product_id) references public.products(id) on delete restrict;

alter table public.goods_receipt_items
  add constraint gri_product_fk
  foreign key (product_id) references public.products(id) on delete restrict;

alter table public.goods_receipts
  add constraint gr_location_fk
  foreign key (inventory_location_id) references public.inventory_locations(id) on delete restrict;

alter table public.accounts_payable
  add constraint ap_po_fk
  foreign key (purchase_order_id) references public.purchase_orders(id) on delete set null;

-- ─────────────────────────────────────────────
-- SEED: Inventory location for Escalón
-- ─────────────────────────────────────────────
insert into public.inventory_locations (organization_id, branch_id, name, code) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 'Bodega Principal Escalón', 'BOD-ESC-01');
-- ============================================================
-- Migration: 0022_fiscal_notifications_comms.sql
-- Description: Fiscal documents layer (decoupled from any DTE
--   provider), internal notifications, and communication
--   preferences + logs.
--
--   IMPORTANT: No DTE provider is integrated here.
--   This schema creates the correct data layer for future
--   integration. Do NOT add hardcoded Hacienda payloads.
-- ============================================================

-- ─────────────────────────────────────────────
-- INVOICES
-- Represents the billing document for a work order.
-- Status: draft → issued → (voided)
-- ─────────────────────────────────────────────
create table public.invoices (
  id              uuid          primary key default gen_random_uuid(),
  organization_id uuid          not null references public.organizations(id) on delete restrict,
  branch_id       uuid          not null references public.branches(id) on delete restrict,
  work_order_id   uuid          references public.work_orders(id) on delete restrict,
  customer_id     uuid          references public.customers(id) on delete restrict,
  invoice_type    text          not null
                                check (invoice_type in ('consumidor_final','credito_fiscal','nota_credito','nota_debito')),
  invoice_number  text          unique,    -- sequential once issued
  subtotal        numeric(10,2) not null default 0,
  tax_amount      numeric(10,2) not null default 0,
  total           numeric(10,2) not null default 0,
  status          text          not null default 'draft'
                                check (status in ('draft','issued','voided')),
  issued_at       timestamptz,
  voided_at       timestamptz,
  voided_reason   text,
  created_by      uuid          references public.profiles(id) on delete set null,
  created_at      timestamptz   not null default now()
);

comment on table public.invoices is 'Billing documents. Decoupled from DTE integration. fiscal_documents table holds provider payloads.';

create index idx_invoices_work_order on public.invoices(work_order_id);
create index idx_invoices_customer on public.invoices(customer_id);

alter table public.invoices enable row level security;

create policy "invoices_select"
  on public.invoices for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('reports.financial')
  );

-- ─────────────────────────────────────────────
-- FISCAL DOCUMENTS (DTE placeholder)
-- Will hold actual Hacienda payload/response
-- once DTE integration is specified.
-- ─────────────────────────────────────────────
create table public.fiscal_documents (
  id              uuid        primary key default gen_random_uuid(),
  invoice_id      uuid        not null unique references public.invoices(id) on delete restrict,
  document_type   text,       -- DTE type code (to be defined with Hacienda spec)
  payload         jsonb,      -- DTE request payload (populated by FiscalProvider edge function)
  response        jsonb,      -- DTE response from Hacienda
  status          text        not null default 'pending'
                              check (status in ('pending','sent','accepted','rejected','error')),
  sent_at         timestamptz,
  accepted_at     timestamptz,
  error_message   text,
  created_at      timestamptz not null default now()
);

comment on table public.fiscal_documents is 'DTE fiscal documents. payload/response populated by FiscalProvider edge function (not yet implemented). See integrations/fiscal/FiscalProvider.ts';

alter table public.fiscal_documents enable row level security;

create policy "fiscal_documents_select"
  on public.fiscal_documents for select
  using (
    invoice_id in (
      select id from public.invoices
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('reports.financial')
  );

-- Add FK from accounts_receivable to invoices
alter table public.accounts_receivable
  add constraint ar_invoice_fk
  foreign key (invoice_id) references public.invoices(id) on delete set null;

-- ─────────────────────────────────────────────
-- NOTIFICATIONS
-- Internal system notifications for users.
-- ─────────────────────────────────────────────
create table public.notifications (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete restrict,
  branch_id       uuid        references public.branches(id) on delete cascade,
  user_id         uuid        references public.profiles(id) on delete cascade,
  type            text        not null,  -- 'low_stock','cash_diff','vehicle_ready','membership_expiring','ar_overdue'
  title           text        not null,
  body            text,
  entity_type     text,         -- 'work_order','customer','product'
  entity_id       uuid,
  priority        text        not null default 'medium'
                              check (priority in ('low','medium','high','critical')),
  read            boolean     not null default false,
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index idx_notifications_user on public.notifications(user_id, read, created_at desc);
create index idx_notifications_branch on public.notifications(branch_id, read, created_at desc);

alter table public.notifications enable row level security;

-- Users can only see their own notifications or branch-wide ones
create policy "notifications_select_own"
  on public.notifications for select
  using (
    organization_id = public.get_my_organization_id()
    and (
      user_id = auth.uid()
      or (user_id is null and branch_id in (select public.get_accessible_branch_ids()))
    )
  );

create policy "notifications_update_own"
  on public.notifications for update
  using (user_id = auth.uid());

-- ─────────────────────────────────────────────
-- COMMUNICATION PREFERENCES
-- ─────────────────────────────────────────────
create table public.communication_preferences (
  id              uuid    primary key default gen_random_uuid(),
  customer_id     uuid    not null references public.customers(id) on delete cascade,
  channel         text    not null check (channel in ('whatsapp','email','sms')),
  enabled         boolean not null default true,
  contact_value   text    not null,  -- phone or email for this channel
  created_at      timestamptz not null default now()
);

alter table public.communication_preferences enable row level security;
create index idx_comm_prefs_customer on public.communication_preferences(customer_id);

create policy "comm_prefs_select"
  on public.communication_preferences for select
  using (
    customer_id in (
      select id from public.customers
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('customers.read')
  );

-- ─────────────────────────────────────────────
-- COMMUNICATION LOGS
-- All outbound/inbound messages are logged.
-- Actual sending is done via MessagingProvider edge function.
-- TODO(security): Ensure message payloads don't contain sensitive PII beyond what's needed
-- ─────────────────────────────────────────────
create table public.communication_logs (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete restrict,
  customer_id     uuid        references public.customers(id) on delete set null,
  channel         text        not null check (channel in ('whatsapp','email','sms')),
  template        text,       -- template identifier used
  direction       text        not null check (direction in ('outbound','inbound')),
  status          text        not null default 'pending'
                              check (status in ('pending','sent','delivered','failed')),
  provider        text,       -- 'twilio', 'sendgrid', etc. (abstraction)
  external_id     text,       -- provider's message ID
  payload         jsonb,      -- message content (sanitized — no passwords/tokens)
  sent_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index idx_comm_logs_customer on public.communication_logs(customer_id, created_at desc);

alter table public.communication_logs enable row level security;

create policy "comm_logs_select"
  on public.communication_logs for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('customers.read')
  );
