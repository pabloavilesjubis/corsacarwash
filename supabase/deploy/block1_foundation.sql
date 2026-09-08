-- ============================================================
-- Migration: 0001_extensions.sql
-- Description: Enable required PostgreSQL extensions
-- ============================================================

-- UUID generation
create extension if not exists "uuid-ossp";

-- Cryptographic functions
create extension if not exists "pgcrypto";

-- Trigram similarity search (for fuzzy search on names, plates, etc.)
create extension if not exists "pg_trgm";

-- Unaccent for normalized text search
create extension if not exists "unaccent";
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
-- ============================================================
-- Migration: 0004_profiles.sql
-- Description: User profiles (1:1 with auth.users).
--   Separation of auth identity from business profile.
--   An employee does NOT necessarily have a profile (login).
-- ============================================================

create table public.profiles (
  id                uuid        primary key references auth.users(id) on delete cascade,
  organization_id   uuid        not null references public.organizations(id) on delete restrict,
  first_name        text        not null default '',
  last_name         text        not null default '',
  display_name      text,
  phone             text,
  avatar_path       text,
  default_branch_id uuid        references public.branches(id) on delete set null,
  active            boolean     not null default true,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.profiles is '1:1 extension of auth.users. Represents a system user (not necessarily an employee).';
comment on column public.profiles.id is 'Matches auth.users.id exactly.';
comment on column public.profiles.default_branch_id is 'The branch the user typically logs into. Can be changed per session.';

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create index idx_profiles_organization_id on public.profiles(organization_id);
create index idx_profiles_default_branch_id on public.profiles(default_branch_id);

-- ── Trigger: auto-create profile on auth.users insert ────────
-- This runs in the auth schema context via Supabase.
-- organization_id is injected via user_metadata set at signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  -- Extract organization_id from user metadata (set during admin invite)
  v_org_id := (new.raw_user_meta_data->>'organization_id')::uuid;

  -- Default to CORSA if not provided (development convenience)
  if v_org_id is null then
    v_org_id := '00000000-0000-0000-0000-000000000001';
  end if;

  insert into public.profiles (
    id,
    organization_id,
    first_name,
    last_name,
    display_name,
    phone
  ) values (
    new.id,
    v_org_id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    new.raw_user_meta_data->>'phone'
  );

  return new;
end;
$$;

-- Trigger fires after a new user is created in auth.users
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.profiles enable row level security;

-- Users can always read their own profile
create policy "profiles_select_own"
  on public.profiles for select
  using (id = auth.uid());

-- Users can update their own profile (limited fields via app logic)
create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid());

-- Admins can read all profiles in their organization
-- (Full RLS policies in 0006_rls_foundation.sql)
-- ============================================================
-- Migration: 0005_rbac.sql
-- Description: Role-Based Access Control (RBAC) architecture.
--   Roles → Permissions → role_permissions (M:M)
--   Users → Roles via user_roles
--   Per-branch access via user_branch_access
--
--   Design principles:
--   - Roles are scoped to an organization
--   - Permissions are system-wide (permission codes are global)
--   - A user can have multiple roles
--   - Branch access is independent and additive
-- ============================================================

-- ─────────────────────────────────────────────
-- ROLES
-- ─────────────────────────────────────────────
create table public.roles (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  name            text        not null,
  description     text,
  is_system       boolean     not null default false,  -- system roles cannot be deleted
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),

  constraint roles_org_name_unique unique (organization_id, name)
);

comment on table public.roles is 'RBAC roles scoped to an organization. System roles are protected.';
comment on column public.roles.is_system is 'System roles (Super Admin, etc.) cannot be modified or deleted.';

alter table public.roles enable row level security;
create index idx_roles_organization_id on public.roles(organization_id);

-- ─────────────────────────────────────────────
-- PERMISSIONS
-- ─────────────────────────────────────────────
create table public.permissions (
  id          uuid    primary key default gen_random_uuid(),
  code        text    not null unique,  -- e.g. 'orders.create'
  description text,
  module      text    not null          -- e.g. 'orders', 'cash', 'inventory'
);

comment on table public.permissions is 'Granular system-wide permissions. Adding new permissions never requires schema changes.';
comment on column public.permissions.code is 'Dot-notation permission code (module.action). Must be unique system-wide.';

alter table public.permissions enable row level security;

-- ─────────────────────────────────────────────
-- ROLE ↔ PERMISSIONS (M:M)
-- ─────────────────────────────────────────────
create table public.role_permissions (
  role_id       uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

alter table public.role_permissions enable row level security;

-- ─────────────────────────────────────────────
-- USER ↔ ROLES (M:M)
-- ─────────────────────────────────────────────
create table public.user_roles (
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  role_id     uuid        not null references public.roles(id) on delete cascade,
  granted_by  uuid        references public.profiles(id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, role_id)
);

comment on table public.user_roles is 'M:M relationship between users and roles.';

alter table public.user_roles enable row level security;
create index idx_user_roles_user_id on public.user_roles(user_id);
create index idx_user_roles_role_id on public.user_roles(role_id);

-- ─────────────────────────────────────────────
-- USER ↔ BRANCH ACCESS
-- ─────────────────────────────────────────────
create table public.user_branch_access (
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  branch_id   uuid        not null references public.branches(id) on delete cascade,
  can_read    boolean     not null default true,
  can_write   boolean     not null default false,
  granted_by  uuid        references public.profiles(id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, branch_id)
);

comment on table public.user_branch_access is 'Explicit per-branch access grants. Super Admins bypass this via RLS helpers.';

alter table public.user_branch_access enable row level security;
create index idx_user_branch_access_user_id on public.user_branch_access(user_id);
create index idx_user_branch_access_branch_id on public.user_branch_access(branch_id);

-- ─────────────────────────────────────────────
-- SEED: PERMISSIONS
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description) values
  -- Customers
  ('customers.read',    'customers', 'Ver clientes'),
  ('customers.create',  'customers', 'Crear clientes'),
  ('customers.update',  'customers', 'Editar clientes'),
  ('customers.delete',  'customers', 'Eliminar/desactivar clientes'),
  -- Vehicles
  ('vehicles.read',     'vehicles',  'Ver vehículos'),
  ('vehicles.create',   'vehicles',  'Registrar vehículos'),
  ('vehicles.update',   'vehicles',  'Editar vehículos'),
  ('vehicles.transfer', 'vehicles',  'Transferir propiedad de vehículo'),
  -- Orders
  ('orders.read',       'orders',    'Ver órdenes de trabajo'),
  ('orders.create',     'orders',    'Crear órdenes de trabajo'),
  ('orders.update',     'orders',    'Actualizar estado de órdenes'),
  ('orders.cancel',     'orders',    'Cancelar órdenes'),
  -- Payments
  ('payments.create',   'payments',  'Registrar pagos'),
  ('payments.refund',   'payments',  'Procesar reembolsos'),
  ('payments.void',     'payments',  'Anular pagos'),
  -- Cash
  ('cash.open',         'cash',      'Abrir sesión de caja'),
  ('cash.close',        'cash',      'Cerrar sesión de caja'),
  ('cash.override',     'cash',      'Aprobar diferencias de caja'),
  ('cash.adjust',       'cash',      'Ajustar movimientos de caja'),
  -- Discounts
  ('discounts.apply',   'discounts', 'Aplicar descuentos estándar'),
  ('discounts.override','discounts', 'Aplicar descuentos fuera de política'),
  -- Inventory
  ('inventory.read',    'inventory', 'Ver inventario'),
  ('inventory.adjust',  'inventory', 'Ajustar inventario'),
  ('inventory.purchase','inventory', 'Crear órdenes de compra'),
  -- Reports
  ('reports.sales',     'reports',   'Ver reportes de ventas'),
  ('reports.financial', 'reports',   'Ver reportes financieros'),
  ('reports.operations','reports',   'Ver reportes operativos'),
  -- Memberships
  ('memberships.read',  'memberships','Ver membresías'),
  ('memberships.manage','memberships','Gestionar membresías'),
  -- Corporate
  ('corporate.read',    'corporate', 'Ver cuentas corporativas'),
  ('corporate.manage',  'corporate', 'Gestionar cuentas corporativas'),
  ('corporate.credit_override','corporate','Aprobar crédito fuera de límite'),
  -- Employees
  ('employees.read',    'employees', 'Ver empleados'),
  ('employees.manage',  'employees', 'Gestionar empleados'),
  -- Settings
  ('settings.manage',   'settings',  'Configurar el sistema'),
  -- Users/RBAC
  ('users.manage',      'users',     'Gestionar usuarios y permisos'),
  -- Appointments
  ('appointments.read', 'appointments','Ver citas'),
  ('appointments.manage','appointments','Gestionar citas'),
  -- Quality
  ('quality.read',      'quality',   'Ver control de calidad'),
  ('quality.manage',    'quality',   'Gestionar control de calidad'),
  -- Expenses
  ('expenses.read',     'expenses',  'Ver gastos'),
  ('expenses.manage',   'expenses',  'Registrar y aprobar gastos'),
  -- AR/AP
  ('ar.read',           'finance',   'Ver cuentas por cobrar'),
  ('ap.read',           'finance',   'Ver cuentas por pagar'),
  ('finance.manage',    'finance',   'Gestionar finanzas')
;

-- ─────────────────────────────────────────────
-- SEED: SYSTEM ROLES for CORSA
-- ─────────────────────────────────────────────
-- Using fixed UUIDs so seeds can reference roles consistently
insert into public.roles (id, organization_id, name, description, is_system) values
  ('00000000-0000-0000-0002-000000000001',
   '00000000-0000-0000-0000-000000000001',
   'Super Admin', 'Acceso total al sistema. Bypass de RLS.', true),

  ('00000000-0000-0000-0002-000000000002',
   '00000000-0000-0000-0000-000000000001',
   'Administrador', 'Acceso completo por organización.', true),

  ('00000000-0000-0000-0002-000000000003',
   '00000000-0000-0000-0000-000000000001',
   'Gerente', 'Acceso completo por sucursal asignada.', true),

  ('00000000-0000-0000-0002-000000000004',
   '00000000-0000-0000-0000-000000000001',
   'Supervisor', 'Operación y reportes de sucursal.', true),

  ('00000000-0000-0000-0002-000000000005',
   '00000000-0000-0000-0000-000000000001',
   'Caja', 'Pagos, caja y órdenes.', true),

  ('00000000-0000-0000-0002-000000000006',
   '00000000-0000-0000-0000-000000000001',
   'Recepción', 'Check-in, órdenes y clientes.', true),

  ('00000000-0000-0000-0002-000000000007',
   '00000000-0000-0000-0000-000000000001',
   'Operador', 'Actualización de estado de órdenes.', true),

  ('00000000-0000-0000-0002-000000000008',
   '00000000-0000-0000-0000-000000000001',
   'Inventario', 'Gestión de inventario.', true),

  ('00000000-0000-0000-0002-000000000009',
   '00000000-0000-0000-0000-000000000001',
   'Contabilidad', 'Reportes financieros y CXC/CXP.', true)
;

-- ─────────────────────────────────────────────
-- SEED: ROLE → PERMISSIONS mapping
-- ─────────────────────────────────────────────

-- Super Admin & Administrador: all permissions
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.id in (
  '00000000-0000-0000-0002-000000000001',  -- Super Admin
  '00000000-0000-0000-0002-000000000002'   -- Administrador
);

-- Gerente: all except settings.manage, users.manage
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000003', p.id
from public.permissions p
where p.code not in ('settings.manage', 'users.manage')
on conflict do nothing;

-- Supervisor
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000004', p.id
from public.permissions p
where p.code in (
  'customers.read','customers.create','customers.update',
  'vehicles.read','vehicles.create','vehicles.update',
  'orders.read','orders.create','orders.update','orders.cancel',
  'payments.create',
  'cash.open','cash.close',
  'discounts.apply',
  'inventory.read',
  'reports.sales','reports.operations',
  'memberships.read',
  'employees.read',
  'appointments.read','appointments.manage',
  'quality.read','quality.manage',
  'expenses.read'
);

-- Caja
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000005', p.id
from public.permissions p
where p.code in (
  'customers.read','customers.create',
  'vehicles.read','vehicles.create',
  'orders.read','orders.create','orders.update',
  'payments.create',
  'cash.open','cash.close',
  'discounts.apply',
  'memberships.read',
  'reports.sales'
);

-- Recepción
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000006', p.id
from public.permissions p
where p.code in (
  'customers.read','customers.create','customers.update',
  'vehicles.read','vehicles.create','vehicles.update',
  'orders.read','orders.create','orders.update',
  'appointments.read','appointments.manage',
  'memberships.read'
);

-- Operador
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000007', p.id
from public.permissions p
where p.code in (
  'orders.read','orders.update',
  'quality.read','quality.manage'
);

-- Inventario
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000008', p.id
from public.permissions p
where p.code in (
  'inventory.read','inventory.adjust','inventory.purchase',
  'expenses.read','expenses.manage',
  'reports.operations',
  'employees.read'
);

-- Contabilidad
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000009', p.id
from public.permissions p
where p.code in (
  'reports.sales','reports.financial','reports.operations',
  'ar.read','ap.read','finance.manage',
  'customers.read','corporate.read',
  'expenses.read',
  'payments.void'
);
