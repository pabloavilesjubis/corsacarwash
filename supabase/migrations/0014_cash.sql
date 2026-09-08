-- ============================================================
-- Migration: 0014_cash.sql
-- Description: Cash registers, sessions, and movements.
--   Every cash transaction is logged. Closing requires
--   counting and justification for differences above tolerance.
-- ============================================================

-- ─────────────────────────────────────────────
-- CASH REGISTERS
-- ─────────────────────────────────────────────
create table public.cash_registers (
  id          uuid    primary key default gen_random_uuid(),
  branch_id   uuid    not null references public.branches(id) on delete restrict,
  name        text    not null,
  code        text    not null,
  active      boolean not null default true,

  constraint cash_registers_branch_code_unique unique (branch_id, code)
);

alter table public.cash_registers enable row level security;

create policy "cash_registers_select"
  on public.cash_registers for select
  using (
    branch_id in (select public.get_accessible_branch_ids())
    and public.has_permission('cash.open')
  );

-- ─────────────────────────────────────────────
-- CASH SESSIONS (Turnos de caja)
-- ─────────────────────────────────────────────
create table public.cash_sessions (
  id                  uuid          primary key default gen_random_uuid(),
  cash_register_id    uuid          not null references public.cash_registers(id) on delete restrict,
  opened_at           timestamptz   not null default now(),
  opened_by           uuid          not null references public.profiles(id) on delete restrict,
  opening_amount      numeric(10,2) not null default 0 check (opening_amount >= 0),
  closed_at           timestamptz,
  closed_by           uuid          references public.profiles(id) on delete set null,
  expected_cash       numeric(10,2),          -- calculated sum of all cash movements
  counted_cash        numeric(10,2),          -- actual cash counted at close
  difference          numeric(10,2),          -- counted - expected (negative = short)
  justification       text,                   -- required if |difference| > tolerance
  approved_by         uuid          references public.profiles(id) on delete set null,
  status              text          not null default 'open'
                                    check (status in ('open','closed','pending_approval'))
);

comment on table public.cash_sessions is 'A cash session (turn) per register. Closing validates counted vs expected.';

create index idx_cash_sessions_register on public.cash_sessions(cash_register_id);
create index idx_cash_sessions_status on public.cash_sessions(cash_register_id, status);

alter table public.cash_sessions enable row level security;

create policy "cash_sessions_select"
  on public.cash_sessions for select
  using (
    cash_register_id in (
      select cr.id from public.cash_registers cr
      where cr.branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('cash.open')
  );

-- ─────────────────────────────────────────────
-- CASH MOVEMENTS
-- Every cash transaction creates a movement record.
-- This is an append-only ledger.
-- ─────────────────────────────────────────────
create table public.cash_movements (
  id                uuid          primary key default gen_random_uuid(),
  cash_session_id   uuid          not null references public.cash_sessions(id) on delete restrict,
  type              text          not null
                                  check (type in ('sale','cash_in','cash_out','refund','adjustment','deposit')),
  amount            numeric(10,2) not null,   -- positive = cash in, negative = cash out
  reference_id      uuid,                     -- work_order_id, payment_id, etc.
  reference_type    text,                     -- 'work_order', 'payment', 'expense'
  description       text          not null,
  created_by        uuid          references public.profiles(id) on delete set null,
  created_at        timestamptz   not null default now()
);

comment on table public.cash_movements is 'Append-only cash ledger. Never delete or update. Closing session calculates expected_cash from this.';

create index idx_cash_movements_session on public.cash_movements(cash_session_id);
create index idx_cash_movements_created on public.cash_movements(cash_session_id, created_at);

alter table public.cash_movements enable row level security;

create policy "cash_movements_select"
  on public.cash_movements for select
  using (
    cash_session_id in (
      select cs.id from public.cash_sessions cs
      join public.cash_registers cr on cr.id = cs.cash_register_id
      where cr.branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('cash.open')
  );

-- ─────────────────────────────────────────────
-- RPC: Open cash session
-- ─────────────────────────────────────────────
create or replace function public.open_cash_session(
  p_cash_register_id uuid,
  p_opening_amount   numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_branch_id  uuid;
begin
  if not public.has_permission('cash.open') then
    raise exception 'Permission denied: cash.open required';
  end if;

  -- Get branch for this register
  select branch_id into v_branch_id
  from public.cash_registers
  where id = p_cash_register_id and active = true;

  if not found then
    raise exception 'Cash register not found or inactive';
  end if;

  if v_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Access denied to this branch';
  end if;

  -- Check no open session exists for this register
  if exists (
    select 1 from public.cash_sessions
    where cash_register_id = p_cash_register_id
      and status = 'open'
  ) then
    raise exception 'There is already an open session for this register';
  end if;

  insert into public.cash_sessions (
    cash_register_id, opened_by, opening_amount, status
  ) values (
    p_cash_register_id, auth.uid(), p_opening_amount, 'open'
  )
  returning id into v_session_id;

  -- Record opening movement
  insert into public.cash_movements (
    cash_session_id, type, amount, description, created_by
  ) values (
    v_session_id, 'cash_in', p_opening_amount, 'Apertura de caja', auth.uid()
  );

  return v_session_id;
end;
$$;

-- ─────────────────────────────────────────────
-- RPC: Close cash session (transactional)
-- Calculates expected, records difference, requires
-- justification if difference exceeds tolerance.
-- TODO(security): Make tolerance configurable per org instead of hardcoded $1.00
-- ─────────────────────────────────────────────
create or replace function public.close_cash_session(
  p_session_id    uuid,
  p_counted_cash  numeric,
  p_justification text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session       record;
  v_expected      numeric(10,2);
  v_difference    numeric(10,2);
  v_tolerance     numeric(10,2) := 1.00;  -- TODO(security): make configurable per org
  v_new_status    text;
begin
  if not public.has_permission('cash.close') then
    raise exception 'Permission denied: cash.close required';
  end if;

  -- Lock the session
  select * into v_session
  from public.cash_sessions
  where id = p_session_id and status = 'open'
  for update;

  if not found then
    raise exception 'Session not found or already closed';
  end if;

  -- Calculate expected cash from movements
  select coalesce(sum(amount), 0) into v_expected
  from public.cash_movements
  where cash_session_id = p_session_id;

  v_difference := p_counted_cash - v_expected;

  -- Require justification if difference exceeds tolerance
  if abs(v_difference) > v_tolerance and p_justification is null then
    raise exception 'Justification required: difference of % exceeds tolerance of %',
      v_difference, v_tolerance;
  end if;

  -- Determine status
  if abs(v_difference) > v_tolerance then
    v_new_status := 'pending_approval';  -- requires supervisor approval
  else
    v_new_status := 'closed';
  end if;

  -- Update session
  update public.cash_sessions
  set closed_at     = now(),
      closed_by     = auth.uid(),
      expected_cash = v_expected,
      counted_cash  = p_counted_cash,
      difference    = v_difference,
      justification = p_justification,
      status        = v_new_status
  where id = p_session_id;

  return jsonb_build_object(
    'session_id',   p_session_id,
    'expected',     v_expected,
    'counted',      p_counted_cash,
    'difference',   v_difference,
    'status',       v_new_status,
    'needs_approval', (v_new_status = 'pending_approval')
  );
end;
$$;

comment on function public.close_cash_session(uuid, numeric, text) is
  'Closes a cash session. Calculates expected vs counted. Requires justification if difference > tolerance.';

-- ─────────────────────────────────────────────
-- SEED: Cash register for Escalón
-- ─────────────────────────────────────────────
insert into public.cash_registers (branch_id, name, code) values
  ('00000000-0000-0000-0001-000000000001', 'Caja Principal Escalón', 'CAJA-01');
