-- ============================================================
-- Migration: 0003_branches.sql
-- Description: Branches (sucursales) per organization.
--   Each branch is an independent operational unit with its own
--   cash registers, staff, and machines.
-- ============================================================

create table public.branches (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete restrict,
  code            text        not null,
  name            text        not null,
  address         text,
  latitude        numeric(10,7),
  longitude       numeric(10,7),
  phone           text,
  email           text,
  timezone        text        not null default 'America/El_Salvador',
  opening_time    time,
  closing_time    time,
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint branches_org_code_unique unique (organization_id, code)
);

comment on table public.branches is 'Physical locations (sucursales) of an organization.';
comment on column public.branches.code is 'Short branch code used in order numbers (e.g. ESC for Escalón).';

create trigger branches_updated_at
  before update on public.branches
  for each row execute function public.set_updated_at();

-- Index for fast org lookups
create index idx_branches_organization_id on public.branches(organization_id);

-- RLS
alter table public.branches enable row level security;

-- ── Seed: Sucursal Escalón ───────────────────────────────────
insert into public.branches (
  id, organization_id, code, name, address, phone, email,
  timezone, opening_time, closing_time, active
) values (
  '00000000-0000-0000-0001-000000000001',
  '00000000-0000-0000-0000-000000000001',  -- CORSA org
  'ESC',
  'Sucursal Escalón',
  'Colonia Escalón, San Salvador, El Salvador',
  '+503 2222-1111',
  'escalon@corsacarwash.com',
  'America/El_Salvador',
  '07:00',
  '19:00',
  true
);
