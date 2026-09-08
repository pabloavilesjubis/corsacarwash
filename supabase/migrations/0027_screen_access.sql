-- ============================================================
-- Migration: 0027_screen_access.sql
-- Description: Control de acceso por PANTALLA.
--
--   Contexto: hasta 0026 los permisos eran de acción (orders.create,
--   ar.read, …) pero la navegación no estaba protegida: cualquier
--   usuario autenticado podía abrir /receivables o /settings escribiendo
--   la URL, y el sidebar mostraba todos los enlaces a todos.
--
--   Esta migración:
--   1. Agrega permisos `screens.*` — uno por pantalla del sistema.
--      Son INDEPENDIENTES de los permisos de acción a propósito: quitarle
--      a un rol la pantalla "Clientes" no debe romperle la búsqueda de
--      clientes dentro del POS.
--      Excepción: la pantalla "Usuarios y roles" se controla con el
--      permiso `users.manage` que ya existe — así nadie puede quedar
--      viendo la pantalla sin poder usar ninguno de sus RPC.
--   2. Los asigna a los roles del sistema con defaults sensatos.
--   3. Fija Super Admin a la cuenta fundadora por CORREO (0026 lo hacía
--      por "el usuario más antiguo", que es frágil).
--   4. Expone RPCs para que un admin edite qué pantallas ve cada rol.
--
--   SEGURIDAD: cada RPC valida has_permission('users.manage'), se confina
--   a la organización del llamante, protege el rol Super Admin y aplica
--   anti-lockout (no podés quitarte a vos mismo la gestión de usuarios).
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. PERMISOS DE PANTALLA
--    Idempotente: on conflict (code) do nothing.
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description) values
  ('screens.dashboard',    'screens', 'Pantalla: Resumen del día'),
  ('screens.pos',          'screens', 'Pantalla: Caja / Nueva orden'),
  ('screens.orders',       'screens', 'Pantalla: Órdenes de trabajo'),
  ('screens.customers',    'screens', 'Pantalla: Clientes'),
  ('screens.analytics',    'screens', 'Pantalla: Inteligencia de negocio'),
  ('screens.receivables',  'screens', 'Pantalla: Cuentas por cobrar'),
  ('screens.payables',     'screens', 'Pantalla: Cuentas por pagar'),
  ('screens.fleets',       'screens', 'Pantalla: Flotillas corporativas'),
  ('screens.memberships',  'screens', 'Pantalla: Membresías'),
  ('screens.settings',     'screens', 'Pantalla: Configuración')
on conflict (code) do nothing;


-- ─────────────────────────────────────────────
-- 2. DEFAULTS POR ROL
--    0005 asignó "todos los permisos" a Super Admin y Administrador con
--    un cross join que ya corrió: los permisos nuevos NO quedan incluidos
--    y hay que otorgarlos explícitamente.
-- ─────────────────────────────────────────────

-- Super Admin + Administrador: todas las pantallas
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.id in (
  '00000000-0000-0000-0002-000000000001',  -- Super Admin
  '00000000-0000-0000-0002-000000000002'   -- Administrador
)
  and p.module = 'screens'
on conflict do nothing;

-- Gerente: todo menos Configuración (no tiene settings.manage)
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000003', p.id
from public.permissions p
where p.code in (
  'screens.dashboard','screens.pos','screens.orders','screens.customers',
  'screens.analytics','screens.receivables','screens.payables',
  'screens.fleets','screens.memberships'
)
on conflict do nothing;

-- Supervisor
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000004', p.id
from public.permissions p
where p.code in (
  'screens.dashboard','screens.pos','screens.orders',
  'screens.customers','screens.memberships','screens.analytics'
)
on conflict do nothing;

-- Caja
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000005', p.id
from public.permissions p
where p.code in (
  'screens.dashboard','screens.pos','screens.orders',
  'screens.customers','screens.memberships'
)
on conflict do nothing;

-- Recepción
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000006', p.id
from public.permissions p
where p.code in (
  'screens.dashboard','screens.pos','screens.orders',
  'screens.customers','screens.memberships'
)
on conflict do nothing;

-- Operador: sólo su tablero de órdenes
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000007', p.id
from public.permissions p
where p.code in ('screens.dashboard','screens.orders')
on conflict do nothing;

-- Inventario
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000008', p.id
from public.permissions p
where p.code in ('screens.dashboard')
on conflict do nothing;

-- Contabilidad
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000009', p.id
from public.permissions p
where p.code in (
  'screens.dashboard','screens.analytics','screens.receivables',
  'screens.payables','screens.customers','screens.fleets'
)
on conflict do nothing;


-- ─────────────────────────────────────────────
-- 3. BOOTSTRAP — Super Admin a la cuenta fundadora, por CORREO
--    0026 lo otorgaba al usuario más antiguo de auth.users, lo que
--    depende del orden de alta. Acá se fija explícitamente.
--    Idempotente y silencioso si la cuenta todavía no existe.
-- ─────────────────────────────────────────────
do $$
declare
  v_email  constant text := 'pabloavilesjubis@gmail.com';
  v_user_id uuid;
begin
  select id into v_user_id
  from auth.users
  where lower(email) = v_email
  limit 1;

  if v_user_id is null then
    raise notice 'La cuenta % todavía no existe en auth.users — bootstrap omitido.', v_email;
    return;
  end if;

  insert into public.user_roles (user_id, role_id)
  values (v_user_id, '00000000-0000-0000-0002-000000000001')  -- Super Admin
  on conflict (user_id, role_id) do nothing;

  -- El profile debe estar activo o no podrá operar.
  update public.profiles set active = true where id = v_user_id;

  raise notice 'Super Admin otorgado a % (%)', v_email, v_user_id;
end $$;


-- ─────────────────────────────────────────────
-- 4. RPC — catálogo de permisos (para el editor de roles)
-- ─────────────────────────────────────────────
create or replace function public.admin_list_permissions()
returns table (
  id          uuid,
  code        text,
  module      text,
  description text
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
  select p.id, p.code, p.module, p.description
  from public.permissions p
  order by p.module, p.code;
end;
$$;

comment on function public.admin_list_permissions() is
  'Catálogo completo de permisos del sistema. Requiere users.manage.';


-- ─────────────────────────────────────────────
-- 5. RPC — permisos actuales de cada rol de la organización
-- ─────────────────────────────────────────────
create or replace function public.admin_list_role_permissions()
returns table (
  role_id        uuid,
  permission_ids uuid[]
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
  select r.id,
         coalesce(array_agg(rp.permission_id) filter (where rp.permission_id is not null),
                  '{}'::uuid[])
  from public.roles r
  left join public.role_permissions rp on rp.role_id = r.id
  where r.organization_id = public.get_my_organization_id()
    and r.active = true
  group by r.id;
end;
$$;

comment on function public.admin_list_role_permissions() is
  'Devuelve, por rol de la organización, el arreglo de permission_id otorgados. Requiere users.manage.';


-- ─────────────────────────────────────────────
-- 6. RPC — reemplazar el conjunto de permisos de un rol
--
--    NOTA sobre is_system: 0005 documenta los roles de sistema como
--    "no modificables". Esta migración relaja esa regla a propósito —
--    sin ella un admin no podría ajustar qué pantallas ve Caja o
--    Recepción, que es justamente el objetivo de la pantalla. El rol
--    Super Admin sigue siendo intocable para que nunca pierda acceso.
-- ─────────────────────────────────────────────
create or replace function public.admin_set_role_permissions(
  p_role_id        uuid,
  p_permission_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  c_super_admin  constant uuid := '00000000-0000-0000-0002-000000000001';
  v_org_id       uuid;
  v_role_org     uuid;
  v_bad_perms    int;
  v_caller_has_role   boolean;
  v_keeps_via_other   boolean;
  v_new_has_manage    boolean;
begin
  if not public.has_permission('users.manage') then
    raise exception 'No autorizado: se requiere el permiso users.manage'
      using errcode = '42501';
  end if;

  if p_role_id = c_super_admin then
    raise exception 'El rol Super Admin no se puede modificar'
      using errcode = '42501';
  end if;

  v_org_id := public.get_my_organization_id();

  select organization_id into v_role_org
  from public.roles where id = p_role_id;

  if v_role_org is null or v_role_org <> v_org_id then
    raise exception 'Rol fuera de la organización' using errcode = '42501';
  end if;

  -- Todos los permission_id deben existir
  select count(*) into v_bad_perms
  from unnest(p_permission_ids) as pid
  where not exists (select 1 from public.permissions p where p.id = pid);

  if v_bad_perms > 0 then
    raise exception 'Uno o más permisos no existen' using errcode = '22023';
  end if;

  -- ── Anti-lockout ──
  -- Si el llamante tiene este rol y depende de él para users.manage,
  -- quitárselo lo dejaría sin poder volver a entrar a esta pantalla.
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role_id = p_role_id
  ) into v_caller_has_role;

  select exists (
    select 1
    from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p       on p.id = rp.permission_id
    join public.roles r             on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and p.code = 'users.manage'
      and r.active = true
      and ur.role_id <> p_role_id
  ) into v_keeps_via_other;

  select exists (
    select 1 from public.permissions p
    where p.id = any(p_permission_ids) and p.code = 'users.manage'
  ) into v_new_has_manage;

  if not public.is_super_admin()
     and v_caller_has_role
     and not v_keeps_via_other
     and not v_new_has_manage then
    raise exception 'Ese cambio te dejaría sin acceso a la gestión de usuarios'
      using errcode = '42501';
  end if;

  delete from public.role_permissions where role_id = p_role_id;

  insert into public.role_permissions (role_id, permission_id)
  select p_role_id, pid
  from unnest(p_permission_ids) as pid
  on conflict do nothing;
end;
$$;

comment on function public.admin_set_role_permissions(uuid, uuid[]) is
  'Reemplaza el conjunto de permisos de un rol. Requiere users.manage. El rol Super Admin es inmutable.';


-- ─────────────────────────────────────────────
-- 7. GRANTS
-- ─────────────────────────────────────────────
grant execute on function public.admin_list_permissions()                     to authenticated;
grant execute on function public.admin_list_role_permissions()                to authenticated;
grant execute on function public.admin_set_role_permissions(uuid, uuid[])     to authenticated;
