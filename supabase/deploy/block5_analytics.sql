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
-- ============================================================
-- Migration: 0024_indexes.sql
-- Description: Additional performance indexes for common
--   query patterns in the CORSA system.
--   Basic indexes are created inline in each table migration.
--   This file adds composite and specialized indexes.
-- ============================================================

-- ── WORK ORDERS ───────────────────────────────────────────────
-- Orders by date range for daily reports
create index if not exists idx_wo_branch_date_status
  on public.work_orders(branch_id, created_at desc, status);

-- Orders awaiting payment (for POS view)
create index if not exists idx_wo_payment_pending
  on public.work_orders(branch_id, payment_status)
  where payment_status in ('pending','partial');

-- Active (non-cancelled, non-delivered) orders
create index if not exists idx_wo_active
  on public.work_orders(branch_id, status)
  where status not in ('delivered','cancelled','paid');

-- ── PAYMENTS ──────────────────────────────────────────────────
-- Daily payment totals
create index if not exists idx_payments_branch_method_date
  on public.payments(branch_id, payment_method_id, created_at desc)
  where status = 'approved';

-- ── CUSTOMERS ─────────────────────────────────────────────────
-- Full name search (generated expression)
create index if not exists idx_customers_last_first
  on public.customers(organization_id, last_name, first_name)
  where customer_type = 'individual' and active = true;

-- Company name search
create index if not exists idx_customers_company_name
  on public.customers(organization_id, legal_name)
  where customer_type = 'company' and active = true;

-- ── VEHICLES ──────────────────────────────────────────────────
-- Plate lookup (most common search)
create index if not exists idx_vehicles_plate_active
  on public.vehicles(organization_id, normalized_plate)
  where active = true;

-- ── SERVICE PRICES ────────────────────────────────────────────
-- Price lookup: active prices by service + vehicle type
create index if not exists idx_prices_service_type_active
  on public.service_prices(service_id, vehicle_type_id, effective_from desc)
  where active = true;

-- ── MEMBERSHIPS ───────────────────────────────────────────────
-- Expiring memberships (for notifications/renewal)
create index if not exists idx_memberships_expiring
  on public.customer_memberships(expires_at, status)
  where status = 'active';

-- ── ACCOUNTS RECEIVABLE ───────────────────────────────────────
-- Overdue AR by org
create index if not exists idx_ar_overdue
  on public.accounts_receivable(organization_id, due_date, balance)
  where status in ('open','partial','overdue');

-- ── ACCOUNTS PAYABLE ──────────────────────────────────────────
create index if not exists idx_ap_overdue
  on public.accounts_payable(organization_id, due_date, balance)
  where status in ('open','partial','overdue');

-- ── INVENTORY ─────────────────────────────────────────────────
-- Products below minimum stock
create index if not exists idx_inv_below_min
  on public.inventory_stock(product_id, quantity);

-- ── AUDIT LOGS ────────────────────────────────────────────────
-- Recent audit activity
create index if not exists idx_audit_recent
  on public.audit_logs(organization_id, created_at desc)
  where created_at > now() - interval '90 days';

-- Cash movements by session
create index if not exists idx_cash_mvt_session_type
  on public.cash_movements(cash_session_id, type, created_at);

-- ── ORDER STATUS HISTORY ──────────────────────────────────────
-- For calculating time-in-status KPIs
create index if not exists idx_wo_status_hist_order_status
  on public.work_order_status_history(work_order_id, new_status, changed_at);
-- ============================================================
-- Migration: 0025_analytics_views.sql
-- Description: Views and RPCs for KPIs, business intelligence,
--   dashboards, and operational metrics.
--   No data is duplicated — all calculations are real-time.
-- ============================================================

-- ─────────────────────────────────────────────
-- VIEW: Daily sales summary by branch
-- ─────────────────────────────────────────────
create or replace view public.v_daily_sales as
select
  wo.branch_id,
  b.name as branch_name,
  date_trunc('day', wo.created_at at time zone 'America/El_Salvador') as sale_date,
  count(*) filter (where wo.status not in ('cancelled')) as total_orders,
  count(*) filter (where wo.status = 'delivered') as completed_orders,
  count(*) filter (where wo.status = 'cancelled') as cancelled_orders,
  coalesce(sum(wo.total) filter (where wo.status not in ('cancelled')), 0) as gross_revenue,
  coalesce(sum(wo.discount_total) filter (where wo.status not in ('cancelled')), 0) as total_discounts,
  coalesce(sum(wo.tax_total) filter (where wo.status not in ('cancelled')), 0) as total_tax,
  coalesce(sum(wo.tip_total), 0) as total_tips,
  case
    when count(*) filter (where wo.status not in ('cancelled')) > 0
    then round(sum(wo.total) filter (where wo.status not in ('cancelled'))
         / count(*) filter (where wo.status not in ('cancelled')), 2)
    else 0
  end as avg_ticket
from public.work_orders wo
join public.branches b on b.id = wo.branch_id
group by wo.branch_id, b.name,
         date_trunc('day', wo.created_at at time zone 'America/El_Salvador');

comment on view public.v_daily_sales is 'Daily sales aggregates per branch. Time-zoned to America/El_Salvador.';

-- ─────────────────────────────────────────────
-- VIEW: Hourly sales heatmap
-- ─────────────────────────────────────────────
create or replace view public.v_sales_heatmap as
select
  wo.branch_id,
  extract(dow from wo.created_at at time zone 'America/El_Salvador')::int as day_of_week,
  to_char(wo.created_at at time zone 'America/El_Salvador', 'Day') as day_name,
  extract(hour from wo.created_at at time zone 'America/El_Salvador')::int as hour_of_day,
  count(*) as order_count,
  coalesce(sum(wo.total), 0) as revenue
from public.work_orders wo
where wo.status not in ('cancelled')
group by wo.branch_id,
         extract(dow from wo.created_at at time zone 'America/El_Salvador'),
         to_char(wo.created_at at time zone 'America/El_Salvador', 'Day'),
         extract(hour from wo.created_at at time zone 'America/El_Salvador');

-- ─────────────────────────────────────────────
-- VIEW: Payment method breakdown
-- ─────────────────────────────────────────────
create or replace view public.v_payment_method_summary as
select
  p.branch_id,
  pm.code as method_code,
  pm.name as method_name,
  pm.type as method_type,
  date_trunc('day', p.created_at at time zone 'America/El_Salvador') as payment_date,
  count(*) as payment_count,
  sum(p.amount) as total_amount
from public.payments p
join public.payment_methods pm on pm.id = p.payment_method_id
where p.status = 'approved'
group by p.branch_id, pm.code, pm.name, pm.type,
         date_trunc('day', p.created_at at time zone 'America/El_Salvador');

-- ─────────────────────────────────────────────
-- VIEW: Service performance
-- ─────────────────────────────────────────────
create or replace view public.v_service_performance as
select
  wo.branch_id,
  woi.service_id,
  s.code as service_code,
  s.name as service_name,
  sc.name as category_name,
  date_trunc('month', wo.created_at at time zone 'America/El_Salvador') as month,
  count(*) as times_sold,
  sum(woi.quantity) as total_quantity,
  sum(woi.total) as total_revenue,
  round(avg(woi.unit_price), 2) as avg_price,
  sum(woi.discount_amount) as total_discounts
from public.work_order_items woi
join public.work_orders wo on wo.id = woi.work_order_id
join public.services s on s.id = woi.service_id
left join public.service_categories sc on sc.id = s.category_id
where wo.status not in ('cancelled')
group by wo.branch_id, woi.service_id, s.code, s.name, sc.name,
         date_trunc('month', wo.created_at at time zone 'America/El_Salvador');

-- ─────────────────────────────────────────────
-- VIEW: Order time-in-status KPIs
-- ─────────────────────────────────────────────
create or replace view public.v_order_timing as
select
  wo.id as work_order_id,
  wo.branch_id,
  wo.order_number,
  wo.status,
  wo.created_at,
  wo.checked_in_at,
  wo.started_at,
  wo.ready_at,
  wo.delivered_at,
  -- Time from arrival to service start (wait time)
  extract(epoch from (wo.started_at - wo.checked_in_at))/60 as wait_minutes,
  -- Time from service start to ready (service time)
  extract(epoch from (wo.ready_at - wo.started_at))/60 as service_minutes,
  -- Total time in facility
  extract(epoch from (coalesce(wo.delivered_at, now()) - wo.checked_in_at))/60 as total_minutes
from public.work_orders wo
where wo.checked_in_at is not null;

-- ─────────────────────────────────────────────
-- VIEW: Customer metrics
-- ─────────────────────────────────────────────
create or replace view public.v_customer_metrics as
select
  c.id as customer_id,
  c.organization_id,
  c.customer_type,
  case
    when c.customer_type = 'individual'
    then trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))
    else coalesce(c.trade_name, c.legal_name)
  end as display_name,
  c.phone,
  c.email,
  count(wo.id) as total_orders,
  coalesce(sum(wo.total) filter (where wo.status not in ('cancelled')), 0) as lifetime_value,
  max(wo.created_at) as last_visit_at,
  min(wo.created_at) as first_visit_at,
  current_date - max(wo.created_at)::date as days_since_last_visit,
  case
    when count(wo.id) = 0 then null
    else round(
      extract(epoch from (max(wo.created_at) - min(wo.created_at)))
      / nullif(count(wo.id) - 1, 0) / 86400
    )
  end as avg_days_between_visits
from public.customers c
left join public.work_orders wo on wo.customer_id = c.id
  and wo.status not in ('cancelled')
where c.active = true
group by c.id, c.organization_id, c.customer_type, c.first_name, c.last_name,
         c.trade_name, c.legal_name, c.phone, c.email;

-- ─────────────────────────────────────────────
-- RPC: Get dashboard KPIs for a branch and date
-- ─────────────────────────────────────────────
create or replace function public.get_dashboard_kpis(
  p_branch_id uuid,
  p_date      date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today       jsonb;
  v_yesterday   jsonb;
  v_open_orders jsonb;
begin
  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Access denied';
  end if;

  if not public.has_permission('reports.sales') then
    raise exception 'Permission denied: reports.sales required';
  end if;

  -- Today's stats
  select jsonb_build_object(
    'total_orders', count(*) filter (where status not in ('cancelled')),
    'completed_orders', count(*) filter (where status = 'delivered'),
    'cancelled_orders', count(*) filter (where status = 'cancelled'),
    'gross_revenue', coalesce(sum(total) filter (where status not in ('cancelled')), 0),
    'avg_ticket', case
      when count(*) filter (where status not in ('cancelled')) > 0
      then round(sum(total) filter (where status not in ('cancelled'))
           / count(*) filter (where status not in ('cancelled')), 2)
      else 0
    end,
    'total_discounts', coalesce(sum(discount_total) filter (where status not in ('cancelled')), 0)
  ) into v_today
  from public.work_orders
  where branch_id = p_branch_id
    and (created_at at time zone 'America/El_Salvador')::date = p_date;

  -- Yesterday's stats (for % comparison)
  select jsonb_build_object(
    'total_orders', count(*) filter (where status not in ('cancelled')),
    'gross_revenue', coalesce(sum(total) filter (where status not in ('cancelled')), 0)
  ) into v_yesterday
  from public.work_orders
  where branch_id = p_branch_id
    and (created_at at time zone 'America/El_Salvador')::date = p_date - 1;

  -- Currently open orders
  select jsonb_build_object(
    'count', count(*),
    'by_status', jsonb_object_agg(status, cnt)
  ) into v_open_orders
  from (
    select status, count(*) as cnt
    from public.work_orders
    where branch_id = p_branch_id
      and status not in ('delivered','cancelled','paid')
    group by status
  ) sub;

  return jsonb_build_object(
    'today', v_today,
    'yesterday', v_yesterday,
    'open_orders', v_open_orders,
    'date', p_date
  );
end;
$$;

-- ─────────────────────────────────────────────
-- RPC: Customer churn risk score
-- Based on visit frequency vs days since last visit
-- ─────────────────────────────────────────────
create or replace function public.get_customer_churn_risk(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_metrics record;
  v_risk_score text;
  v_expected_next_visit date;
begin
  select
    max(wo.created_at)::date as last_visit,
    count(wo.id) as total_visits,
    case
      when count(wo.id) <= 1 then null
      else round(
        extract(epoch from (max(wo.created_at) - min(wo.created_at)))
        / (count(wo.id) - 1) / 86400
      )
    end as avg_days_between_visits
  into v_metrics
  from public.work_orders wo
  where wo.customer_id = p_customer_id
    and wo.status not in ('cancelled');

  if v_metrics.last_visit is null then
    return jsonb_build_object('risk', 'unknown', 'reason', 'No visit history');
  end if;

  -- Calculate expected next visit
  if v_metrics.avg_days_between_visits is not null then
    v_expected_next_visit := v_metrics.last_visit + v_metrics.avg_days_between_visits;
  else
    -- Single visit: assume 30-day cycle
    v_expected_next_visit := v_metrics.last_visit + 30;
  end if;

  -- Risk scoring:
  -- low: within expected window
  -- medium: 1x overdue (up to 2x their normal cycle)
  -- high: 2x+ overdue
  declare
    v_days_overdue int := current_date - v_expected_next_visit;
    v_cycle int := coalesce(v_metrics.avg_days_between_visits, 30);
  begin
    if v_days_overdue <= 0 then
      v_risk_score := 'low';
    elsif v_days_overdue <= v_cycle then
      v_risk_score := 'medium';
    else
      v_risk_score := 'high';
    end if;
  end;

  return jsonb_build_object(
    'risk', v_risk_score,
    'last_visit', v_metrics.last_visit,
    'total_visits', v_metrics.total_visits,
    'avg_days_between_visits', v_metrics.avg_days_between_visits,
    'expected_next_visit', v_expected_next_visit,
    'days_overdue', greatest(current_date - v_expected_next_visit, 0)
  );
end;
$$;

comment on function public.get_customer_churn_risk(uuid) is
  'Calculates customer churn risk based on visit frequency. Returns low/medium/high with details.';

-- ─────────────────────────────────────────────
-- VIEW: Low stock alerts
-- ─────────────────────────────────────────────
create or replace view public.v_low_stock_alerts as
select
  p.organization_id,
  il.branch_id,
  b.name as branch_name,
  p.id as product_id,
  p.sku,
  p.name as product_name,
  p.unit_of_measure,
  p.minimum_stock,
  coalesce(s.quantity, 0) as current_quantity,
  p.minimum_stock - coalesce(s.quantity, 0) as shortage
from public.products p
cross join public.inventory_locations il
join public.branches b on b.id = il.branch_id
left join public.inventory_stock s
  on s.product_id = p.id and s.inventory_location_id = il.id
where p.active = true
  and p.organization_id = il.organization_id
  and coalesce(s.quantity, 0) <= p.minimum_stock;

-- ─────────────────────────────────────────────
-- VIEW: Membership expiring soon (within 7 days)
-- ─────────────────────────────────────────────
create or replace view public.v_memberships_expiring_soon as
select
  cm.id as membership_id,
  cm.customer_id,
  c.phone as customer_phone,
  c.email as customer_email,
  case
    when c.customer_type = 'individual'
    then trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))
    else coalesce(c.trade_name, c.legal_name)
  end as customer_name,
  mp.name as plan_name,
  cm.expires_at,
  cm.expires_at - current_date as days_until_expiry,
  cm.auto_renew
from public.customer_memberships cm
join public.customers c on c.id = cm.customer_id
join public.membership_plans mp on mp.id = cm.plan_id
where cm.status = 'active'
  and cm.expires_at between current_date and current_date + 7;
