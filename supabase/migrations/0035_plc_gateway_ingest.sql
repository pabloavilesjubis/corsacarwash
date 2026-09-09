-- ============================================================
-- Migration: 0035_plc_gateway_ingest.sql
-- Description: Recepción de datos del CORSA PLC Gateway.
--
--   El gateway corre en una Surface dentro del carwash y monitorea las
--   máquinas de lavado por Modbus. Esta migración prepara el lado del backend
--   para recibir sus eventos.
--
--   EL GATEWAY NO SE CONECTA A ESTA BASE. Escribe contra una Edge Function
--   (`gateway-ingest`) que valida su clave y hace la escritura del lado del
--   servidor con service_role. Darle credenciales de base a una máquina
--   físicamente accesible dentro del local significaría que, si se filtran, el
--   atacante entra a la base de producción del negocio entero — no sólo al
--   monitoreo de las máquinas.
--
--   Por eso NO hay policy de insert para `authenticated` en estas tablas: sólo
--   escribe la Edge Function, que salta RLS por diseño.
--
--   IDEMPOTENCIA: el gateway genera un UUID por evento y por ciclo, y lo
--   conserva en los reintentos. Acá se usa como llave primaria, así reenviar
--   un lote tras un corte de Internet no duplica nada.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. REGISTRO DE GATEWAYS
-- ─────────────────────────────────────────────
create table if not exists public.plc_gateways (
  id                uuid          primary key default gen_random_uuid(),
  organization_id   uuid          not null references public.organizations(id) on delete cascade,

  -- El identificador que el gateway manda en X-Gateway-Id.
  gateway_id        text          not null,
  name              text          not null,
  branch_id         uuid          references public.branches(id) on delete set null,

  -- Hash SHA-256 de la clave, NUNCA la clave. Si esta tabla se filtra, no se
  -- puede suplantar al gateway con lo que hay acá.
  api_key_hash      text          not null,

  active            boolean       not null default true,
  last_seen_at      timestamptz,
  last_version      text,
  pending_events    int,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),

  constraint plc_gateways_gateway_id_unique unique (organization_id, gateway_id)
);

comment on table public.plc_gateways is
  'Gateways autorizados a enviar datos. api_key_hash guarda el SHA-256 de la clave, nunca la clave.';

create index if not exists idx_plc_gateways_key on public.plc_gateways(api_key_hash) where active;
alter table public.plc_gateways enable row level security;


-- ─────────────────────────────────────────────
-- 2. EVENTOS
-- ─────────────────────────────────────────────
create table if not exists public.plc_machine_events (
  -- UUID generado en el gateway: es la llave idempotente.
  id                uuid          primary key,
  organization_id   uuid          not null references public.organizations(id) on delete cascade,
  gateway_id        text          not null,
  machine_id        text          not null,

  event_type        text          not null,
  previous_value    text,
  new_value         text,
  event_timestamp   timestamptz   not null,

  -- Cuándo ocurrió en el carwash vs. cuándo llegó acá. La diferencia mide
  -- cuánto estuvo el gateway sin Internet.
  gateway_created_at timestamptz,
  received_at       timestamptz   not null default now()
);

create index if not exists idx_plc_events_machine
  on public.plc_machine_events(organization_id, machine_id, event_timestamp desc);
create index if not exists idx_plc_events_type
  on public.plc_machine_events(organization_id, event_type, event_timestamp desc);

alter table public.plc_machine_events enable row level security;


-- ─────────────────────────────────────────────
-- 3. CICLOS DE LAVADO
-- ─────────────────────────────────────────────
create table if not exists public.plc_wash_cycles (
  id                uuid          primary key,
  organization_id   uuid          not null references public.organizations(id) on delete cascade,
  gateway_id        text          not null,
  machine_id        text          not null,

  started_at        timestamptz   not null,
  completed_at      timestamptz,
  duration_seconds  int,
  status            text          not null,

  received_at       timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

create index if not exists idx_plc_cycles_machine
  on public.plc_wash_cycles(organization_id, machine_id, started_at desc);

alter table public.plc_wash_cycles enable row level security;


-- ─────────────────────────────────────────────
-- 4. HEARTBEATS
--    Permiten distinguir «no hubo lavados» de «el gateway está caído».
-- ─────────────────────────────────────────────
create table if not exists public.plc_gateway_heartbeats (
  id                uuid          primary key default gen_random_uuid(),
  organization_id   uuid          not null references public.organizations(id) on delete cascade,
  gateway_id        text          not null,
  version           text,
  pending_events    int,
  machines          jsonb,
  reported_at       timestamptz   not null,
  received_at       timestamptz   not null default now()
);

create index if not exists idx_plc_heartbeats
  on public.plc_gateway_heartbeats(organization_id, gateway_id, reported_at desc);

alter table public.plc_gateway_heartbeats enable row level security;


-- ─────────────────────────────────────────────
-- 5. PERMISOS Y LECTURA
--    Sólo lectura desde la app. La escritura es exclusiva de la Edge Function.
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description) values
  ('plc.read',   'plc', 'Ver el estado y los eventos de las máquinas'),
  ('plc.manage', 'plc', 'Registrar gateways y rotar sus claves')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000001',
               '00000000-0000-0000-0002-000000000002',
               '00000000-0000-0000-0002-000000000003')
  and p.code in ('plc.read', 'plc.manage')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000004',
               '00000000-0000-0000-0002-000000000005',
               '00000000-0000-0000-0002-000000000006')
  and p.code = 'plc.read'
on conflict do nothing;

do $$
declare t text;
begin
  foreach t in array array['plc_gateways','plc_machine_events','plc_wash_cycles','plc_gateway_heartbeats']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($f$
      create policy %I on public.%I for select
      using (organization_id = public.get_my_organization_id()
             and public.has_permission('plc.read'))
    $f$, t || '_select', t);
  end loop;
end $$;

-- Registrar gateways y rotar claves sí se hace desde la app.
drop policy if exists "plc_gateways_manage" on public.plc_gateways;
create policy "plc_gateways_manage"
  on public.plc_gateways for all
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.manage'))
  with check (organization_id = public.get_my_organization_id()
              and public.has_permission('plc.manage'));


-- ─────────────────────────────────────────────
-- 6. VISTA DE ESTADO
-- ─────────────────────────────────────────────
create or replace view public.v_plc_gateway_status as
select
  g.id,
  g.organization_id,
  g.gateway_id,
  g.name,
  g.branch_id,
  g.active,
  g.last_seen_at,
  g.last_version,
  g.pending_events,
  -- Sin latido en tres minutos con heartbeat de 30 s, algo pasa.
  (g.last_seen_at is not null and g.last_seen_at > now() - interval '3 minutes') as online,
  (select count(*) from public.plc_machine_events e
    where e.organization_id = g.organization_id and e.gateway_id = g.gateway_id
      and e.event_timestamp >= current_date) as events_today,
  (select count(*) from public.plc_wash_cycles c
    where c.organization_id = g.organization_id and c.gateway_id = g.gateway_id
      and c.status = 'COMPLETED' and c.started_at >= current_date) as washes_today
from public.plc_gateways g;

comment on view public.v_plc_gateway_status is
  'Estado de cada gateway: si está vivo, su versión y la actividad del día.';
