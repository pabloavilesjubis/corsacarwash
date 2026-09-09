-- ============================================================
-- Migration: 0034_software_releases.sql
-- Description: Catálogo de software descargable desde el sistema.
--
--   Nace para distribuir el CORSA PLC Gateway —el servicio que monitorea las
--   máquinas de lavado— sin depender de un pendrive o de un enlace suelto por
--   correo. Sirve para cualquier instalador que haya que repartir después.
--
--   El archivo vive en Supabase Storage, no en esta tabla: son decenas de
--   megabytes y una columna bytea los cargaría enteros en memoria en cada
--   consulta. Acá queda sólo el metadato y la ruta.
--
--   ACCESO: sólo Super Admin, por pedido del negocio. Es un instalador que se
--   ejecuta con permisos de administrador en una PC de la operación; no es
--   algo que deba poder bajar cualquiera con acceso al sistema.
-- ============================================================

create table if not exists public.software_releases (
  id                uuid          primary key default gen_random_uuid(),
  organization_id   uuid          not null references public.organizations(id) on delete cascade,

  -- Identifica el producto; permite tener varios instaladores conviviendo.
  product           text          not null default 'plc-gateway',
  name              text          not null,
  version           text          not null,
  platform          text          not null default 'win-x64',
  description       text,
  release_notes     text,

  -- Ruta dentro del bucket `software`. El archivo no se guarda acá.
  storage_path      text          not null,
  file_name         text          not null,
  file_size_bytes   bigint,

  -- Permite verificar en la PC destino que el archivo bajó completo.
  sha256            text,

  is_current        boolean       not null default true,
  published_at      timestamptz   not null default now(),
  created_by        uuid          references public.profiles(id) on delete set null,
  created_at        timestamptz   not null default now(),

  constraint software_releases_version_unique unique (organization_id, product, version, platform)
);

comment on table public.software_releases is
  'Instaladores descargables desde el sistema. El binario vive en el bucket `software`; acá va el metadato.';
comment on column public.software_releases.sha256 is
  'Checksum del archivo, para verificar en destino que la descarga llegó completa.';

create index if not exists idx_software_releases_product
  on public.software_releases(organization_id, product, published_at desc);

alter table public.software_releases enable row level security;


-- ─────────────────────────────────────────────
-- PERMISOS
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description) values
  ('screens.software',  'screens',  'Pantalla: Software'),
  ('software.download', 'software', 'Descargar instaladores'),
  ('software.manage',   'software', 'Publicar y retirar versiones')
on conflict (code) do nothing;

-- Sólo Super Admin. Se puede extender a otros roles desde «Roles y pantallas»
-- si más adelante hace falta.
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000001', p.id
from public.permissions p
where p.code in ('screens.software', 'software.download', 'software.manage')
on conflict do nothing;


-- ─────────────────────────────────────────────
-- RLS DE LA TABLA
-- ─────────────────────────────────────────────
drop policy if exists "software_releases_select" on public.software_releases;
create policy "software_releases_select"
  on public.software_releases for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('software.download')
  );

drop policy if exists "software_releases_manage" on public.software_releases;
create policy "software_releases_manage"
  on public.software_releases for all
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('software.manage')
  )
  with check (
    organization_id = public.get_my_organization_id()
    and public.has_permission('software.manage')
  );


-- ─────────────────────────────────────────────
-- BUCKET DE ALMACENAMIENTO
--
--   Privado: un bucket público serviría el instalador a cualquiera que
--   adivinara la URL, sin sesión. El acceso se hace con URL firmada de
--   duración corta, generada desde la app para quien tenga el permiso.
-- ─────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('software', 'software', false)
on conflict (id) do update set public = false;

drop policy if exists "software_bucket_read" on storage.objects;
create policy "software_bucket_read"
  on storage.objects for select
  using (
    bucket_id = 'software'
    and public.has_permission('software.download')
  );

drop policy if exists "software_bucket_write" on storage.objects;
create policy "software_bucket_write"
  on storage.objects for insert
  with check (
    bucket_id = 'software'
    and public.has_permission('software.manage')
  );

drop policy if exists "software_bucket_update" on storage.objects;
create policy "software_bucket_update"
  on storage.objects for update
  using (
    bucket_id = 'software'
    and public.has_permission('software.manage')
  );

drop policy if exists "software_bucket_delete" on storage.objects;
create policy "software_bucket_delete"
  on storage.objects for delete
  using (
    bucket_id = 'software'
    and public.has_permission('software.manage')
  );
