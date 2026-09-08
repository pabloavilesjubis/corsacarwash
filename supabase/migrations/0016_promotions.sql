-- ============================================================
-- Migration: 0016_promotions.sql
-- Description: Promotions, coupons, redemptions,
--   and work order discounts audit trail.
-- ============================================================

create table public.promotions (
  id                uuid          primary key default gen_random_uuid(),
  organization_id   uuid          not null references public.organizations(id) on delete restrict,
  name              text          not null,
  description       text,
  type              text          not null check (type in ('percentage','fixed_amount','bundle','free_service')),
  value             numeric(10,2),               -- percentage (0-100) or fixed amount
  service_id        uuid          references public.services(id) on delete set null,  -- if applicable
  min_order_amount  numeric(10,2),               -- minimum purchase to apply
  starts_at         timestamptz   not null default now(),
  ends_at           timestamptz,                 -- null = no expiry
  usage_limit       int,                         -- total uses allowed
  per_customer_limit int,                        -- uses per customer
  active            boolean       not null default true,
  created_at        timestamptz   not null default now()
);

alter table public.promotions enable row level security;

create policy "promotions_select"
  on public.promotions for select
  using (organization_id = public.get_my_organization_id());

create policy "promotions_manage"
  on public.promotions for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('settings.manage')
  );

-- ─────────────────────────────────────────────
-- COUPONS
-- ─────────────────────────────────────────────
create table public.coupons (
  id            uuid        primary key default gen_random_uuid(),
  promotion_id  uuid        not null references public.promotions(id) on delete cascade,
  code          text        not null unique,
  customer_id   uuid        references public.customers(id) on delete set null,  -- null = public
  used_count    int         not null default 0,
  max_uses      int         not null default 1,
  expires_at    timestamptz,
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);

create index idx_coupons_code on public.coupons(code);
create index idx_coupons_customer on public.coupons(customer_id);

alter table public.coupons enable row level security;

create policy "coupons_select"
  on public.coupons for select
  using (
    promotion_id in (
      select id from public.promotions
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('discounts.apply')
  );

-- ─────────────────────────────────────────────
-- COUPON REDEMPTIONS
-- ─────────────────────────────────────────────
create table public.coupon_redemptions (
  id              uuid          primary key default gen_random_uuid(),
  coupon_id       uuid          not null references public.coupons(id) on delete restrict,
  work_order_id   uuid          not null references public.work_orders(id) on delete restrict,
  customer_id     uuid          references public.customers(id) on delete set null,
  amount_saved    numeric(10,2) not null,
  redeemed_at     timestamptz   not null default now(),
  redeemed_by     uuid          references public.profiles(id) on delete set null
);

create index idx_coupon_redemptions_coupon on public.coupon_redemptions(coupon_id);
create index idx_coupon_redemptions_order on public.coupon_redemptions(work_order_id);

alter table public.coupon_redemptions enable row level security;

create policy "coupon_redemptions_select"
  on public.coupon_redemptions for select
  using (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('discounts.apply')
  );

-- ─────────────────────────────────────────────
-- WORK ORDER DISCOUNTS (audit trail)
-- Every discount applied must have a reason.
-- Manual overrides require approval.
-- ─────────────────────────────────────────────
create table public.work_order_discounts (
  id              uuid          primary key default gen_random_uuid(),
  work_order_id   uuid          not null references public.work_orders(id) on delete restrict,
  type            text          not null check (type in ('manual','coupon','membership','promotion','employee','goodwill')),
  amount          numeric(10,2) not null check (amount > 0),
  reason          text          not null,  -- reason is ALWAYS required
  coupon_id       uuid          references public.coupons(id) on delete set null,
  promotion_id    uuid          references public.promotions(id) on delete set null,
  applied_by      uuid          not null references public.profiles(id) on delete restrict,
  approved_by     uuid          references public.profiles(id) on delete set null,
  requires_approval boolean     not null default false,
  created_at      timestamptz   not null default now()
);

comment on table public.work_order_discounts is 'Audit trail for all discounts. Every discount must have a reason. Overrides require approved_by.';
comment on column public.work_order_discounts.reason is 'REQUIRED for all discounts. Used for audit and analytics.';

create index idx_wo_discounts_order on public.work_order_discounts(work_order_id);

alter table public.work_order_discounts enable row level security;

create policy "wo_discounts_select"
  on public.work_order_discounts for select
  using (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('discounts.apply')
  );

create policy "wo_discounts_insert"
  on public.work_order_discounts for insert
  with check (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
    and (
      public.has_permission('discounts.apply')
      or public.has_permission('discounts.override')
    )
  );
