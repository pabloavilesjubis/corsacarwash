-- ============================================================
-- Migration: 0013_payments.sql
-- Description: Payment methods, payments, payment allocations,
--   and tips. Supports split (mixed) payments.
--   Financial mutations go through register_payment() RPC.
-- ============================================================

-- ─────────────────────────────────────────────
-- PAYMENT METHODS
-- ─────────────────────────────────────────────
create table public.payment_methods (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  branch_id       uuid    references public.branches(id) on delete cascade,  -- null = all branches
  code            text    not null,
  name            text    not null,
  type            text    not null check (type in ('cash','card','bank_transfer','corporate_credit','membership','coupon','other')),
  requires_reference boolean not null default false,
  active          boolean not null default true,
  sort_order      int     not null default 0,

  constraint payment_methods_org_code_unique unique (organization_id, code)
);

alter table public.payment_methods enable row level security;

create policy "payment_methods_select"
  on public.payment_methods for select
  using (organization_id = public.get_my_organization_id());

create policy "payment_methods_manage"
  on public.payment_methods for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- PAYMENTS
-- ─────────────────────────────────────────────
create table public.payments (
  id                  uuid          primary key default gen_random_uuid(),
  organization_id     uuid          not null references public.organizations(id) on delete restrict,
  branch_id           uuid          not null references public.branches(id) on delete restrict,
  payment_method_id   uuid          not null references public.payment_methods(id) on delete restrict,
  amount              numeric(10,2) not null check (amount > 0),
  amount_tendered     numeric(10,2),            -- for cash: amount given by customer
  change_given        numeric(10,2),            -- for cash: change returned (not income)
  currency            text          not null default 'USD',
  status              text          not null default 'approved'
                                    check (status in ('pending','approved','rejected','voided','refunded')),
  provider            text,                     -- 'cash', 'terminal_credomatic', etc. (abstraction)
  external_reference  text,                     -- terminal receipt number, bank transfer ref
  authorization_code  text,                     -- card auth code (NEVER store full card number)
  idempotency_key     text          unique,      -- for safe retries
  received_by         uuid          references public.profiles(id) on delete set null,
  created_at          timestamptz   not null default now(),
  voided_at           timestamptz,
  voided_by           uuid          references public.profiles(id) on delete set null,
  void_reason         text,

  -- Integrity: change only makes sense for cash and must not exceed tendered
  constraint payments_cash_change_check check (
    change_given is null
    or (amount_tendered is not null and change_given = amount_tendered - amount)
  )
);

comment on table public.payments is 'Individual payment transactions. One order can have multiple payments (split payment).';
comment on column public.payments.authorization_code is 'Card authorization code only. NEVER store full card number (PCI compliance).';
comment on column public.payments.idempotency_key is 'Use for safe retries. Prevents double-charging on network errors.';

create index idx_payments_branch_created on public.payments(branch_id, created_at desc);
create index idx_payments_status on public.payments(branch_id, status);

alter table public.payments enable row level security;

create policy "payments_select"
  on public.payments for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('payments.create')  -- at minimum need payment perm to see
  );

-- Payments are written only via register_payment() RPC (security definer)

-- ─────────────────────────────────────────────
-- PAYMENT ALLOCATIONS
-- Links payments to work orders (or future invoices)
-- Enables split payment across multiple orders eventually
-- ─────────────────────────────────────────────
create table public.payment_allocations (
  id              uuid          primary key default gen_random_uuid(),
  payment_id      uuid          not null references public.payments(id) on delete restrict,
  work_order_id   uuid          references public.work_orders(id) on delete restrict,
  invoice_id      uuid,         -- FK reserved for future invoices table
  amount          numeric(10,2) not null check (amount > 0),
  created_at      timestamptz   not null default now()
);

comment on table public.payment_allocations is 'Links payments to work orders. An order is paid when sum(allocations) >= order.total.';

create index idx_payment_allocations_payment on public.payment_allocations(payment_id);
create index idx_payment_allocations_order on public.payment_allocations(work_order_id);

alter table public.payment_allocations enable row level security;

create policy "payment_allocations_select"
  on public.payment_allocations for select
  using (
    payment_id in (
      select id from public.payments
      where branch_id in (select public.get_accessible_branch_ids())
    )
  );

-- ─────────────────────────────────────────────
-- TIPS
-- ─────────────────────────────────────────────
create table public.tips (
  id                  uuid          primary key default gen_random_uuid(),
  work_order_id       uuid          not null references public.work_orders(id) on delete restrict,
  payment_id          uuid          references public.payments(id) on delete set null,
  amount              numeric(10,2) not null check (amount > 0),
  distribution_type   text          not null default 'pool'
                                    check (distribution_type in ('single','pool','split')),
  notes               text,
  created_at          timestamptz   not null default now()
);

comment on table public.tips is 'Tips are tracked separately from revenue. Not included in order.total.';

alter table public.tips enable row level security;
create index idx_tips_work_order on public.tips(work_order_id);

create policy "tips_select"
  on public.tips for select
  using (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
  );

-- ─────────────────────────────────────────────
-- TIP DISTRIBUTIONS (to employees)
-- ─────────────────────────────────────────────
create table public.tip_distributions (
  id          uuid          primary key default gen_random_uuid(),
  tip_id      uuid          not null references public.tips(id) on delete cascade,
  employee_id uuid          not null,    -- FK added in 0018
  amount      numeric(10,2) not null check (amount > 0)
);

alter table public.tip_distributions enable row level security;

create policy "tip_distributions_select"
  on public.tip_distributions for select
  using (
    tip_id in (
      select t.id from public.tips t
      join public.work_orders wo on wo.id = t.work_order_id
      where wo.branch_id in (select public.get_accessible_branch_ids())
    )
  );

-- ─────────────────────────────────────────────
-- RPC: register_payment (transactional)
-- Processes one or more payments for a work order.
-- Handles split payment: cash + card, etc.
-- Updates order payment_status when fully paid.
-- ─────────────────────────────────────────────
create or replace function public.register_payment(
  p_work_order_id uuid,
  p_payments      jsonb,     -- [{payment_method_id, amount, amount_tendered?, external_reference?, authorization_code?, idempotency_key?}]
  p_tip_amount    numeric default 0,
  p_cash_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order         record;
  v_payment_item  jsonb;
  v_payment_id    uuid;
  v_pm            record;
  v_total_paid    numeric(10,2) := 0;
  v_already_paid  numeric(10,2) := 0;
  v_remaining     numeric(10,2);
  v_alloc_amount  numeric(10,2);
  v_tip_id        uuid;
  v_payment_ids   uuid[] := '{}';
begin
  -- Permission check
  if not public.has_permission('payments.create') then
    raise exception 'Permission denied: payments.create required';
  end if;

  -- Get and lock the work order
  select * into v_order
  from public.work_orders
  where id = p_work_order_id
  for update;

  if not found then
    raise exception 'Work order not found';
  end if;

  -- Branch access check
  if v_order.branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Access denied to this order';
  end if;

  -- Order must not be cancelled
  if v_order.status = 'cancelled' then
    raise exception 'Cannot pay a cancelled order';
  end if;

  -- Calculate already paid amount
  select coalesce(sum(pa.amount), 0) into v_already_paid
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  where pa.work_order_id = p_work_order_id
    and p.status = 'approved';

  v_remaining := v_order.total - v_already_paid;

  -- Process each payment
  for v_payment_item in select * from jsonb_array_elements(p_payments)
  loop
    -- Get payment method details
    select * into v_pm
    from public.payment_methods
    where id = (v_payment_item->>'payment_method_id')::uuid;

    if not found then
      raise exception 'Payment method not found';
    end if;

    -- Insert payment
    insert into public.payments (
      organization_id, branch_id, payment_method_id,
      amount, amount_tendered, change_given,
      currency, status, provider,
      external_reference, authorization_code,
      idempotency_key, received_by
    ) values (
      v_order.organization_id,
      v_order.branch_id,
      v_pm.id,
      (v_payment_item->>'amount')::numeric,
      (v_payment_item->>'amount_tendered')::numeric,
      case
        when v_pm.type = 'cash' and v_payment_item->>'amount_tendered' is not null
          then (v_payment_item->>'amount_tendered')::numeric - (v_payment_item->>'amount')::numeric
        else null
      end,
      'USD', 'approved', v_pm.type,
      v_payment_item->>'external_reference',
      v_payment_item->>'authorization_code',
      v_payment_item->>'idempotency_key',
      auth.uid()
    )
    returning id into v_payment_id;

    v_payment_ids := array_append(v_payment_ids, v_payment_id);

    -- Calculate allocation (cap at remaining balance)
    v_alloc_amount := least((v_payment_item->>'amount')::numeric, v_remaining);

    -- Create payment allocation
    insert into public.payment_allocations (payment_id, work_order_id, amount)
    values (v_payment_id, p_work_order_id, v_alloc_amount);

    v_total_paid := v_total_paid + v_alloc_amount;
    v_remaining  := v_remaining - v_alloc_amount;

    -- Record cash movement if we have a session
    if p_cash_session_id is not null and v_pm.type = 'cash' then
      insert into public.cash_movements (
        cash_session_id, type, amount, reference_id, description, created_by
      ) values (
        p_cash_session_id, 'sale',
        (v_payment_item->>'amount')::numeric,
        p_work_order_id,
        'Pago orden ' || v_order.order_number,
        auth.uid()
      );
    end if;
  end loop;

  -- Record tip
  if p_tip_amount > 0 then
    insert into public.tips (work_order_id, amount, distribution_type)
    values (p_work_order_id, p_tip_amount, 'pool')
    returning id into v_tip_id;

    -- Update order tip total
    update public.work_orders
    set tip_total = tip_total + p_tip_amount
    where id = p_work_order_id;
  end if;

  -- Update order payment status
  declare
    v_new_paid_total numeric(10,2);
  begin
    select coalesce(sum(pa.amount), 0) into v_new_paid_total
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
    where pa.work_order_id = p_work_order_id
      and p.status = 'approved';

    update public.work_orders
    set payment_status = case
          when v_new_paid_total >= total then 'paid'
          when v_new_paid_total > 0 then 'partial'
          else 'pending'
        end,
        status = case
          when v_new_paid_total >= total and status not in ('delivered','cancelled') then 'paid'
          else status
        end,
        updated_by = auth.uid()
    where id = p_work_order_id;
  end;

  return jsonb_build_object(
    'payment_ids', v_payment_ids,
    'total_paid', v_total_paid,
    'remaining', greatest(v_remaining, 0),
    'tip_id', v_tip_id
  );
end;
$$;

comment on function public.register_payment(uuid, jsonb, numeric, uuid) is
  'Atomically registers one or more payments (split payment). Updates order payment_status. Logs cash movements.';

-- ─────────────────────────────────────────────
-- SEED: Payment methods for CORSA Escalón
-- ─────────────────────────────────────────────
insert into public.payment_methods (organization_id, code, name, type, requires_reference, sort_order) values
  ('00000000-0000-0000-0000-000000000001', 'CASH',     'Efectivo',             'cash',             false, 1),
  ('00000000-0000-0000-0000-000000000001', 'CARD',     'Tarjeta',              'card',             true,  2),
  ('00000000-0000-0000-0000-000000000001', 'TRANSFER', 'Transferencia Bancaria','bank_transfer',   true,  3),
  ('00000000-0000-0000-0000-000000000001', 'CORP',     'Crédito Corporativo',  'corporate_credit', false, 4),
  ('00000000-0000-0000-0000-000000000001', 'MEMBER',   'Membresía',            'membership',       false, 5),
  ('00000000-0000-0000-0000-000000000001', 'COUPON',   'Cupón',                'coupon',           true,  6);
