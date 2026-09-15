-- ============================================================
-- Migration: 0038_servicios_por_duracion.sql
-- Description: Qué servicio se vendió, y el lavado que la máquina terminó sin
--              avisar.
--
--   1. CIERRE POR «MÁQUINA LISTA». Un lavado arrancó, la máquina volvió a
--      READY y ni M8 ni M18 llegaron nunca. El ciclo quedó abierto para
--      siempre y no se contó, aunque el carro salió lavado. Volver a READY es
--      evidencia de que el lavado terminó: ahora cierra el ciclo.
--
--   2. PRO / ELITE / SIGNATURE. La duración dice qué servicio corrió. La 0037
--      lo deducía sola agrupando duraciones; esto lo reemplaza por límites
--      explícitos y configurables POR MÁQUINA, con los nombres comerciales
--      reales y con protección contra ciclos anómalos.
--
--   Por qué reemplaza y no convive con lo de la 0037: dos fuentes de verdad
--   para «qué servicio fue» terminan discrepando, y el día que discrepen nadie
--   va a saber cuál mirar. Lo que aquel método aportaba —ver qué dicen los
--   datos reales— queda como vista de calibración, que es su lugar: informar
--   la decisión, no tomarla.
--
--   REGLA QUE NO SE TOCA: duration_seconds y los eventos crudos son lo que
--   mandó el PLC y no se modifican nunca. La clasificación es información
--   agregada encima, y por eso se puede recalcular entera cuando cambien los
--   límites o cuando el PLC empiece a informar el programa directamente.
-- ============================================================


-- ═════════════════════════════════════════════════════════════
-- PARTE 1 — FUERA EL MODELO APRENDIDO DE LA 0037
-- ═════════════════════════════════════════════════════════════

drop view if exists public.v_plc_programas_diarios cascade;
drop view if exists public.v_plc_machines cascade;
drop view if exists public.v_plc_production_daily cascade;
drop view if exists public.v_plc_servicios_diarios cascade;
drop view if exists public.v_plc_calibracion_servicios cascade;

drop function if exists public.corsa_aprender_programas(uuid, text);
drop function if exists public.corsa_programa_de(uuid, text, int);
-- La de la 0037 devolvía otras columnas, y `create or replace` no puede
-- cambiar el tipo de retorno de una función que ya existe.
drop function if exists public.corsa_reclasificar_lavados(date);
drop table if exists public.plc_machine_programs;

alter table public.plc_wash_cycles drop column if exists programa;


-- ═════════════════════════════════════════════════════════════
-- PARTE 2 — LOS LÍMITES, CONFIGURABLES
--
--   Una fila por máquina; la fila '*' vale para toda la organización. Se
--   busca primero la de la máquina y si no hay, la general: así se afina una
--   máquina sin tocar la otra, que es lo que los datos ya piden —el ciclo
--   corto de machine-2 dura más que el de machine-1.
--
--   Valores de arranque, de los datos observados hasta hoy:
--     PRO       180–289 s   (observado ~226 s en machine-1, ~249 s en machine-2)
--     ELITE     290–400 s   (observado ~338 s y ~327 s)
--     SIGNATURE 401–650 s   (observado ~431 s y ~497 s)
--   Fuera de 180–650 s no se clasifica: un ciclo de 35 s o de 20 minutos no es
--   ninguno de los tres, y ponerle nombre sería inventar una venta.
-- ═════════════════════════════════════════════════════════════

create table if not exists public.plc_service_rules (
  organization_id    uuid        not null references public.organizations(id) on delete cascade,

  -- '*' = vale para todas las máquinas de la organización.
  machine_id         text        not null default '*',

  -- Debajo de esto no hubo lavado: es un arranque en falso o un corte.
  min_valid_seconds  int         not null default 180,
  pro_max_seconds    int         not null default 289,
  elite_max_seconds  int         not null default 400,
  -- Encima de esto la máquina estuvo corriendo, pero no como ninguno de los
  -- tres programas: se cuenta el lavado y el servicio queda en UNKNOWN.
  max_valid_seconds  int         not null default 650,

  notas              text,
  updated_at         timestamptz not null default now(),

  primary key (organization_id, machine_id),

  constraint plc_service_rules_orden check (
    min_valid_seconds < pro_max_seconds
    and pro_max_seconds < elite_max_seconds
    and elite_max_seconds < max_valid_seconds)
);

comment on table public.plc_service_rules is
  'Límites de duración con los que se decide el servicio. Fila por máquina; la fila ''*'' vale para toda la organización.';

alter table public.plc_service_rules enable row level security;

drop policy if exists "plc_service_rules_select" on public.plc_service_rules;
create policy "plc_service_rules_select"
  on public.plc_service_rules for select
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.read'));

-- Ajustar los límites es una decisión de negocio, no de infraestructura: se
-- hace desde la app con el mismo permiso con el que se administran las máquinas.
drop policy if exists "plc_service_rules_manage" on public.plc_service_rules;
create policy "plc_service_rules_manage"
  on public.plc_service_rules for all
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.manage'))
  with check (organization_id = public.get_my_organization_id()
              and public.has_permission('plc.manage'));

insert into public.plc_service_rules (organization_id, machine_id, notas)
select id, '*', 'Valores de arranque de la 0038. Recalibrar con v_plc_calibracion_servicios.'
  from public.organizations
on conflict do nothing;


-- ─────────────────────────────────────────────
-- 2.1 Qué límites rigen para una máquina
--
--     Devuelve SIEMPRE una fila: si no hay nada configurado, los valores de
--     arranque. Quien la llama nunca se queda sin reglas, que es lo que
--     evitaría clasificar un lavado como UNKNOWN sólo porque falta una fila.
-- ─────────────────────────────────────────────
create or replace function public.corsa_reglas_de_servicio(
  p_org     uuid,
  p_machine text
) returns table (min_valid int, pro_max int, elite_max int, max_valid int)
language sql
stable
as $$
  select coalesce(r.min_valid_seconds, 180),
         coalesce(r.pro_max_seconds,   289),
         coalesce(r.elite_max_seconds, 400),
         coalesce(r.max_valid_seconds, 650)
  from (values (1)) as _(x)
  left join lateral (
    select *
      from public.plc_service_rules
     where organization_id = p_org
       and machine_id in (p_machine, '*')
     order by (machine_id = p_machine) desc   -- la de la máquina primero
     limit 1
  ) r on true
$$;

comment on function public.corsa_reglas_de_servicio(uuid, text) is
  'Los límites vigentes para esa máquina: los suyos, los de la organización, o los de arranque.';


-- ─────────────────────────────────────────────
-- 2.2 El servicio, por duración
--
--     Única implementación de esta regla en todo el sistema. Ni el gateway ni
--     el Worker ni el frontend la repiten: los límites se ajustan acá y lo
--     demás se entera solo, sin reinstalar nada en la Surface del local.
-- ─────────────────────────────────────────────
create or replace function public.corsa_servicio_de(
  p_org      uuid,
  p_machine  text,
  p_segundos int
) returns text
language sql
stable
as $$
  select case
           when p_segundos is null       then 'UNKNOWN'
           when p_segundos < r.min_valid then 'UNKNOWN'
           when p_segundos > r.max_valid then 'UNKNOWN'
           when p_segundos <= r.pro_max  then 'PRO'
           when p_segundos <= r.elite_max then 'ELITE'
           else 'SIGNATURE'
         end
    from public.corsa_reglas_de_servicio(p_org, p_machine) r
$$;

-- La confianza dice cuánto pesa esa clasificación. Hoy sólo hay dos casos:
-- dentro del rango válido la duración separa los tres servicios con holgura
-- (HIGH), y fuera de él no se clasifica (LOW). MEDIUM queda reservado para
-- cuando haya zonas de transición alrededor de los límites —un ciclo a 288 s
-- está a dos segundos de ser ELITE— y eso conviene calibrarlo con más historia
-- antes de activarlo.
create or replace function public.corsa_confianza_de(
  p_org      uuid,
  p_machine  text,
  p_segundos int
) returns text
language sql
stable
as $$
  select case when public.corsa_servicio_de(p_org, p_machine, p_segundos) = 'UNKNOWN'
              then 'LOW' else 'HIGH' end
$$;

-- El PLC todavía no informa qué programa corrió, pero el modelo ya lo espera:
-- si algún día manda un service_type en el payload y se entiende, ese manda
-- sobre la duración. Cualquier otra cosa se ignora en silencio — un valor que
-- no se reconoce es peor que ninguno.
create or replace function public.corsa_normalizar_servicio(p_valor text)
returns text
language sql
immutable
as $$
  select case upper(trim(coalesce(p_valor, '')))
           when 'PRO'       then 'PRO'
           when 'ELITE'     then 'ELITE'
           when 'SIGNATURE' then 'SIGNATURE'
           else null
         end
$$;

-- Desde cuánto un ciclo cuenta como lavado: el mismo piso que separa un lavado
-- real de un arranque en falso. Un solo número para las dos preguntas, porque
-- son la misma pregunta.
create or replace function public.corsa_umbral_lavado(
  p_org     uuid,
  p_machine text
) returns int
language sql
stable
as $$
  select min_valid from public.corsa_reglas_de_servicio(p_org, p_machine)
$$;

grant execute on function public.corsa_reglas_de_servicio(uuid, text)   to authenticated, service_role;
grant execute on function public.corsa_servicio_de(uuid, text, int)     to authenticated, service_role;
grant execute on function public.corsa_confianza_de(uuid, text, int)    to authenticated, service_role;
grant execute on function public.corsa_normalizar_servicio(text)        to authenticated, service_role;
grant execute on function public.corsa_umbral_lavado(uuid, text)        to authenticated, service_role;


-- ═════════════════════════════════════════════════════════════
-- PARTE 3 — EL CICLO, CLASIFICADO
-- ═════════════════════════════════════════════════════════════

-- `service_type` ya existía desde la 0036 con lo que declaraba el payload del
-- PLC. Ese dato no se pierde: se muda a service_declared y la columna pasa a
-- guardar el servicio resuelto, que es lo que el negocio lee.
alter table public.plc_wash_cycles
  add column if not exists service_declared         text,
  add column if not exists service_detection_method text,
  add column if not exists service_confidence       text,
  -- Qué señal cerró el ciclo. Es lo que permite auditar después cuántos
  -- lavados se cerraron por evidencia directa y cuántos por inferencia.
  add column if not exists closed_by                text;

-- La condición sobre service_detection_method es lo que hace esto seguro de
-- repetir: una vez clasificado, service_type guarda el servicio RESUELTO, y
-- volver a copiarlo convertiría una inferencia por duración en una supuesta
-- declaración del PLC.
update public.plc_wash_cycles
   set service_declared = service_type
 where service_declared is null
   and service_type is not null
   and service_detection_method is null;

comment on column public.plc_wash_cycles.duration_seconds is
  'Duración cruda del ciclo, tal como salió del PLC. Nunca se altera por la clasificación: es la evidencia con la que se audita todo lo demás.';
comment on column public.plc_wash_cycles.service_declared is
  'Lo que el PLC declaró en el payload, si declaró algo. Sin interpretar.';
comment on column public.plc_wash_cycles.service_type is
  'Servicio resuelto: PRO, ELITE, SIGNATURE o UNKNOWN.';
comment on column public.plc_wash_cycles.service_detection_method is
  'De dónde salió service_type: PLC, POS, DURATION o MANUAL. Prioridad futura: PLC > POS > DURATION.';
comment on column public.plc_wash_cycles.service_confidence is
  'HIGH, MEDIUM o LOW. LOW marca los ciclos fuera del rango válido, que no se clasifican.';
comment on column public.plc_wash_cycles.closed_by is
  'Señal que cerró el ciclo: WASH_COMPLETED (M18), WASH_STOPPED (M8), MACHINE_READY (inferido) o FAULT.';

create index if not exists idx_plc_cycles_servicio
  on public.plc_wash_cycles(organization_id, machine_id, service_type, started_at desc);


-- ─────────────────────────────────────────────
-- 3.1 Clasificar un ciclo
--
--     Un solo lugar decide, y se puede volver a correr sobre cualquier ciclo
--     cuando cambien los límites. Por eso no se clasifica «al vuelo» en las
--     vistas: el número que alguien leyó ayer tiene que seguir siendo el mismo
--     hoy, salvo que se decida recalibrar y volver a correr esto a propósito.
-- ─────────────────────────────────────────────
create or replace function public.corsa_clasificar_ciclo(p_ciclo uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c        record;
  v_plc    text;
  v_tipo   text;
  v_metodo text;
  v_conf   text;
begin
  select * into c from public.plc_wash_cycles where id = p_ciclo;
  if not found then return; end if;

  -- Sólo service_declared, nunca service_type: service_type guarda el servicio
  -- RESUELTO, así que leerlo acá haría que la segunda pasada de clasificación
  -- tomara su propia inferencia por una declaración del PLC. Los valores
  -- declarados que había antes de esta migración se mudaron a service_declared
  -- más arriba, así que no se pierde ninguno.
  v_plc := public.corsa_normalizar_servicio(c.service_declared);

  if not public.corsa_cuenta_como_lavado(c.status) then
    -- Un ciclo interrumpido no corrió ningún programa. Clasificarlo por su
    -- duración diría «PRO» de algo que se cortó a los veinte segundos, y ese
    -- PRO terminaría sumando en un reporte de ventas.
    v_tipo   := 'UNKNOWN';
    v_metodo := 'DURATION';
    v_conf   := 'LOW';
  elsif v_plc is not null then
    -- El PLC lo declaró: le gana a cualquier inferencia.
    v_tipo   := v_plc;
    v_metodo := 'PLC';
    v_conf   := 'HIGH';
  else
    v_tipo   := public.corsa_servicio_de(c.organization_id, c.machine_id, c.duration_seconds);
    v_metodo := 'DURATION';
    v_conf   := public.corsa_confianza_de(c.organization_id, c.machine_id, c.duration_seconds);
  end if;

  update public.plc_wash_cycles
     set service_type             = v_tipo,
         service_detection_method = v_metodo,
         service_confidence       = v_conf,
         updated_at               = now()
   where id = p_ciclo;
end $$;

revoke all on function public.corsa_clasificar_ciclo(uuid) from public, anon, authenticated;
grant execute on function public.corsa_clasificar_ciclo(uuid) to service_role;


-- ═════════════════════════════════════════════════════════════
-- PARTE 4 — DERIVACIÓN
--
--   Cambia en dos cosas respecto de la 0037:
--     · MACHINE_READY cierra el lavado abierto (el problema 1 de la cabecera).
--     · Todo cierre clasifica el servicio.
-- ═════════════════════════════════════════════════════════════
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
  v_dur      int;
  v_umbral   int;
  v_cierre   text;
  v_fin      timestamptz;
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
    -- corsa_cerrar_ciclos_huerfanos() puede rescatarla después si los eventos
    -- muestran cuándo terminó de verdad.
    update public.plc_wash_cycles
       set status = 'ABANDONED', updated_at = now()
     where organization_id = p_org
       and machine_id = p_machine
       and completed_at is null
       and status not in ('ABANDONED', 'COMPLETED');

    insert into public.plc_wash_cycles (
      id, organization_id, gateway_id, machine_id,
      started_at, status, service_declared, source_event_id, source, metadata
    ) values (
      gen_random_uuid(), p_org, p_gateway, p_machine,
      p_at, 'IN_PROGRESS', v_service, p_event_id, 'derived', p_payload->'data'
    )
    on conflict (source_event_id) do nothing;

  elsif p_type in ('WASH_COMPLETED', 'WASH_STOPPED', 'MACHINE_READY') then
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
      v_dur := greatest(0, extract(epoch from (p_at - v_open.started_at))::int);

      if p_type = 'WASH_COMPLETED' then
        v_cierre := 'COMPLETED';
      else
        -- Acá están los dos lavados que antes se perdían.
        --
        -- El primero: el PLC baja M8 y pulsa M18 en el mismo segundo, y el
        -- gateway lee una vez por segundo, así que un pulso más corto no
        -- existe para el sistema.
        --
        -- El segundo: ni M8 ni M18 llegan, y lo único que se ve es que la
        -- máquina volvió a estar lista. Que una máquina pase de lavando a
        -- lista significa que el lavado terminó — no hay otra forma de que eso
        -- ocurra.
        --
        -- En los dos casos lo que sí está siempre es cuánto corrió, y un ciclo
        -- que corrió lo que dura un programa entero y cerró sin falla es un
        -- lavado. Al revés también importa: un ciclo cortado a los veinte
        -- segundos sigue sin contarse.
        v_umbral := public.corsa_umbral_lavado(p_org, p_machine);
        v_cierre := case when v_dur >= v_umbral
                         then 'COMPLETED_WITHOUT_SIGNAL' else 'STOPPED' end;
      end if;

      update public.plc_wash_cycles
         set completed_at = p_at,
             duration_seconds = v_dur,
             status = v_cierre,
             completion_event_id = p_event_id,
             closed_by = p_type,
             service_declared = coalesce(service_declared, v_service),
             updated_at = now()
       where id = v_open.id;

      perform public.corsa_clasificar_ciclo(v_open.id);

    elsif p_type in ('WASH_COMPLETED', 'WASH_STOPPED') then
      -- No hay sesión abierta. Puede ser que ya se haya cerrado con evidencia
      -- más débil que la que trae este evento, y entonces hay que CORREGIR esa
      -- fila, no abrir otra. El orden de la evidencia, de más fuerte a más
      -- débil: M18 (el PLC dice «completo»), M8 (dejó de lavar), READY
      -- (dedujimos que terminó porque volvió a estar lista).
      --
      -- Esto es lo que hace imposible contar dos veces el mismo lavado: al
      -- terminar llegan WASH_STOPPED y WASH_COMPLETED en el mismo segundo y
      -- sin orden garantizado, y si el segundo abriera una sesión nueva, el
      -- día entero saldría al doble.
      select * into v_open
        from public.plc_wash_cycles
       where organization_id = p_org
         and machine_id = p_machine
         and completed_at between p_at - interval '10 minutes' and p_at + interval '10 minutes'
         and (
           -- M18 corrige cualquier cierre que no haya sido por M18.
           (p_type = 'WASH_COMPLETED' and status in ('STOPPED', 'COMPLETED_WITHOUT_SIGNAL'))
           -- M8 sólo corrige lo que se cerró por inferencia.
           or (p_type = 'WASH_STOPPED' and closed_by = 'MACHINE_READY')
         )
       order by completed_at desc
       limit 1
         for update;

      if found then
        -- El cierre real es el más tardío de los dos: si la máquina avisó
        -- «lista» antes de que llegara el M8, el lavado duró hasta el M8.
        v_fin := greatest(v_open.completed_at, p_at);
        v_dur := greatest(0, extract(epoch from (v_fin - v_open.started_at))::int);

        if p_type = 'WASH_COMPLETED' then
          v_cierre := 'COMPLETED';
        else
          v_umbral := public.corsa_umbral_lavado(p_org, p_machine);
          v_cierre := case when v_dur >= v_umbral
                           then 'COMPLETED_WITHOUT_SIGNAL' else 'STOPPED' end;
        end if;

        update public.plc_wash_cycles
           set status = v_cierre,
               completed_at = v_fin,
               duration_seconds = v_dur,
               completion_event_id = p_event_id,
               closed_by = p_type,
               service_declared = coalesce(service_declared, v_service),
               updated_at = now()
         where id = v_open.id;

        perform public.corsa_clasificar_ciclo(v_open.id);

      elsif p_type = 'WASH_COMPLETED' then
        -- Llegó un fin sin su inicio: el gateway se instaló a mitad de lavado,
        -- o el evento de arranque se perdió. Se registra el lavado igual, sin
        -- duración. Perder la cuenta de un lavado real es peor que tener una
        -- sesión sin hora de inicio, y el estado queda explícito en el status.
        insert into public.plc_wash_cycles (
          id, organization_id, gateway_id, machine_id,
          started_at, completed_at, status, service_declared,
          source_event_id, completion_event_id, closed_by, source, metadata
        ) values (
          gen_random_uuid(), p_org, p_gateway, p_machine,
          p_at, p_at, 'COMPLETED_WITHOUT_START', v_service,
          p_event_id, p_event_id, p_type, 'derived', p_payload->'data'
        )
        on conflict (source_event_id) do nothing;

        perform public.corsa_clasificar_ciclo(
          (select id from public.plc_wash_cycles where source_event_id = p_event_id));
      end if;
    end if;

  elsif p_type in ('FAULT_STARTED', 'MACHINE_FAULT') then
    -- Una falla interrumpe el lavado en curso.
    update public.plc_wash_cycles
       set status = 'FAULTED', completed_at = p_at,
           duration_seconds = greatest(0, extract(epoch from (p_at - started_at))::int),
           closed_by = 'FAULT',
           updated_at = now()
     where organization_id = p_org
       and machine_id = p_machine
       and completed_at is null
       and status = 'IN_PROGRESS';
  end if;

  -- ── Estado actual ──

  -- Una máquina en falla también está «no lista», así que M13↑ y M14↓ llegan
  -- casi juntos. Si MACHINE_NOT_READY pisara a FAULT, el tablero diría «no
  -- lista» de una máquina averiada: pierde justo el dato que hace falta para
  -- ir a atenderla. La falla manda hasta que se limpie.
  if p_type in ('MACHINE_NOT_READY') and exists (
       select 1 from public.plc_machine_status
        where organization_id = p_org and machine_id = p_machine
          and status = 'FAULT') then
    v_status := null;
  end if;

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


-- ═════════════════════════════════════════════════════════════
-- PARTE 5 — REPARAR Y RECLASIFICAR LA HISTORIA
-- ═════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 5.1 Los ciclos que quedaron abiertos
--
--     Antes de esta migración, un lavado sin M8 ni M18 se quedaba abierto para
--     siempre. La hora real de cierre está en los eventos: el primero que la
--     máquina haya emitido después del arranque —listo, detenido, completado o
--     falla— es cuando dejó de lavar.
--
--     Nunca cierra más allá del siguiente WASH_STARTED: si el rastro de
--     eventos se cortó y lo único que hay es de dos lavados después, ese ciclo
--     se queda como está. Antes que adivinar una duración, no contarlo.
-- ─────────────────────────────────────────────
create or replace function public.corsa_cerrar_ciclos_huerfanos(
  p_desde date default null
) returns table (maquina text, cerrados int, contados int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desde timestamptz := public.corsa_inicio_del_dia(
                           coalesce(p_desde, public.corsa_hoy() - 90));
  v_c      record;
  v_ev     record;
  v_dur    int;
  v_estado text;
  v_maq    text := null;
  v_n      int := 0;
  v_ok     int := 0;
begin
  for v_c in
    select *
      from public.plc_wash_cycles
     where started_at >= v_desde
       and completed_at is null
       and status in ('IN_PROGRESS', 'ABANDONED')
     order by machine_id, started_at
  loop
    -- El primer evento de cierre posterior al arranque, siempre que ocurra
    -- antes de que empiece el lavado siguiente.
    select e.event_type, e.event_timestamp
      into v_ev
      from public.plc_machine_events e
     where e.organization_id = v_c.organization_id
       and e.machine_id = v_c.machine_id
       and e.event_timestamp > v_c.started_at
       and e.event_type in ('WASH_COMPLETED', 'WASH_STOPPED', 'MACHINE_READY',
                            'FAULT_STARTED', 'MACHINE_FAULT')
       and e.event_timestamp < coalesce((
             select min(s.event_timestamp)
               from public.plc_machine_events s
              where s.organization_id = v_c.organization_id
                and s.machine_id = v_c.machine_id
                and s.event_type = 'WASH_STARTED'
                and s.event_timestamp > v_c.started_at), 'infinity'::timestamptz)
     order by e.event_timestamp,
              -- Si dos llegaron en el mismo segundo, manda el más concluyente.
              case e.event_type when 'WASH_COMPLETED' then 1
                                when 'WASH_STOPPED'   then 2
                                else 3 end
     limit 1;

    continue when not found;

    v_dur := greatest(0, extract(epoch from (v_ev.event_timestamp - v_c.started_at))::int);

    if v_ev.event_type in ('FAULT_STARTED', 'MACHINE_FAULT') then
      v_estado := 'FAULTED';
    elsif v_ev.event_type = 'WASH_COMPLETED' then
      v_estado := 'COMPLETED';
    elsif v_dur >= public.corsa_umbral_lavado(v_c.organization_id, v_c.machine_id) then
      v_estado := 'COMPLETED_WITHOUT_SIGNAL';
    else
      v_estado := 'STOPPED';
    end if;

    update public.plc_wash_cycles
       set completed_at = v_ev.event_timestamp,
           duration_seconds = v_dur,
           status = v_estado,
           closed_by = case when v_ev.event_type in ('FAULT_STARTED','MACHINE_FAULT')
                            then 'FAULT' else v_ev.event_type end,
           updated_at = now()
     where id = v_c.id;

    perform public.corsa_clasificar_ciclo(v_c.id);

    -- Se acumula por máquina y se emite una fila al cambiar de máquina.
    if v_maq is distinct from v_c.machine_id then
      if v_maq is not null then
        maquina := v_maq; cerrados := v_n; contados := v_ok; return next;
      end if;
      v_maq := v_c.machine_id; v_n := 0; v_ok := 0;
    end if;

    v_n := v_n + 1;
    if public.corsa_cuenta_como_lavado(v_estado) then v_ok := v_ok + 1; end if;
  end loop;

  if v_maq is not null then
    maquina := v_maq; cerrados := v_n; contados := v_ok; return next;
  end if;
end $$;

comment on function public.corsa_cerrar_ciclos_huerfanos(date) is
  'Cierra con la evidencia de los eventos los ciclos que quedaron abiertos. Segura de repetir: sólo mira ciclos sin completed_at.';

revoke all on function public.corsa_cerrar_ciclos_huerfanos(date) from public, anon, authenticated;
grant execute on function public.corsa_cerrar_ciclos_huerfanos(date) to service_role;


-- ─────────────────────────────────────────────
-- 5.2 Reevaluar y reclasificar
--
--     Reemplaza a la versión de la 0037, que decidía con el perfil aprendido.
--     Se corre después de cambiar los límites: vuelve a decidir qué cuenta y
--     qué servicio fue cada lavado, sobre la duración cruda que nunca cambió.
--
--     Nunca toca un COMPLETED: lo que M18 confirmó no se revisa.
-- ─────────────────────────────────────────────
create or replace function public.corsa_reclasificar_lavados(
  p_desde date default null
) returns table (maquina text, ascendidos int, degradados int, clasificados int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desde timestamptz := public.corsa_inicio_del_dia(
                           coalesce(p_desde, public.corsa_hoy() - 90));
  v_m     record;
  v_up    int;
  v_down  int;
  v_cla   int;
begin
  for v_m in
    select distinct organization_id, machine_id
      from public.plc_wash_cycles
     where started_at >= v_desde
  loop
    with cambio as (
      update public.plc_wash_cycles c
         set status = 'COMPLETED_WITHOUT_SIGNAL', updated_at = now()
       where c.organization_id = v_m.organization_id
         and c.machine_id = v_m.machine_id
         and c.started_at >= v_desde
         and c.status = 'STOPPED'
         and c.duration_seconds >= public.corsa_umbral_lavado(
                                     c.organization_id, c.machine_id)
      returning 1
    )
    select count(*) into v_up from cambio;

    with cambio as (
      update public.plc_wash_cycles c
         set status = 'STOPPED', updated_at = now()
       where c.organization_id = v_m.organization_id
         and c.machine_id = v_m.machine_id
         and c.started_at >= v_desde
         and c.status = 'COMPLETED_WITHOUT_SIGNAL'
         and c.duration_seconds < public.corsa_umbral_lavado(
                                    c.organization_id, c.machine_id)
      returning 1
    )
    select count(*) into v_down from cambio;

    -- Y se reclasifica todo el período, contados y no contados: los límites
    -- pudieron haber cambiado para cualquiera de los dos lados.
    perform public.corsa_clasificar_ciclo(c.id)
       from public.plc_wash_cycles c
      where c.organization_id = v_m.organization_id
        and c.machine_id = v_m.machine_id
        and c.started_at >= v_desde;

    get diagnostics v_cla = row_count;

    maquina := v_m.machine_id;
    ascendidos := v_up;
    degradados := v_down;
    clasificados := v_cla;
    return next;
  end loop;
end $$;

comment on function public.corsa_reclasificar_lavados(date) is
  'Reevalúa qué cuenta como lavado y reclasifica el servicio con los límites vigentes. Por defecto, los últimos 90 días.';

revoke all on function public.corsa_reclasificar_lavados(date) from public, anon, authenticated;
grant execute on function public.corsa_reclasificar_lavados(date) to service_role;


-- Se corre ahora: primero rescatar los ciclos abiertos, después clasificar
-- todo. En ese orden, porque un ciclo que acaba de cerrarse también tiene que
-- quedar clasificado.
do $$
declare r record;
begin
  for r in select * from public.corsa_cerrar_ciclos_huerfanos() loop
    raise notice 'Máquina %: % ciclos abiertos cerrados, % de ellos cuentan como lavado.',
      r.maquina, r.cerrados, r.contados;
  end loop;

  for r in select * from public.corsa_reclasificar_lavados() loop
    raise notice 'Máquina %: +% / -% en el conteo, % ciclos clasificados.',
      r.maquina, r.ascendidos, r.degradados, r.clasificados;
  end loop;
end $$;


-- ═════════════════════════════════════════════════════════════
-- PARTE 6 — VISTAS
--
--   Todo lo que diga «hoy» pasa por corsa_inicio_del_dia() / corsa_fin_del_dia()
--   y todo lo que agrupe por día o por hora convierte explícitamente a
--   America/El_Salvador. Es la regla que la 0037 dejó escrita y que no se
--   rompe acá: con la sesión en UTC, «hoy» empezaría a las 6 de la tarde.
-- ═════════════════════════════════════════════════════════════

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
  -- Se mide contra last_seen_at, que actualiza el heartbeat cada 30 s, y no
  -- contra el último evento: una máquina puede estar diez minutos sin lavar
  -- nada y estar perfectamente viva. Usar los eventos haría que toda máquina
  -- ociosa apareciera como caída, y entonces el indicador no significaría nada.
  (m.last_seen_at is not null
   and m.last_seen_at > now() - interval '5 minutes') as reporting,
  h.washes_today,
  h.pro_today,
  h.elite_today,
  h.signature_today,
  h.unknown_today,
  h.avg_seconds_today,
  -- En curso ahora mismo. Sin esto, una máquina lavando parece una máquina
  -- que no lavó: el ciclo todavía no cuenta y no hay dónde verlo.
  (select count(*) from public.plc_wash_cycles c
    where c.organization_id = m.organization_id
      and c.machine_id = m.machine_code
      and c.status = 'IN_PROGRESS')                              as washes_in_progress,
  -- Ciclos de hoy que corrieron pero no llegaron a ser un lavado. Si este
  -- número crece, hay algo que atender en la máquina.
  h.interrupted_today
from public.plc_machines m
left join public.plc_machine_status s
       on s.organization_id = m.organization_id
      and s.machine_id = m.machine_code
left join lateral (
  select
    count(*) filter (where public.corsa_cuenta_como_lavado(c.status))              as washes_today,
    count(*) filter (where c.service_type = 'PRO')                                 as pro_today,
    count(*) filter (where c.service_type = 'ELITE')                               as elite_today,
    count(*) filter (where c.service_type = 'SIGNATURE')                           as signature_today,
    count(*) filter (where public.corsa_cuenta_como_lavado(c.status)
                       and c.service_type = 'UNKNOWN')                             as unknown_today,
    round(avg(c.duration_seconds) filter (
      where public.corsa_cuenta_como_lavado(c.status)))::int                       as avg_seconds_today,
    count(*) filter (where c.status in ('STOPPED', 'FAULTED', 'ABANDONED'))        as interrupted_today
  from public.plc_wash_cycles c
  where c.organization_id = m.organization_id
    and c.machine_id = m.machine_code
    and c.started_at >= public.corsa_inicio_del_dia()
    and c.started_at <  public.corsa_fin_del_dia()
) h on true;

-- Servicios por día y máquina. Es la consulta de validación diaria, ya hecha
-- vista para que nadie tenga que volver a escribir los límites del día local.
create view public.v_plc_servicios_diarios as
select
  c.organization_id,
  c.gateway_id,
  c.machine_id,
  (c.started_at at time zone 'America/El_Salvador')::date as day,
  c.service_type,
  c.service_detection_method,
  count(*)                                                as washes,
  round(avg(c.duration_seconds))::int                     as avg_seconds,
  min(c.duration_seconds)                                 as min_seconds,
  max(c.duration_seconds)                                 as max_seconds,
  count(*) filter (where c.service_confidence = 'LOW')    as baja_confianza
from public.plc_wash_cycles c
where public.corsa_cuenta_como_lavado(c.status)
group by 1, 2, 3, 4, 5, 6;

comment on view public.v_plc_servicios_diarios is
  'Lavados por servicio, día y máquina. El día es el de El Salvador, no el UTC.';

-- Producción por hora, en hora local. La base de «¿a qué hora trabajamos más?».
drop view if exists public.v_plc_production_hourly cascade;
create view public.v_plc_production_hourly as
select
  organization_id,
  gateway_id,
  machine_id,
  date_trunc('hour', started_at at time zone 'America/El_Salvador') as hour,
  count(*) filter (where public.corsa_cuenta_como_lavado(status))   as washes,
  count(*) filter (where service_type = 'PRO')                      as pro,
  count(*) filter (where service_type = 'ELITE')                    as elite,
  count(*) filter (where service_type = 'SIGNATURE')                as signature,
  count(*) filter (where status = 'FAULTED')                        as faulted,
  count(*) filter (where status = 'ABANDONED')                      as abandoned,
  round(avg(duration_seconds) filter (
    where status = 'COMPLETED' and duration_seconds > 0))::int      as avg_seconds,
  min(duration_seconds) filter (where status = 'COMPLETED' and duration_seconds > 0) as min_seconds,
  max(duration_seconds) filter (where status = 'COMPLETED')         as max_seconds
from public.plc_wash_cycles
group by 1, 2, 3, 4;

-- Producción por día.
create view public.v_plc_production_daily as
select
  organization_id,
  gateway_id,
  machine_id,
  (started_at at time zone 'America/El_Salvador')::date           as day,
  count(*) filter (where public.corsa_cuenta_como_lavado(status)) as washes,
  count(*) filter (where service_type = 'PRO')                    as pro,
  count(*) filter (where service_type = 'ELITE')                  as elite,
  count(*) filter (where service_type = 'SIGNATURE')              as signature,
  count(*) filter (where public.corsa_cuenta_como_lavado(status)
                     and service_type = 'UNKNOWN')                as unknown,
  count(*) filter (where status = 'COMPLETED')                    as washes_confirmados,
  -- Cuántos de los del día se contaron por duración porque el gateway no vio
  -- la señal de fin. Si esto se dispara, el que hay que revisar es el gateway
  -- o el ancho del pulso en el PLC, no el conteo.
  count(*) filter (where status = 'COMPLETED_WITHOUT_SIGNAL')     as washes_sin_pulso,
  -- Sólo los que además se contaron: un ciclo corto cerrado por READY es un
  -- arranque en falso, no un lavado, y mezclarlos haría que esta columna no
  -- se pudiera comparar contra `washes`.
  count(*) filter (where closed_by = 'MACHINE_READY'
                     and public.corsa_cuenta_como_lavado(status))    as cerrados_por_ready,
  count(*) filter (where status = 'FAULTED')                      as faulted,
  count(*) filter (where status = 'STOPPED')                      as interrupted,
  round(avg(duration_seconds) filter (
    where public.corsa_cuenta_como_lavado(status)))::int          as avg_seconds,
  sum(duration_seconds) filter (
    where public.corsa_cuenta_como_lavado(status))                as busy_seconds,
  mode() within group (order by service_type)                     as top_service
from public.plc_wash_cycles
group by 1, 2, 3, 4;

-- ─────────────────────────────────────────────
-- Calibración: lo que dicen los datos contra lo que dicen los límites.
--
-- Es lo que queda del método de la 0037, en el lugar que le corresponde: acá
-- se mira para decidir si hay que mover un límite, y el que lo mueve es una
-- persona. `separacion_seg` es la distancia entre el lavado más largo de un
-- servicio y el más corto del siguiente: si se acerca a cero o se vuelve
-- negativa, los servicios se solapan y el límite quedó mal puesto.
-- ─────────────────────────────────────────────
create view public.v_plc_calibracion_servicios as
select
  o.organization_id,
  o.machine_id,
  o.service_type,
  o.washes,
  o.min_seconds,
  o.avg_seconds,
  o.max_seconds,
  o.min_seconds - lag(o.max_seconds) over (
    partition by o.organization_id, o.machine_id order by o.avg_seconds) as separacion_seg,
  r.min_valid, r.pro_max, r.elite_max, r.max_valid
from (
  select
    c.organization_id,
    c.machine_id,
    c.service_type,
    count(*)                            as washes,
    min(c.duration_seconds)             as min_seconds,
    round(avg(c.duration_seconds))::int as avg_seconds,
    max(c.duration_seconds)             as max_seconds
  from public.plc_wash_cycles c
  where public.corsa_cuenta_como_lavado(c.status)
    and c.duration_seconds is not null
    and c.started_at > now() - interval '90 days'
  group by 1, 2, 3
) o
cross join lateral public.corsa_reglas_de_servicio(o.organization_id, o.machine_id) r;

comment on view public.v_plc_calibracion_servicios is
  'Duraciones reales por servicio contra los límites configurados. Para decidir cuándo recalibrar plc_service_rules.';


-- ─────────────────────────────────────────────
-- Permisos de lectura. Qué ve cada usuario lo sigue decidiendo la RLS.
-- ─────────────────────────────────────────────
grant select on public.plc_service_rules              to authenticated, service_role;
grant select on public.v_plc_machines                 to authenticated, service_role;
grant select on public.v_plc_servicios_diarios        to authenticated, service_role;
grant select on public.v_plc_production_daily         to authenticated, service_role;
grant select on public.v_plc_production_hourly        to authenticated, service_role;
grant select on public.v_plc_calibracion_servicios    to authenticated, service_role;
