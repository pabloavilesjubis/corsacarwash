-- ============================================================
-- Migration: 0023_audit.sql
-- Description: Centralized audit log with automatic triggers
--   for all critical tables. Append-only, never modified.
-- ============================================================

create table public.audit_logs (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        references public.organizations(id) on delete set null,
  branch_id       uuid        references public.branches(id) on delete set null,
  user_id         uuid        references public.profiles(id) on delete set null,
  action          text        not null,    -- 'INSERT','UPDATE','DELETE', custom actions
  entity_type     text        not null,    -- table name
  entity_id       uuid        not null,
  old_data        jsonb,                   -- previous state (for UPDATE/DELETE)
  new_data        jsonb,                   -- new state (for INSERT/UPDATE)
  ip_address      inet,                    -- client IP if available
  user_agent      text,
  created_at      timestamptz not null default now()
);

comment on table public.audit_logs is 'Immutable audit trail. Never update or delete. Triggers write here automatically for critical tables.';

create index idx_audit_entity on public.audit_logs(entity_type, entity_id);
create index idx_audit_user on public.audit_logs(user_id, created_at desc);
create index idx_audit_org on public.audit_logs(organization_id, created_at desc);
create index idx_audit_action on public.audit_logs(action, entity_type, created_at desc);

-- Audit logs are readable only (no insert policy via RLS — triggers write with security definer)
alter table public.audit_logs enable row level security;

create policy "audit_logs_select"
  on public.audit_logs for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('reports.financial')
  );

-- ─────────────────────────────────────────────
-- AUDIT TRIGGER FUNCTION
-- Used by triggers on critical tables
-- ─────────────────────────────────────────────
create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_id     uuid;
  v_org_id        uuid;
  v_branch_id     uuid;
  v_old           jsonb;
  v_new           jsonb;
begin
  -- Extract entity ID
  v_entity_id := case tg_op
    when 'DELETE' then (row_to_json(old)::jsonb->>'id')::uuid
    else (row_to_json(new)::jsonb->>'id')::uuid
  end;

  -- Extract org/branch if present
  v_org_id := case tg_op
    when 'DELETE' then (row_to_json(old)::jsonb->>'organization_id')::uuid
    else (row_to_json(new)::jsonb->>'organization_id')::uuid
  end;

  v_branch_id := case tg_op
    when 'DELETE' then (row_to_json(old)::jsonb->>'branch_id')::uuid
    else (row_to_json(new)::jsonb->>'branch_id')::uuid
  end;

  -- Build old/new data (exclude irrelevant high-churn fields for storage efficiency)
  v_old := case when tg_op in ('UPDATE','DELETE') then row_to_json(old)::jsonb else null end;
  v_new := case when tg_op in ('INSERT','UPDATE') then row_to_json(new)::jsonb else null end;

  insert into public.audit_logs (
    organization_id, branch_id, user_id,
    action, entity_type, entity_id,
    old_data, new_data
  ) values (
    v_org_id,
    v_branch_id,
    auth.uid(),
    tg_op,
    tg_table_name,
    v_entity_id,
    v_old,
    v_new
  );

  return null;  -- after trigger, return value ignored
end;
$$;

-- ─────────────────────────────────────────────
-- Apply audit triggers to critical tables
-- ─────────────────────────────────────────────

-- Work orders (all operations)
create trigger audit_work_orders
  after insert or update or delete on public.work_orders
  for each row execute function public.write_audit_log();

-- Payments (all operations)
create trigger audit_payments
  after insert or update or delete on public.payments
  for each row execute function public.write_audit_log();

-- Service prices (changes only — track price history)
create trigger audit_service_prices
  after insert or update or delete on public.service_prices
  for each row execute function public.write_audit_log();

-- Cash sessions
create trigger audit_cash_sessions
  after insert or update or delete on public.cash_sessions
  for each row execute function public.write_audit_log();

-- Customer memberships
create trigger audit_customer_memberships
  after insert or update or delete on public.customer_memberships
  for each row execute function public.write_audit_log();

-- Corporate accounts (credit changes)
create trigger audit_corporate_accounts
  after insert or update or delete on public.corporate_accounts
  for each row execute function public.write_audit_log();

-- Inventory movements
create trigger audit_inventory_movements
  after insert on public.inventory_movements
  for each row execute function public.write_audit_log();

-- Work order discounts
create trigger audit_wo_discounts
  after insert or update on public.work_order_discounts
  for each row execute function public.write_audit_log();

-- Roles and permissions (RBAC changes)
create trigger audit_user_roles
  after insert or delete on public.user_roles
  for each row execute function public.write_audit_log();

-- Vehicle ownership transfers
create trigger audit_vehicle_ownership
  after insert or update on public.vehicle_ownership_history
  for each row execute function public.write_audit_log();
