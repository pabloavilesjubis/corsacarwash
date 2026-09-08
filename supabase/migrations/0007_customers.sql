-- ============================================================
-- Migration: 0007_customers.sql
-- Description: Customer master data — supports both individuals
--   and companies. Normalized fields for reliable deduplication.
-- ============================================================

create table public.customers (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete restrict,

  -- Type
  customer_type       text        not null check (customer_type in ('individual', 'company')),

  -- Individual fields
  first_name          text,
  last_name           text,

  -- Company fields
  legal_name          text,
  trade_name          text,

  -- Tax / ID documents (El Salvador)
  dui                 text,                    -- Documento Único de Identidad
  normalized_dui      text                     -- digits only, for dedup/search
    generated always as (regexp_replace(coalesce(dui, ''), '[^0-9]', '', 'g')) stored,
  nit                 text,                    -- Número de Identificación Tributaria
  normalized_nit      text
    generated always as (regexp_replace(coalesce(nit, ''), '[^0-9]', '', 'g')) stored,
  nrc                 text,                    -- Número de Registro de Contribuyente
  normalized_nrc      text
    generated always as (regexp_replace(coalesce(nrc, ''), '[^0-9]', '', 'g')) stored,

  -- Contact
  phone               text,
  normalized_phone    text                     -- digits only
    generated always as (regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g')) stored,
  whatsapp            text,
  email               text,

  -- Address
  address             text,
  billing_address     text,

  -- Preferences
  preferred_branch_id uuid        references public.branches(id) on delete set null,
  source              text        check (source in ('walk_in','web','referral','fleet','corporate','other')),

  notes               text,
  active              boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid        references public.profiles(id) on delete set null,
  updated_by          uuid        references public.profiles(id) on delete set null,

  -- Integrity constraints
  constraint customers_individual_has_name check (
    customer_type = 'company'
    or (first_name is not null and first_name <> '')
  ),
  constraint customers_company_has_legal_name check (
    customer_type = 'individual'
    or (legal_name is not null and legal_name <> '')
  )
);

comment on table public.customers is 'Customer master: individuals and companies. Normalized fields enable deduplication.';
comment on column public.customers.normalized_dui is 'Auto-generated: DUI digits only. Used for duplicate detection and search.';
comment on column public.customers.normalized_phone is 'Auto-generated: phone digits only. Used for duplicate detection.';

create trigger customers_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────
create index idx_customers_organization_id on public.customers(organization_id);
create index idx_customers_normalized_phone on public.customers(normalized_phone) where normalized_phone is not null;
create index idx_customers_normalized_dui on public.customers(normalized_dui) where normalized_dui <> '';
create index idx_customers_normalized_nit on public.customers(normalized_nit) where normalized_nit <> '';
create index idx_customers_email on public.customers(email) where email is not null;
create index idx_customers_active on public.customers(organization_id, active);

-- Trigram index for fuzzy name search
create index idx_customers_name_trgm on public.customers
  using gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(trade_name,'') || ' ' || coalesce(legal_name,'')) gin_trgm_ops);

-- ─────────────────────────────────────────────
-- DEDUPLICATION FUNCTION
-- Check for potential duplicate customers before creating
-- ─────────────────────────────────────────────
create or replace function public.find_duplicate_customers(
  p_organization_id   uuid,
  p_phone             text default null,
  p_email             text default null,
  p_dui               text default null,
  p_nit               text default null
)
returns table (
  id              uuid,
  customer_type   text,
  full_name       text,
  phone           text,
  email           text,
  match_field     text
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct
    c.id,
    c.customer_type,
    case
      when c.customer_type = 'individual'
        then trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))
      else coalesce(c.trade_name, c.legal_name)
    end as full_name,
    c.phone,
    c.email,
    case
      when p_phone is not null
        and regexp_replace(p_phone, '[^0-9+]', '', 'g') = c.normalized_phone then 'phone'
      when p_email is not null
        and lower(p_email) = lower(c.email) then 'email'
      when p_dui is not null
        and regexp_replace(p_dui, '[^0-9]', '', 'g') = c.normalized_dui then 'dui'
      when p_nit is not null
        and regexp_replace(p_nit, '[^0-9]', '', 'g') = c.normalized_nit then 'nit'
    end as match_field
  from public.customers c
  where c.organization_id = p_organization_id
    and c.active = true
    and (
      (p_phone is not null and regexp_replace(p_phone, '[^0-9+]', '', 'g') != '' and regexp_replace(p_phone, '[^0-9+]', '', 'g') = c.normalized_phone)
      or (p_email is not null and p_email != '' and lower(p_email) = lower(c.email))
      or (p_dui is not null and regexp_replace(p_dui, '[^0-9]', '', 'g') != '' and regexp_replace(p_dui, '[^0-9]', '', 'g') = c.normalized_dui)
      or (p_nit is not null and regexp_replace(p_nit, '[^0-9]', '', 'g') != '' and regexp_replace(p_nit, '[^0-9]', '', 'g') = c.normalized_nit)
    );
$$;

-- ─────────────────────────────────────────────
-- RLS POLICIES
-- ─────────────────────────────────────────────
alter table public.customers enable row level security;

create policy "customers_select"
  on public.customers for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('customers.read')
  );

create policy "customers_insert"
  on public.customers for insert
  with check (
    organization_id = public.get_my_organization_id()
    and public.has_permission('customers.create')
  );

create policy "customers_update"
  on public.customers for update
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('customers.update')
  );

-- Soft delete only — no hard delete policy
-- Physical records are preserved; use active=false
