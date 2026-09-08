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
