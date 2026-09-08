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
