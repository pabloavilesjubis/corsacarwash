-- Esquema mínimo del que depende 0043, para probarla en aislamiento.
-- Se corre ANTES de la migración: sólo crea las tablas que 0043 referencia y
-- la forma que 0022 le dio a fiscal_documents.
create extension if not exists pgcrypto;
-- Los roles son del clúster, no del esquema: sobreviven a un
-- `drop schema public cascade`, así que crearlos tiene que ser idempotente.
do $$ begin
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role')  then create role service_role;  end if;
end $$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(), legal_name text not null, code text not null unique);
create table public.branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id), code text not null, name text not null);
create table public.customers (id uuid primary key default gen_random_uuid(), name text);
create table public.profiles (id uuid primary key, organization_id uuid);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  branch_id uuid not null references public.branches(id),
  invoice_type text not null, total numeric(10,2) not null default 0);

create or replace function public.get_my_organization_id() returns uuid
language sql stable as $$ select null::uuid $$;

-- fiscal_documents tal como la dejó 0022.
create table public.fiscal_documents (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null unique references public.invoices(id) on delete restrict,
  document_type text,
  payload       jsonb,
  response      jsonb,
  status        text not null default 'pending'
                check (status in ('pending','sent','accepted','rejected','error')),
  sent_at       timestamptz, accepted_at timestamptz, error_message text,
  created_at    timestamptz not null default now());
alter table public.fiscal_documents enable row level security;
create policy "fiscal_documents_select" on public.fiscal_documents for select using (true);
