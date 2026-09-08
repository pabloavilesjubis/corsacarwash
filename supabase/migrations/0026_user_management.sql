-- ============================================================
-- Migration: 0026_user_management.sql
-- Description: Gestión de usuarios y roles desde la plataforma.
--
--   Contexto: handle_new_user() (0004) crea el profile pero nunca
--   inserta en user_roles. Sin rol, has_permission() = false y toda
--   escritura con RLS falla con 403.
--
--   Esta migración:
--   1. Bootstrap: otorga Super Admin al usuario más antiguo.
--   2. Agrega policy de UPDATE de profiles para administradores.
--   3. Expone RPCs security-definer para listar usuarios (con su
--      email, que vive en auth.users y no es accesible vía PostgREST),
--      asignar roles y activar/desactivar.
--
--   SEGURIDAD: cada RPC valida has_permission('users.manage') y
--   confina la operación a la organización del llamante.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. BOOTSTRAP — Super Admin al usuario fundador
--    Idempotente: on conflict do nothing.
-- ─────────────────────────────────────────────
do $$
declare
  v_user_id uuid;
  v_count   int;
begin
  select count(*) into v_count from auth.users;

  if v_count = 0 then
    raise notice 'No hay usuarios en auth.users — bootstrap omitido.';
    return;
  end if;

  -- El usuario más antiguo es el fundador de la instalación.
  select id into v_user_id
  from auth.users
  order by created_at asc
  limit 1;

  insert into public.user_roles (user_id, role_id)
  values (v_user_id, '00000000-0000-0000-0002-000000000001')  -- Super Admin
  on conflict (user_id, role_id) do nothing;

  raise notice 'Super Admin otorgado al usuario %', v_user_id;
end $$;


-- ─────────────────────────────────────────────
-- 2. RLS — administradores pueden editar profiles de su organización
--    (0004 solo permitía editar el propio profile)
-- ─────────────────────────────────────────────
drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin"
  on public.profiles for update
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('users.manage')
  )
  with check (
    organization_id = public.get_my_organization_id()
    and public.has_permission('users.manage')
  );


-- ─────────────────────────────────────────────
-- 3. RPC — listar usuarios de la organización con email y roles
-- ─────────────────────────────────────────────
create or replace function public.admin_list_users()
returns table (
  id              uuid,
  email           text,
  first_name      text,
  last_name       text,
  display_name    text,
  phone           text,
  active          boolean,
  last_login_at   timestamptz,
  created_at      timestamptz,
  role_ids        uuid[],
  role_names      text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission('users.manage') then
    raise exception 'No autorizado: se requiere el permiso users.manage'
      using errcode = '42501';
  end if;

  return query
  select
    p.id,
    u.email::text,
    p.first_name,
    p.last_name,
    p.display_name,
    p.phone,
    p.active,
    p.last_login_at,
    p.created_at,
    coalesce(array_agg(r.id)   filter (where r.id is not null), '{}'::uuid[]),
    coalesce(array_agg(r.name) filter (where r.id is not null), '{}'::text[])
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.user_roles ur on ur.user_id = p.id
  left join public.roles      r  on r.id = ur.role_id and r.active = true
  where p.organization_id = public.get_my_organization_id()
  group by p.id, u.email, p.first_name, p.last_name,
           p.display_name, p.phone, p.active, p.last_login_at, p.created_at
  order by p.created_at asc;
end;
$$;

comment on function public.admin_list_users() is
  'Lista los usuarios de la organización del llamante, con email y roles. Requiere users.manage.';


-- ─────────────────────────────────────────────
-- 4. RPC — reemplazar el conjunto de roles de un usuario
-- ─────────────────────────────────────────────
create or replace function public.admin_set_user_roles(
  p_user_id  uuid,
  p_role_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org_id     uuid;
  v_target_org uuid;
  v_bad_roles  int;
begin
  if not public.has_permission('users.manage') then
    raise exception 'No autorizado: se requiere el permiso users.manage'
      using errcode = '42501';
  end if;

  v_org_id := public.get_my_organization_id();

  -- El usuario objetivo debe pertenecer a la misma organización
  select organization_id into v_target_org
  from public.profiles where id = p_user_id;

  if v_target_org is null or v_target_org <> v_org_id then
    raise exception 'Usuario fuera de la organización' using errcode = '42501';
  end if;

  -- Todos los roles deben pertenecer a la organización
  select count(*) into v_bad_roles
  from unnest(p_role_ids) as rid
  where not exists (
    select 1 from public.roles r
    where r.id = rid and r.organization_id = v_org_id and r.active = true
  );

  if v_bad_roles > 0 then
    raise exception 'Uno o más roles no son válidos para esta organización'
      using errcode = '22023';
  end if;

  -- Solo un Super Admin puede otorgar Super Admin
  if '00000000-0000-0000-0002-000000000001' = any(p_role_ids)
     and not public.is_super_admin() then
    raise exception 'Solo un Super Admin puede otorgar el rol Super Admin'
      using errcode = '42501';
  end if;

  -- Anti-lockout: no podés quitarte a vos mismo el Super Admin
  if p_user_id = auth.uid()
     and public.is_super_admin()
     and not ('00000000-0000-0000-0002-000000000001' = any(p_role_ids)) then
    raise exception 'No podés quitarte tu propio rol de Super Admin'
      using errcode = '42501';
  end if;

  delete from public.user_roles where user_id = p_user_id;

  insert into public.user_roles (user_id, role_id, granted_by)
  select p_user_id, rid, auth.uid()
  from unnest(p_role_ids) as rid
  on conflict (user_id, role_id) do nothing;
end;
$$;

comment on function public.admin_set_user_roles(uuid, uuid[]) is
  'Reemplaza el conjunto de roles de un usuario. Requiere users.manage.';


-- ─────────────────────────────────────────────
-- 5. RPC — activar / desactivar un usuario
-- ─────────────────────────────────────────────
create or replace function public.admin_set_user_active(
  p_user_id uuid,
  p_active  boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.has_permission('users.manage') then
    raise exception 'No autorizado: se requiere el permiso users.manage'
      using errcode = '42501';
  end if;

  if p_user_id = auth.uid() and p_active = false then
    raise exception 'No podés desactivar tu propio usuario' using errcode = '42501';
  end if;

  update public.profiles
  set active = p_active
  where id = p_user_id
    and organization_id = public.get_my_organization_id();

  if not found then
    raise exception 'Usuario no encontrado en tu organización' using errcode = '42501';
  end if;
end;
$$;

comment on function public.admin_set_user_active(uuid, boolean) is
  'Activa o desactiva un usuario de la organización. Requiere users.manage.';


-- ─────────────────────────────────────────────
-- 6. RPC — roles con su conteo de permisos (para la UI)
-- ─────────────────────────────────────────────
create or replace function public.admin_list_roles()
returns table (
  id               uuid,
  name             text,
  description      text,
  is_system        boolean,
  permission_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission('users.manage') then
    raise exception 'No autorizado: se requiere el permiso users.manage'
      using errcode = '42501';
  end if;

  return query
  select r.id, r.name, r.description, r.is_system, count(rp.permission_id)
  from public.roles r
  left join public.role_permissions rp on rp.role_id = r.id
  where r.organization_id = public.get_my_organization_id()
    and r.active = true
  group by r.id, r.name, r.description, r.is_system
  order by r.name;
end;
$$;

comment on function public.admin_list_roles() is
  'Lista los roles de la organización con su conteo de permisos. Requiere users.manage.';


-- ─────────────────────────────────────────────
-- 7. GRANTS — exponer las RPC al rol authenticated
-- ─────────────────────────────────────────────
grant execute on function public.admin_list_users()                  to authenticated;
grant execute on function public.admin_list_roles()                  to authenticated;
grant execute on function public.admin_set_user_roles(uuid, uuid[])  to authenticated;
grant execute on function public.admin_set_user_active(uuid, boolean) to authenticated;
