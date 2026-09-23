-- Esquema mínimo del que depende 0045, para probarla en aislamiento.
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;

create table public.organizations (id uuid primary key default gen_random_uuid(), legal_name text);
create table public.profiles (id uuid primary key default gen_random_uuid(), organization_id uuid);
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id), name text);
create table public.work_orders (id uuid primary key default gen_random_uuid());

create table public.corporate_accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.customers(id),
  credit_limit numeric(10,2) not null default 0 check (credit_limit >= 0),
  credit_days int not null default 30,
  credit_status text not null default 'active' check (credit_status in ('active','suspended','blocked')),
  current_balance numeric(10,2) not null default 0,
  blocked boolean not null default false, block_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table public.accounts_receivable (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  customer_id uuid not null references public.customers(id),
  work_order_id uuid references public.work_orders(id),
  invoice_id uuid, due_date date not null,
  amount numeric(10,2) not null check (amount > 0),
  balance numeric(10,2) not null check (balance >= 0),
  status text not null default 'open' check (status in ('open','partial','paid','overdue','void')),
  notes text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());

-- Los helpers de RLS, simulados. `corsa_test_permisos` deja que las pruebas
-- cambien qué permisos tiene el usuario sin montar todo el RBAC.
create table public.corsa_test_estado (org uuid, permisos text[], uid uuid);
insert into public.corsa_test_estado values (null, array[]::text[], null);
create or replace function public.get_my_organization_id() returns uuid
  language sql stable as $$ select org from public.corsa_test_estado limit 1 $$;
-- Dos trampas acá, las dos encontradas corriendo esto:
--   · `limit 1` sobre `unnest(permisos)` recorta al PRIMER permiso del array,
--     no a la primera fila, y el doble contestaba false para todo lo demás.
--   · `p = any((select permisos ...))` se parsea como subconsulta de FILAS y
--     no como arreglo: da «operator does not exist: text = text[]».
-- Con `exists` sobre la tabla no hay ambigüedad.
create or replace function public.has_permission(p text) returns boolean
  language sql stable as $$
    select exists (select 1 from public.corsa_test_estado where p = any(permisos))
  $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
  language sql stable as $$ select uid from public.corsa_test_estado limit 1 $$;
