-- ============================================================
-- Migration: 0002_organizations.sql
-- Description: Multi-organization foundation.
--   Even though CORSA is the initial tenant, this schema
--   allows future franchises/SaaS expansion without restructuring.
-- ============================================================

create table public.organizations (
  id              uuid        primary key default gen_random_uuid(),
  legal_name      text        not null,
  trade_name      text,
  code            text        not null unique,
  country         text        not null default 'SV',
  timezone        text        not null default 'America/El_Salvador',
  currency        text        not null default 'USD',
  tax_id          text,                          -- NIT
  registration_number text,                     -- Registro de Comercio
  phone           text,
  email           text,
  address         text,
  logo_path       text,
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.organizations is 'Multi-tenant root entity. Each organization is a completely isolated business unit.';
comment on column public.organizations.code is 'Short unique code (e.g. CORSA). Used in order numbers and identifiers.';
comment on column public.organizations.tax_id is 'NIT (Número de Identificación Tributaria) for El Salvador.';

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- RLS
alter table public.organizations enable row level security;

-- Policies defined in 0006_rls_foundation.sql

-- ── Seed: CORSA as the initial organization ──────────────────
-- (Using a fixed UUID so other seeds can reference it reliably)
insert into public.organizations (
  id, legal_name, trade_name, code, country, timezone, currency,
  tax_id, phone, email, active
) values (
  '00000000-0000-0000-0000-000000000001',
  'CORSA Carwash S.A. de C.V.',
  'CORSA Carwash',
  'CORSA',
  'SV',
  'America/El_Salvador',
  'USD',
  '0614-010101-000-0',  -- placeholder, update with real NIT
  '+503 2222-0000',
  'admin@corsacarwash.com',
  true
);
