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
