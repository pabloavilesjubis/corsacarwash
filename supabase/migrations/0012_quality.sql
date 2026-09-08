-- ============================================================
-- Migration: 0012_quality.sql
-- Description: Configurable quality control checklists
--   and per-order quality check records.
-- ============================================================

-- ─────────────────────────────────────────────
-- QUALITY CHECKLISTS (configurables por organización)
-- ─────────────────────────────────────────────
create table public.quality_checklists (
  id              uuid    primary key default gen_random_uuid(),
  organization_id uuid    not null references public.organizations(id) on delete restrict,
  name            text    not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table public.quality_checklists enable row level security;

create policy "quality_checklists_select"
  on public.quality_checklists for select
  using (organization_id = public.get_my_organization_id());

create policy "quality_checklists_manage"
  on public.quality_checklists for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('quality.manage')
  );

-- ─────────────────────────────────────────────
-- CHECKLIST ITEMS
-- ─────────────────────────────────────────────
create table public.quality_check_items (
  id              uuid    primary key default gen_random_uuid(),
  checklist_id    uuid    not null references public.quality_checklists(id) on delete cascade,
  name            text    not null,
  description     text,
  sort_order      int     not null default 0,
  required        boolean not null default false,
  active          boolean not null default true
);

alter table public.quality_check_items enable row level security;
create index idx_quality_check_items_checklist on public.quality_check_items(checklist_id);

create policy "quality_check_items_select"
  on public.quality_check_items for select
  using (
    checklist_id in (
      select id from public.quality_checklists
      where organization_id = public.get_my_organization_id()
    )
  );

-- ─────────────────────────────────────────────
-- WORK ORDER QUALITY CHECKS
-- ─────────────────────────────────────────────
create table public.work_order_quality_checks (
  id              uuid        primary key default gen_random_uuid(),
  work_order_id   uuid        not null references public.work_orders(id) on delete cascade,
  checklist_id    uuid        not null references public.quality_checklists(id),
  item_id         uuid        not null references public.quality_check_items(id),
  passed          boolean,
  notes           text,
  checked_by      uuid,       -- FK to employees added in 0018
  checked_at      timestamptz not null default now()
);

alter table public.work_order_quality_checks enable row level security;
create index idx_wo_quality_checks_order on public.work_order_quality_checks(work_order_id);

create policy "wo_quality_checks_select"
  on public.work_order_quality_checks for select
  using (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('quality.read')
  );

create policy "wo_quality_checks_insert"
  on public.work_order_quality_checks for insert
  with check (
    work_order_id in (
      select id from public.work_orders
      where branch_id in (select public.get_accessible_branch_ids())
    )
    and public.has_permission('quality.manage')
  );

-- ─────────────────────────────────────────────
-- SEED: Default Quality Checklist for CORSA
-- ─────────────────────────────────────────────
insert into public.quality_checklists (id, organization_id, name) values
  ('00000000-0000-0000-0005-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'Checklist Estándar de Calidad');

insert into public.quality_check_items (checklist_id, name, sort_order, required) values
  ('00000000-0000-0000-0005-000000000001', 'Carrocería exterior limpia',      1, true),
  ('00000000-0000-0000-0005-000000000001', 'Vidrios sin manchas',             2, true),
  ('00000000-0000-0000-0005-000000000001', 'Rines y llantas limpias',         3, true),
  ('00000000-0000-0000-0005-000000000001', 'Interior aspirado correctamente', 4, true),
  ('00000000-0000-0000-0005-000000000001', 'Tablero y consola limpios',       5, true),
  ('00000000-0000-0000-0005-000000000001', 'Alfombras limpias',               6, true),
  ('00000000-0000-0000-0005-000000000001', 'Aromatizante aplicado',           7, false),
  ('00000000-0000-0000-0005-000000000001', 'Protector de llantas aplicado',   8, false),
  ('00000000-0000-0000-0005-000000000001', 'Sin daños no reportados',         9, true);
