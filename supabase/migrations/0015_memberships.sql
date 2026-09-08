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

  insert into public.membership_plan_benefits (plan_id, service_id, unlimited, discount_percentage, quantity_per_period)
  select v_plan_basic, id, false, 10, 4
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
