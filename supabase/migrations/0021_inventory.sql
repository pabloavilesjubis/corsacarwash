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
