-- Lo que 0046 necesita además de 0043_prereq.sql: el RBAC y un `auth` mínimo.
-- Se corre después de 0043_prereq.sql y antes de las migraciones.
--
--   psql … -f supabase/tests/0043_prereq.sql
--   psql … -f supabase/tests/0046_prereq.sql
--   psql … -f supabase/migrations/0043_motor_fiscal_dte.sql
--   psql … -f supabase/migrations/0046_contabilidad_fiscal.sql
--   psql … -f supabase/tests/0046_contabilidad_fiscal.test.sql

-- anon existe en Supabase y recibe EXECUTE por defecto sobre las funciones
-- nuevas de public. Se reproduce acá para probar que 0046 se lo quita.
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
end $$;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- 0043_prereq crea customers sin organización; 0046 la usa para verificar que
-- el cliente de un documento sea de su organización.
alter table public.customers add column if not exists organization_id uuid;

-- auth.uid() lee el usuario de una variable de sesión, como lo hace Supabase
-- con el claim `sub` del JWT. Las pruebas la fijan con set_config.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('prueba.uid', true), '')::uuid
$$;

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique, module text, description text);
create table if not exists public.roles (
  id uuid primary key, name text not null, active boolean not null default true);
create table if not exists public.role_permissions (
  role_id uuid references public.roles(id), permission_id uuid references public.permissions(id),
  primary key (role_id, permission_id));
create table if not exists public.user_roles (
  user_id uuid, role_id uuid references public.roles(id), primary key (user_id, role_id));

insert into public.roles (id, name) values
  ('00000000-0000-0000-0002-000000000001', 'Super Admin'),
  ('00000000-0000-0000-0002-000000000002', 'Administrador'),
  ('00000000-0000-0000-0002-000000000003', 'Gerente'),
  ('00000000-0000-0000-0002-000000000005', 'Caja')
on conflict do nothing;

create or replace function public.has_permission(permission_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions p on p.id = rp.permission_id
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and p.code = permission_code and r.active)
$$;

-- La de 0043_prereq devuelve null; acá sale del perfil, como en Supabase.
create or replace function public.get_my_organization_id() returns uuid
language sql stable security definer set search_path = public as $$
  select organization_id from public.profiles where id = auth.uid() limit 1
$$;
