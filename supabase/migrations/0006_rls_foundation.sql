-- ============================================================
-- Migration: 0006_rls_foundation.sql
-- Description: Row Level Security helpers and base policies.
--
--   RLS Strategy:
--   1. All business tables have RLS enabled
--   2. Helper functions derive context from JWT claims
--   3. Three layers of access control:
--      a) Organization isolation (organization_id match)
--      b) Branch access (user_branch_access or org-wide role)
--      c) Permission check (specific permission code)
--   4. Super Admin role bypasses all restrictions
--   5. Service role (server-side) bypasses RLS via Supabase default
--
--   SECURITY NOTE: Never expose service_role key in frontend.
--   All financial mutations go through RPC functions (security definer).
-- ============================================================

-- ─────────────────────────────────────────────
-- HELPER: Get current user's organization_id
-- Reads from profiles table (source of truth)
-- ─────────────────────────────────────────────
create or replace function public.get_my_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.profiles
  where id = auth.uid()
  limit 1;
$$;

comment on function public.get_my_organization_id() is
  'Returns the organization_id of the currently authenticated user. Used in RLS policies.';

-- ─────────────────────────────────────────────
-- HELPER: Check if user has a specific permission
-- Traverses: user → roles → role_permissions → permissions
-- ─────────────────────────────────────────────
create or replace function public.has_permission(permission_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p       on p.id = rp.permission_id
    join public.roles r             on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and p.code = permission_code
      and r.active = true
  );
$$;

comment on function public.has_permission(text) is
  'Returns true if the current user has the given permission code via any of their active roles.';

-- ─────────────────────────────────────────────
-- HELPER: Check if user is Super Admin
-- ─────────────────────────────────────────────
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and r.name = 'Super Admin'
      and r.is_system = true
      and r.active = true
  );
$$;

-- ─────────────────────────────────────────────
-- HELPER: Check if user has org-wide role
-- (Admin or above — can see all branches)
-- ─────────────────────────────────────────────
create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and r.name in ('Super Admin', 'Administrador')
      and r.is_system = true
      and r.active = true
  );
$$;

-- ─────────────────────────────────────────────
-- HELPER: Get list of branches user can access
-- ─────────────────────────────────────────────
create or replace function public.get_accessible_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  -- Org admins can access all branches in their org
  select b.id
  from public.branches b
  where b.organization_id = public.get_my_organization_id()
    and public.is_org_admin()

  union

  -- Other users: only their explicitly granted branches
  select uba.branch_id
  from public.user_branch_access uba
  where uba.user_id = auth.uid()
    and uba.can_read = true
    and not public.is_org_admin();
$$;

-- ─────────────────────────────────────────────
-- RLS POLICIES — organizations
-- ─────────────────────────────────────────────
-- Users can only see their own organization
create policy "organizations_select_own"
  on public.organizations for select
  using (id = public.get_my_organization_id());

-- Only Super Admin can update organization settings
create policy "organizations_update_super_admin"
  on public.organizations for update
  using (public.is_super_admin());

-- ─────────────────────────────────────────────
-- RLS POLICIES — branches
-- ─────────────────────────────────────────────
create policy "branches_select_accessible"
  on public.branches for select
  using (
    organization_id = public.get_my_organization_id()
    and id in (select public.get_accessible_branch_ids())
  );

create policy "branches_manage_admin"
  on public.branches for all
  using (
    organization_id = public.get_my_organization_id()
    and public.is_org_admin()
  );

-- ─────────────────────────────────────────────
-- RLS POLICIES — profiles
-- ─────────────────────────────────────────────

-- Admins can read all profiles in their org
create policy "profiles_select_org"
  on public.profiles for select
  using (
    organization_id = public.get_my_organization_id()
    and (
      id = auth.uid()                    -- own profile always visible
      or public.has_permission('users.manage')
      or public.is_org_admin()
    )
  );

-- Only admins can insert profiles (invites done via admin)
create policy "profiles_insert_admin"
  on public.profiles for insert
  with check (
    organization_id = public.get_my_organization_id()
    and public.has_permission('users.manage')
  );

-- ─────────────────────────────────────────────
-- RLS POLICIES — roles
-- ─────────────────────────────────────────────
create policy "roles_select_org"
  on public.roles for select
  using (organization_id = public.get_my_organization_id());

create policy "roles_manage_admin"
  on public.roles for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('users.manage')
    and (is_system = false or public.is_super_admin())  -- can't touch system roles unless super admin
  );

-- ─────────────────────────────────────────────
-- RLS POLICIES — permissions (read-only for all authenticated users)
-- ─────────────────────────────────────────────
create policy "permissions_select_authenticated"
  on public.permissions for select
  using (auth.uid() is not null);

-- ─────────────────────────────────────────────
-- RLS POLICIES — role_permissions
-- ─────────────────────────────────────────────
create policy "role_permissions_select_org"
  on public.role_permissions for select
  using (
    role_id in (
      select id from public.roles
      where organization_id = public.get_my_organization_id()
    )
  );

create policy "role_permissions_manage_admin"
  on public.role_permissions for all
  using (
    role_id in (
      select id from public.roles
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('users.manage')
  );

-- ─────────────────────────────────────────────
-- RLS POLICIES — user_roles
-- ─────────────────────────────────────────────
create policy "user_roles_select_own_or_admin"
  on public.user_roles for select
  using (
    user_id = auth.uid()
    or public.has_permission('users.manage')
  );

create policy "user_roles_manage_admin"
  on public.user_roles for all
  using (public.has_permission('users.manage'));

-- ─────────────────────────────────────────────
-- RLS POLICIES — user_branch_access
-- ─────────────────────────────────────────────
create policy "user_branch_access_select_own_or_admin"
  on public.user_branch_access for select
  using (
    user_id = auth.uid()
    or public.has_permission('users.manage')
  );

create policy "user_branch_access_manage_admin"
  on public.user_branch_access for all
  using (public.has_permission('users.manage'));
