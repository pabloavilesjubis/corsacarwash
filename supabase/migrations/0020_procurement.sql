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
      select gr.id from public.goods_receipts gr
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
