-- ============================================================
-- FIX: usuarios sin rol → has_permission() = false → RLS 403
--
-- Causa: handle_new_user() (0004_profiles.sql) crea el profile
-- pero NUNCA inserta en user_roles. Sin rol, has_permission()
-- devuelve false para TODO, y el WITH CHECK de "customers_insert"
-- falla con 403.
-- ============================================================

-- ── PASO 1: DIAGNÓSTICO (correr primero, no modifica nada) ──
select
  u.email,
  p.organization_id,
  coalesce(string_agg(r.name, ', '), '(SIN ROLES)') as roles
from auth.users u
left join public.profiles   p  on p.id = u.id
left join public.user_roles ur on ur.user_id = u.id
left join public.roles      r  on r.id = ur.role_id
group by u.email, p.organization_id;

-- Si la columna "roles" dice (SIN ROLES), ese es el problema.


-- ── PASO 2: FIX — asignar Administrador a tu usuario ────────
-- Cambiá el email por el tuyo antes de correr.
insert into public.user_roles (user_id, role_id)
select u.id, '00000000-0000-0000-0002-000000000002'  -- Administrador
from auth.users u
where u.email = 'TU_EMAIL_AQUI@ejemplo.com'
on conflict (user_id, role_id) do nothing;


-- ── PASO 3: VERIFICAR ───────────────────────────────────────
-- Debe listar los roles asignados; luego recargá la app (F5).
select u.email, r.name as rol
from auth.users u
join public.user_roles ur on ur.user_id = u.id
join public.roles      r  on r.id = ur.role_id;
