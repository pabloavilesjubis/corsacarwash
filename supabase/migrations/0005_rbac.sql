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
