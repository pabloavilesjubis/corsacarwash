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
