-- ============================================================
-- Migration: 0036_plc_cloud_api.sql
-- Description: Ingesta de eventos del PLC vía API en la nube.
--
--   Extiende lo que creó 0035. NO crea tablas paralelas: `plc_events` del
--   diseño nuevo es `plc_machine_events`, y `wash_sessions` es
--   `plc_wash_cycles`. Duplicarlas partiría los datos en dos mitades y
--   ninguna consulta volvería a ser confiable.
--
-- DÓNDE VIVE LA INTELIGENCIA
--   El gateway reporta hechos («M8 subió»). La nube decide qué significan.
--   La derivación de sesiones y estado ocurre acá, en la misma transacción
--   que inserta el evento crudo, no en el Worker ni en el gateway:
--
--   - Atomicidad: no existe el instante en que el evento está guardado pero
--     la sesión no.
--   - Idempotencia real: se deriva SÓLO de los eventos que la inserción
--     declaró nuevos. Un reenvío no inserta nada y por lo tanto no deriva
--     nada. No hay forma de contar dos veces el mismo lavado.
--   - El Worker queda como una capa delgada de autenticación y validación,
--     que es lo que lo hace confiable.
--
--   Los eventos crudos nunca se modifican. Si mañana cambia la regla de qué
--   cuenta como un lavado, se puede reconstruir todo desde cero.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. GATEWAYS: ubicación
-- ─────────────────────────────────────────────
alter table public.plc_gateways
  add column if not exists location text;


-- ─────────────────────────────────────────────
-- 2. MÁQUINAS
--
--    «No confiar solamente en machine_id enviado por el cliente.»
--
--    Pero rechazar un machine_id desconocido perdería eventos, y perder
--    eventos es peor que registrar una máquina de más. La salida: la máquina
--    se da de alta sola la primera vez, marcada como auto_registered para que
--    se note, y SIEMPRE dentro de la organización del gateway autenticado.
--    Así un gateway comprometido puede inventar máquinas propias, pero no
--    puede escribir datos en la organización de otro.
-- ─────────────────────────────────────────────
create table if not exists public.plc_machines (
  id                uuid          primary key default gen_random_uuid(),
  organization_id   uuid          not null references public.organizations(id) on delete cascade,
  gateway_id        text          not null,
  machine_code      text          not null,
  name              text,
  ip_address        inet,
  active            boolean       not null default true,

  -- Apareció sola en un evento en lugar de haber sido dada de alta a mano.
  auto_registered   boolean       not null default false,

  last_seen_at      timestamptz,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),

  constraint plc_machines_code_unique unique (organization_id, machine_code)
);

comment on table public.plc_machines is
  'Máquinas monitoreadas. Se autoregistran al primer evento para no perder datos, siempre en la organización del gateway autenticado.';

alter table public.plc_machines enable row level security;


-- ─────────────────────────────────────────────
-- 3. EVENTOS CRUDOS: campos nuevos
--
--    `id` ya es la llave idempotente (el UUID que genera el gateway), así que
--    el UNIQUE sobre event_id que pide el diseño ya está garantizado por la
--    llave primaria.
-- ─────────────────────────────────────────────
alter table public.plc_machine_events
  add column if not exists sequence   bigint,
  add column if not exists payload    jsonb,
  add column if not exists processed  boolean not null default false;

comment on column public.plc_machine_events.sequence is
  'Contador monotónico del gateway. Permite detectar huecos: si llegan 100 y 102, el 101 se perdió.';
comment on column public.plc_machine_events.payload is
  'Cuerpo original del evento, tal como lo mandó el gateway. Nunca se modifica.';
comment on column public.plc_machine_events.processed is
  'Si la derivación ya lo consumió. Un evento sin procesar es un evento cuyo significado todavía no se interpretó.';

-- Para encontrar huecos en la secuencia de un gateway.
create index if not exists idx_plc_events_sequence
  on public.plc_machine_events(organization_id, gateway_id, sequence desc)
  where sequence is not null;


-- ─────────────────────────────────────────────
-- 4. SESIONES DE LAVADO: campos nuevos
--
--    source_event_id es UNIQUE y es la clave de todo: aunque la derivación
--    se ejecutara dos veces sobre el mismo evento, no puede nacer una segunda
--    sesión. Es el cinturón además del tirante.
-- ─────────────────────────────────────────────
alter table public.plc_wash_cycles
  add column if not exists service_type        text,
  add column if not exists source_event_id     uuid,
  add column if not exists completion_event_id uuid,
  add column if not exists metadata            jsonb,
  -- 'derived' = la dedujo la nube desde los eventos.
  -- 'gateway' = la mandó el gateway ya armada (ruta anterior, Edge Function).
  add column if not exists source              text not null default 'gateway';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'plc_wash_cycles_source_event_unique'
  ) then
    alter table public.plc_wash_cycles
      add constraint plc_wash_cycles_source_event_unique unique (source_event_id);
  end if;
end $$;

create index if not exists idx_plc_cycles_open
  on public.plc_wash_cycles(organization_id, machine_id, started_at desc)
  where completed_at is null;


-- ─────────────────────────────────────────────
-- 5. ESTADO ACTUAL DE CADA MÁQUINA
--
--    Una sola fila por máquina, sobreescrita. El historial está en los
--    eventos; esto es sólo «qué está pasando ahora», para el dashboard.
-- ─────────────────────────────────────────────
create table if not exists public.plc_machine_status (
  organization_id       uuid        not null references public.organizations(id) on delete cascade,
  machine_id            text        not null,
  gateway_id            text        not null,

  status                text        not null,
  current_service       text,
  last_event_type       text,
  last_event_timestamp  timestamptz not null,
  updated_at            timestamptz not null default now(),

  primary key (organization_id, machine_id)
);

comment on table public.plc_machine_status is
  'Estado vigente por máquina. Sólo avanza: un evento viejo que llegue tarde no puede retroceder el estado.';

alter table public.plc_machine_status enable row level security;


-- ─────────────────────────────────────────────
-- 6. DERIVACIÓN
--
--    Traduce un evento crudo a estado y sesiones.
--
--    NOMBRES DE EVENTOS: se aceptan las dos familias. El gateway actual emite
--    FAULT_STARTED / PLC_DISCONNECTED; el diseño nuevo habla de MACHINE_FAULT
--    / MACHINE_OFFLINE. Renombrar en el gateway obligaría a actualizar la
--    Surface antes de poder desplegar la nube. Se aceptan ambas y listo.
-- ─────────────────────────────────────────────
create or replace function public.plc_derive_from_event(
  p_org        uuid,
  p_gateway    text,
  p_machine    text,
  p_event_id   uuid,
  p_type       text,
  p_at         timestamptz,
  p_payload    jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status   text;
  v_service  text;
  v_open     record;
begin
  -- ── Qué estado implica este evento ──
  v_status := case p_type
    when 'WASH_STARTED'      then 'WASHING'
    when 'WASH_COMPLETED'    then 'READY'
    when 'WASH_STOPPED'      then 'READY'
    when 'MACHINE_READY'     then 'READY'
    when 'MACHINE_NOT_READY' then 'NOT_READY'
    when 'FAULT_STARTED'     then 'FAULT'
    when 'MACHINE_FAULT'     then 'FAULT'
    when 'FAULT_CLEARED'     then 'READY'
    when 'PLC_DISCONNECTED'  then 'OFFLINE'
    when 'MACHINE_OFFLINE'   then 'OFFLINE'
    when 'PLC_RECONNECTED'   then 'ONLINE'
    when 'MACHINE_ONLINE'    then 'ONLINE'
    else null
  end;

  v_service := nullif(p_payload->'data'->>'service_type', '');

  -- ── Sesiones ──
  if p_type = 'WASH_STARTED' then
    -- Una sesión abierta anterior nunca recibió su cierre: el gateway se
    -- reinició a mitad de lavado, o se perdió el evento. Se marca y se sigue;
    -- dejarla abierta contaminaría para siempre el «¿qué está lavando ahora?».
    update public.plc_wash_cycles
       set status = 'ABANDONED', updated_at = now()
     where organization_id = p_org
       and machine_id = p_machine
       and completed_at is null
       and status not in ('ABANDONED', 'COMPLETED');

    insert into public.plc_wash_cycles (
      id, organization_id, gateway_id, machine_id,
      started_at, status, service_type, source_event_id, source, metadata
    ) values (
      gen_random_uuid(), p_org, p_gateway, p_machine,
      p_at, 'IN_PROGRESS', v_service, p_event_id, 'derived', p_payload->'data'
    )
    on conflict (source_event_id) do nothing;

  elsif p_type in ('WASH_COMPLETED', 'WASH_STOPPED') then
    select * into v_open
      from public.plc_wash_cycles
     where organization_id = p_org
       and machine_id = p_machine
       and completed_at is null
       and started_at <= p_at
       and status = 'IN_PROGRESS'
     order by started_at desc
     limit 1
       for update;

    if found then
      update public.plc_wash_cycles
         set completed_at = p_at,
             duration_seconds = greatest(0, extract(epoch from (p_at - started_at))::int),
             status = case when p_type = 'WASH_COMPLETED' then 'COMPLETED' else 'STOPPED' end,
             completion_event_id = p_event_id,
             service_type = coalesce(service_type, v_service),
             updated_at = now()
       where id = v_open.id;

    elsif p_type = 'WASH_COMPLETED' then
      -- Al terminar un lavado el PLC baja M8 y pulsa M18 en el mismo segundo:
      -- llegan WASH_STOPPED y WASH_COMPLETED juntos, y el orden entre ellos no
      -- está garantizado. Si el STOPPED se procesó primero, la sesión ya está
      -- cerrada y este COMPLETED parecería huérfano — creando una SEGUNDA
      -- sesión para el mismo lavado. Contarlo dos veces es peor que cualquier
      -- otro error de este módulo, así que acá se busca la sesión recién
      -- cerrada y se la corrige en lugar de crear otra.
      --
      -- Sólo aplica si NO hay una sesión abierta: si empezó un lavado nuevo,
      -- la rama de arriba lo encuentra primero y esta no se ejecuta.
      select * into v_open
        from public.plc_wash_cycles
       where organization_id = p_org
         and machine_id = p_machine
         and status = 'STOPPED'
         and completed_at between p_at - interval '10 minutes' and p_at + interval '10 minutes'
       order by completed_at desc
       limit 1
         for update;

      if found then
        update public.plc_wash_cycles
           set status = 'COMPLETED',
               completed_at = greatest(completed_at, p_at),
               duration_seconds = greatest(0,
                 extract(epoch from (greatest(completed_at, p_at) - started_at))::int),
               completion_event_id = p_event_id,
               service_type = coalesce(service_type, v_service),
               updated_at = now()
         where id = v_open.id;
      else
      -- Llegó un fin sin su inicio: el gateway se instaló a mitad de lavado, o
      -- el evento de arranque se perdió. Se registra el lavado igual, sin
      -- duración. Perder la cuenta de un lavado real es peor que tener una
      -- sesión sin hora de inicio, y el estado queda explícito en el status.
      insert into public.plc_wash_cycles (
        id, organization_id, gateway_id, machine_id,
        started_at, completed_at, status, service_type,
        source_event_id, completion_event_id, source, metadata
      ) values (
        gen_random_uuid(), p_org, p_gateway, p_machine,
        p_at, p_at, 'COMPLETED_WITHOUT_START', v_service,
        p_event_id, p_event_id, 'derived', p_payload->'data'
      )
      on conflict (source_event_id) do nothing;
      end if;
    end if;

  elsif p_type in ('FAULT_STARTED', 'MACHINE_FAULT') then
    -- Una falla interrumpe el lavado en curso.
    update public.plc_wash_cycles
       set status = 'FAULTED', completed_at = p_at,
           duration_seconds = greatest(0, extract(epoch from (p_at - started_at))::int),
           updated_at = now()
     where organization_id = p_org
       and machine_id = p_machine
       and completed_at is null
       and status = 'IN_PROGRESS';
  end if;

  -- ── Estado actual ──
  -- La condición del where es lo que hace esto seguro ante reenvíos: un
  -- evento más viejo que el último aplicado no puede retroceder el estado.
  if v_status is not null then
    insert into public.plc_machine_status as s (
      organization_id, machine_id, gateway_id, status,
      current_service, last_event_type, last_event_timestamp, updated_at
    ) values (
      p_org, p_machine, p_gateway, v_status,
      v_service, p_type, p_at, now()
    )
    on conflict (organization_id, machine_id) do update
       set status               = excluded.status,
           current_service      = coalesce(excluded.current_service, s.current_service),
           last_event_type      = excluded.last_event_type,
           last_event_timestamp = excluded.last_event_timestamp,
           gateway_id           = excluded.gateway_id,
           updated_at           = now()
     where excluded.last_event_timestamp >= s.last_event_timestamp;
  end if;

  -- SERVICE_SELECTED no cambia el estado, sólo qué se está por lavar.
  if p_type = 'SERVICE_SELECTED' and v_service is not null then
    update public.plc_machine_status
       set current_service = v_service, updated_at = now()
     where organization_id = p_org and machine_id = p_machine
       and last_event_timestamp <= p_at;
  end if;
end $$;

revoke all on function public.plc_derive_from_event(uuid, text, text, uuid, text, timestamptz, jsonb) from public, anon, authenticated;


-- ─────────────────────────────────────────────
-- 7. INGESTA
--
--    Autentica Y escribe en una sola llamada. El Worker no puede saltarse la
--    autenticación por un descuido de código: no existe un camino que escriba
--    sin haber validado la clave, porque son la misma operación.
--
--    Devuelve por evento si quedó guardado o si ya estaba, que es exactamente
--    lo que el gateway necesita para decidir si lo marca como enviado.
-- ─────────────────────────────────────────────
create or replace function public.plc_ingest_events(
  p_gateway_code text,
  p_key_hash     text,
  p_events       jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gw        record;
  v_event     jsonb;
  v_id        uuid;
  v_machine   text;
  v_type      text;
  v_at        timestamptz;
  v_inserted  int;
  v_results   jsonb := '[]'::jsonb;
  v_stored    int := 0;
  v_dupes     int := 0;
begin
  select id, organization_id, gateway_id, active
    into v_gw
    from public.plc_gateways
   where gateway_id = p_gateway_code
     and api_key_hash = p_key_hash;

  -- Mismo resultado para clave incorrecta y gateway inexistente: distinguirlos
  -- le diría a quien prueba claves qué identificadores son reales.
  if not found then
    return jsonb_build_object('error', 'unauthorized');
  end if;
  if not v_gw.active then
    return jsonb_build_object('error', 'gateway_disabled');
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    v_id      := (v_event->>'event_id')::uuid;
    v_machine := v_event->>'machine_id';
    v_type    := v_event->>'event_type';
    v_at      := (v_event->>'timestamp')::timestamptz;

    -- La máquina se da de alta sola, pero siempre en la organización del
    -- gateway autenticado: nunca en la que diga el cuerpo del pedido.
    insert into public.plc_machines (
      organization_id, gateway_id, machine_code, auto_registered, last_seen_at
    ) values (
      v_gw.organization_id, v_gw.gateway_id, v_machine, true, v_at
    )
    on conflict (organization_id, machine_code) do update
       set last_seen_at = greatest(public.plc_machines.last_seen_at, excluded.last_seen_at),
           updated_at = now();

    -- ON CONFLICT DO NOTHING + RETURNING: la fila vuelve sólo si fue nueva.
    -- De ahí sale, sin ambigüedad, si este evento ya se había recibido.
    insert into public.plc_machine_events (
      id, organization_id, gateway_id, machine_id, event_type,
      previous_value, new_value, event_timestamp, gateway_created_at,
      sequence, payload, processed
    ) values (
      v_id, v_gw.organization_id, v_gw.gateway_id, v_machine, v_type,
      v_event->'data'->>'previous_value',
      v_event->'data'->>'new_value',
      v_at,
      nullif(v_event->>'created_at', '')::timestamptz,
      nullif(v_event->>'sequence', '')::bigint,
      v_event,
      false
    )
    on conflict (id) do nothing;

    get diagnostics v_inserted = row_count;

    if v_inserted > 0 then
      -- Sólo se deriva de lo que realmente se insertó. Ésta es la razón por la
      -- que un reenvío no puede duplicar un lavado.
      perform public.plc_derive_from_event(
        v_gw.organization_id, v_gw.gateway_id, v_machine, v_id, v_type, v_at, v_event);

      update public.plc_machine_events set processed = true where id = v_id;

      v_stored := v_stored + 1;
      v_results := v_results || jsonb_build_object(
        'event_id', v_id, 'status', 'stored');
    else
      v_dupes := v_dupes + 1;
      v_results := v_results || jsonb_build_object(
        'event_id', v_id, 'status', 'already_processed');
    end if;
  end loop;

  update public.plc_gateways
     set last_seen_at = greatest(last_seen_at, now()), updated_at = now()
   where id = v_gw.id;

  return jsonb_build_object(
    'stored', v_stored, 'duplicates', v_dupes, 'results', v_results);
end $$;

-- El revoke le quita a PUBLIC el permiso que Postgres da por defecto. El grant
-- explícito a service_role es lo que deja entrar al Worker: sin él, la ingesta
-- falla con «permission denied for function» y depender de que los privilegios
-- por defecto de Supabase estén intactos es apostar a una configuración que no
-- controlamos.
revoke all on function public.plc_ingest_events(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.plc_ingest_events(text, text, jsonb) to service_role;


-- ─────────────────────────────────────────────
-- 8. HEARTBEAT
-- ─────────────────────────────────────────────
create or replace function public.plc_gateway_heartbeat(
  p_gateway_code text,
  p_key_hash     text,
  p_body         jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gw       record;
  v_at       timestamptz;
  v_machine  jsonb;
begin
  select id, organization_id, gateway_id, active
    into v_gw
    from public.plc_gateways
   where gateway_id = p_gateway_code and api_key_hash = p_key_hash;

  if not found then return jsonb_build_object('error', 'unauthorized'); end if;
  if not v_gw.active then return jsonb_build_object('error', 'gateway_disabled'); end if;

  v_at := coalesce(nullif(p_body->>'timestamp', '')::timestamptz, now());

  insert into public.plc_gateway_heartbeats (
    organization_id, gateway_id, version, pending_events, machines, reported_at
  ) values (
    v_gw.organization_id, v_gw.gateway_id,
    p_body->>'version',
    nullif(p_body->>'pending_events', '')::int,
    p_body->'machines',
    v_at
  );

  update public.plc_gateways
     set last_seen_at   = greatest(last_seen_at, v_at),
         last_version   = coalesce(p_body->>'version', last_version),
         pending_events = coalesce(nullif(p_body->>'pending_events', '')::int, pending_events),
         updated_at     = now()
   where id = v_gw.id;

  -- El heartbeat también dice qué máquinas ve el gateway. Una máquina que el
  -- gateway reporta como offline no genera eventos, así que sin esto su
  -- estado quedaría congelado en lo último que hizo antes de desaparecer.
  for v_machine in select * from jsonb_array_elements(coalesce(p_body->'machines', '[]'::jsonb))
  loop
    insert into public.plc_machines (
      organization_id, gateway_id, machine_code, auto_registered, last_seen_at
    ) values (
      v_gw.organization_id, v_gw.gateway_id, v_machine->>'machine_id', true, v_at
    )
    on conflict (organization_id, machine_code) do update
       set last_seen_at = greatest(public.plc_machines.last_seen_at, excluded.last_seen_at),
           updated_at = now();

    if (v_machine->>'online') in ('false', 'f') then
      insert into public.plc_machine_status as s (
        organization_id, machine_id, gateway_id, status,
        last_event_type, last_event_timestamp, updated_at
      ) values (
        v_gw.organization_id, v_machine->>'machine_id', v_gw.gateway_id,
        'OFFLINE', 'HEARTBEAT', v_at, now()
      )
      on conflict (organization_id, machine_id) do update
         set status = 'OFFLINE', last_event_type = 'HEARTBEAT',
             last_event_timestamp = excluded.last_event_timestamp, updated_at = now()
       where excluded.last_event_timestamp >= s.last_event_timestamp;
    end if;
  end loop;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.plc_gateway_heartbeat(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.plc_gateway_heartbeat(text, text, jsonb) to service_role;


-- ─────────────────────────────────────────────
-- 9. RLS DE LAS TABLAS NUEVAS
--    Sólo lectura desde la app. Escribe únicamente el Worker, con service_role.
-- ─────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['plc_machines', 'plc_machine_status']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($f$
      create policy %I on public.%I for select
      using (organization_id = public.get_my_organization_id()
             and public.has_permission('plc.read'))
    $f$, t || '_select', t);
  end loop;
end $$;

drop policy if exists "plc_machines_manage" on public.plc_machines;
create policy "plc_machines_manage"
  on public.plc_machines for all
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.manage'))
  with check (organization_id = public.get_my_organization_id()
              and public.has_permission('plc.manage'));


-- ─────────────────────────────────────────────
-- 10. VISTAS DE ANÁLISIS
--     Las preguntas del negocio, respondidas desde los eventos crudos.
-- ─────────────────────────────────────────────

-- Estado de cada máquina, con cuánto hace que no se sabe de ella.
drop view if exists public.v_plc_machines cascade;
create view public.v_plc_machines as
select
  m.organization_id,
  m.gateway_id,
  m.machine_code                       as machine_id,
  coalesce(m.name, m.machine_code)     as name,
  m.active,
  m.auto_registered,
  m.last_seen_at,
  s.status,
  s.current_service,
  s.last_event_type,
  s.last_event_timestamp,
  -- Sin eventos ni heartbeat en 5 minutos, no se puede afirmar que siga viva.
  (s.last_event_timestamp is not null
   and s.last_event_timestamp > now() - interval '5 minutes') as reporting,
  (select count(*) from public.plc_wash_cycles c
    where c.organization_id = m.organization_id
      and c.machine_id = m.machine_code
      and c.status in ('COMPLETED', 'COMPLETED_WITHOUT_START')
      and c.started_at >= current_date)                       as washes_today
from public.plc_machines m
left join public.plc_machine_status s
       on s.organization_id = m.organization_id
      and s.machine_id = m.machine_code;

-- Producción por hora. La base de «¿a qué hora trabajamos más?».
drop view if exists public.v_plc_production_hourly cascade;
create view public.v_plc_production_hourly as
select
  organization_id,
  gateway_id,
  machine_id,
  date_trunc('hour', started_at)                      as hour,
  count(*) filter (where status in ('COMPLETED', 'COMPLETED_WITHOUT_START')) as washes,
  count(*) filter (where status = 'FAULTED')          as faulted,
  count(*) filter (where status = 'ABANDONED')        as abandoned,
  round(avg(duration_seconds) filter (
    where status = 'COMPLETED' and duration_seconds > 0))::int as avg_seconds,
  min(duration_seconds) filter (where status = 'COMPLETED' and duration_seconds > 0) as min_seconds,
  max(duration_seconds) filter (where status = 'COMPLETED') as max_seconds
from public.plc_wash_cycles
group by 1, 2, 3, 4;

-- Producción por día, con el servicio más usado.
drop view if exists public.v_plc_production_daily cascade;
create view public.v_plc_production_daily as
select
  organization_id,
  gateway_id,
  machine_id,
  started_at::date                                    as day,
  count(*) filter (where status in ('COMPLETED', 'COMPLETED_WITHOUT_START')) as washes,
  count(*) filter (where status = 'FAULTED')          as faulted,
  round(avg(duration_seconds) filter (
    where status = 'COMPLETED' and duration_seconds > 0))::int as avg_seconds,
  sum(duration_seconds) filter (where status = 'COMPLETED') as busy_seconds,
  mode() within group (order by service_type)         as top_service
from public.plc_wash_cycles
group by 1, 2, 3, 4;

-- Fallas: cuándo empezó cada una y cuánto duró hasta que se limpió.
drop view if exists public.v_plc_faults cascade;
create view public.v_plc_faults as
select
  e.organization_id,
  e.gateway_id,
  e.machine_id,
  e.id                                                as event_id,
  e.event_timestamp                                   as started_at,
  (select min(c.event_timestamp)
     from public.plc_machine_events c
    where c.organization_id = e.organization_id
      and c.machine_id = e.machine_id
      and c.event_type in ('FAULT_CLEARED', 'MACHINE_READY')
      and c.event_timestamp > e.event_timestamp)      as cleared_at,
  extract(epoch from (
    (select min(c.event_timestamp)
       from public.plc_machine_events c
      where c.organization_id = e.organization_id
        and c.machine_id = e.machine_id
        and c.event_type in ('FAULT_CLEARED', 'MACHINE_READY')
        and c.event_timestamp > e.event_timestamp) - e.event_timestamp))::int as downtime_seconds
from public.plc_machine_events e
where e.event_type in ('FAULT_STARTED', 'MACHINE_FAULT');

-- Disponibilidad diaria: cuánto del tiempo la máquina estuvo utilizable.
drop view if exists public.v_plc_availability cascade;
create view public.v_plc_availability as
select
  organization_id,
  gateway_id,
  machine_id,
  day,
  down_seconds,
  86400 - down_seconds                                as up_seconds,
  round(100.0 * (86400 - down_seconds) / 86400, 2)    as availability_pct
from (
  select
    organization_id, gateway_id, machine_id,
    started_at::date                                  as day,
    least(86400, coalesce(sum(downtime_seconds), 0))::int as down_seconds
  from public.v_plc_faults
  where cleared_at is not null
  group by 1, 2, 3, 4
) f;

comment on view public.v_plc_availability is
  'Disponibilidad por día. Sólo cuenta fallas ya resueltas: una falla abierta no tiene duración conocida todavía.';


-- ─────────────────────────────────────────────
-- 11. CORRECCIÓN A LA VISTA DE 0035
--
--     Contaba sólo status = 'COMPLETED'. Ahora existe COMPLETED_WITHOUT_START
--     —un lavado real cuyo evento de arranque se perdió— y quedaba fuera del
--     total del día. Un lavado que ocurrió debe contarse aunque no se sepa a
--     qué hora empezó.
-- ─────────────────────────────────────────────
drop view if exists public.v_plc_gateway_status cascade;
create view public.v_plc_gateway_status as
select
  g.id,
  g.organization_id,
  g.gateway_id,
  g.name,
  g.branch_id,
  g.location,
  g.active,
  g.last_seen_at,
  g.last_version,
  g.pending_events,
  (g.last_seen_at is not null and g.last_seen_at > now() - interval '3 minutes') as online,
  (select count(*) from public.plc_machine_events e
    where e.organization_id = g.organization_id and e.gateway_id = g.gateway_id
      and e.event_timestamp >= current_date)                as events_today,
  (select count(*) from public.plc_wash_cycles c
    where c.organization_id = g.organization_id and c.gateway_id = g.gateway_id
      and c.status in ('COMPLETED', 'COMPLETED_WITHOUT_START')
      and c.started_at >= current_date)                     as washes_today,
  (select count(*) from public.plc_machines m
    where m.organization_id = g.organization_id and m.gateway_id = g.gateway_id
      and m.active)                                         as machines
from public.plc_gateways g;

comment on view public.v_plc_gateway_status is
  'Estado de cada gateway: si está vivo, su versión y la actividad del día.';
