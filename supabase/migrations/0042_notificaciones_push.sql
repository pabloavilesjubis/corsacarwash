-- ============================================================
-- Migration: 0042_notificaciones_push.sql
-- Description: Notificaciones Push del sistema CORSA.
--
--   Lleva a los teléfonos tres cosas que hoy sólo se ven si alguien tiene el
--   tablero abierto: que una máquina terminó un lavado, que una máquina falló,
--   y que la operación del día terminó.
--
-- LA REGLA QUE MANDA SOBRE TODAS
--   Este módulo NO detecta lavados. Los observa.
--
--   Ya existe una sola fuente de verdad —plc_wash_cycles, alimentada por
--   plc_derive_from_event— y escribir un segundo algoritmo que mire los mismos
--   eventos crudos daría dos respuestas para el mismo lavado. El día que
--   discrepen, el push diría una cosa y el tablero otra, y no habría forma de
--   saber cuál mirar.
--
--   Por eso todo lo que sigue cuelga de TRIGGERS sobre las tablas que ya son
--   la verdad. Eso además resuelve algo que una llamada dentro de
--   plc_derive_from_event no resolvería: hoy conviven dos rutas de ingesta
--   —el Worker de Cloudflare, que llama plc_ingest_events, y la Edge Function
--   gateway-ingest, que hace upsert directo— y sólo la primera pasa por la
--   derivación. Un trigger sobre la tabla cubre las dos, y cubrirá también la
--   tercera que aparezca.
--
-- IDEMPOTENCIA
--   Nada se envía dos veces, y no por cuidado al escribir el código sino por
--   una restricción de la base: notification_events.idempotency_key es UNIQUE.
--   La clave de un lavado es el UUID de su ciclo, que ya existe y ya es único.
--   Reiniciar el gateway, reenviar un lote, reprocesar el día o reinstalar el
--   servidor no puede generar un segundo push, porque el INSERT choca.
--
-- POR QUÉ UN MOTOR DE EVENTOS Y NO TRES FUNCIONES
--   Mañana hay que avisar que el gateway se cayó, que un lavado duró el doble
--   de lo normal, que se llegó a la meta del día. Y en algún momento el canal
--   no va a ser sólo push: va a haber WhatsApp y correo.
--
--   La forma del sistema es:
--       evento CORSA → regla → destinatario → canal → entrega
--
--   Agregar un evento es insertar una fila en notification_rules y llamar a
--   corsa_emitir_notificacion() desde donde ese hecho se detecte. Agregar un
--   canal es escribir un despachador nuevo que lea de la misma cola. Ninguna
--   de las dos cosas toca la lógica que detecta lavados.
-- ============================================================


-- ═════════════════════════════════════════════════════════════
-- PARTE 1 — CONFIGURACIÓN DEL MÓDULO
--
--   Todo lo que es una decisión de operación —cuánto esperar antes de declarar
--   cerrado el día, desde qué hora tiene sentido hacerlo— vive en una tabla y
--   no en el código. Un número escrito adentro de una función obliga a correr
--   una migración para cambiar de opinión, y entonces no se cambia nunca.
-- ═════════════════════════════════════════════════════════════

create table if not exists public.corsa_notification_config (
  organization_id            uuid        primary key
                                         references public.organizations(id) on delete cascade,

  -- Interruptor general. En false no se emite ningún evento: la salida de
  -- emergencia si algo empieza a mandar pushes de más un domingo a la noche.
  enabled                    boolean     not null default true,

  -- ── Cierre del día ──
  -- Cuánto tiene que sostenerse la evidencia de «ambas máquinas apagadas»
  -- antes de creerle. Una caída de red de cinco minutos no puede cerrar el día.
  cierre_ventana_minutos     int         not null default 45,
  -- Antes de esta hora local no se cierra ni con todas las máquinas apagadas:
  -- a las diez de la mañana, dos máquinas apagadas son un corte de luz.
  cierre_hora_minima         time        not null default '14:00',
  -- Hora tope: si llegada esta hora hubo actividad y hace rato que no pasa
  -- nada, se cierra igual. Es la red de seguridad para la noche en que el
  -- gateway se apaga junto con el local y nadie reporta nada.
  cierre_hora_tope           time        not null default '23:30',
  -- Cuánto tiene que hacer que no termina un lavado para que la hora tope
  -- aplique.
  cierre_inactividad_minutos int         not null default 90,

  -- Un gateway que no late hace más de esto no sabe nada de las máquinas, y
  -- por lo tanto su silencio no es evidencia de nada.
  gateway_offline_minutos    int         not null default 5,

  -- Eventos más viejos que esto no notifican. Es lo que hace que reprocesar
  -- noventa días de historia —corsa_reclasificar_lavados() lo hace— no
  -- dispare mil pushes de lavados de la semana pasada.
  ventana_frescura_minutos   int         not null default 30,

  -- Simulación de eventos para probar sin esperar un lavado real. Falso en
  -- producción, y la UI sólo ofrece los controles en desarrollo; esto es el
  -- segundo cerrojo, del lado del servidor, para que un build de producción
  -- mal configurado no alcance.
  simulacion_habilitada      boolean     not null default false,

  -- Cuándo se evaluó por última vez el cierre del día. Es un acelerador: el
  -- latido del gateway llega cada 30 s y la evaluación consulta el historial
  -- de latidos, así que sin esto correría ciento veinte veces por hora para
  -- responder lo mismo. Ver 9.5.
  ultima_evaluacion_cierre_at timestamptz,

  updated_at                 timestamptz not null default now()
);

comment on table public.corsa_notification_config is
  'Parámetros de operación del módulo de notificaciones. Una fila por organización.';

-- `create table if not exists` no agrega columnas a una tabla que ya existe:
-- si una versión anterior de esta migración ya creó la tabla, el bloque de
-- arriba no hace absolutamente nada y la columna nueva nunca aparece. No falla
-- —que es lo peor— y el error sale mucho después, en la primera función que la
-- nombra. Cada columna agregada después de la primera versión necesita su
-- `alter` explícito acá abajo.
alter table public.corsa_notification_config
  add column if not exists ultima_evaluacion_cierre_at timestamptz;

alter table public.corsa_notification_config enable row level security;

drop policy if exists "corsa_notification_config_select" on public.corsa_notification_config;
create policy "corsa_notification_config_select"
  on public.corsa_notification_config for select
  using (organization_id = public.get_my_organization_id());

drop policy if exists "corsa_notification_config_manage" on public.corsa_notification_config;
create policy "corsa_notification_config_manage"
  on public.corsa_notification_config for all
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.manage'))
  with check (organization_id = public.get_my_organization_id()
              and public.has_permission('plc.manage'));

insert into public.corsa_notification_config (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;


-- Devuelve SIEMPRE una fila, con los valores de arranque si nadie configuró
-- nada. Quien la llama nunca se queda sin parámetros — que sería la forma de
-- que el módulo dejara de funcionar en silencio.
-- Los valores de arranque se asignan POR NOMBRE y no con un `row(...)` posicional.
-- Un literal posicional casteado al tipo de la tabla obliga a que la lista de
-- valores tenga exactamente las mismas columnas, en el mismo orden, para
-- siempre: agregar una columna lo rompe con «cannot cast type record … Input
-- has too many columns», y el error no aparece acá sino en la primera consulta
-- que llame a esta función. Por nombre, una columna nueva simplemente queda
-- null hasta que alguien decida qué valor de arranque tiene.
create or replace function public.corsa_config_notificaciones(p_org uuid)
returns public.corsa_notification_config
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.corsa_notification_config;
begin
  select * into v
    from public.corsa_notification_config
   where organization_id = p_org;

  if found then
    return v;
  end if;

  v.organization_id             := p_org;
  v.enabled                     := true;
  v.cierre_ventana_minutos      := 45;
  v.cierre_hora_minima          := '14:00'::time;
  v.cierre_hora_tope            := '23:30'::time;
  v.cierre_inactividad_minutos  := 90;
  v.gateway_offline_minutos     := 5;
  v.ventana_frescura_minutos    := 30;
  v.simulacion_habilitada       := false;
  v.ultima_evaluacion_cierre_at := null;
  v.updated_at                  := now();

  return v;
end $$;

grant execute on function public.corsa_config_notificaciones(uuid) to authenticated, service_role;


-- ═════════════════════════════════════════════════════════════
-- PARTE 2 — LOS DISPOSITIVOS
--
--   Una fila por navegador-en-un-dispositivo, no por usuario: la misma persona
--   tiene el teléfono y la laptop, y cada uno tiene su propia suscripción con
--   su propio endpoint. Desactivar el push en la laptop no puede apagarlo en
--   el teléfono.
--
--   El endpoint es UNIQUE en toda la tabla y no por usuario: si dos personas
--   inician sesión en el mismo navegador, el navegador da el MISMO endpoint, y
--   dos filas con el mismo endpoint harían que cada push llegara duplicado.
--   Al reasignarse, la fila cambia de dueño — que es lo correcto: el push va a
--   quien está usando ese dispositivo ahora.
-- ═════════════════════════════════════════════════════════════

create table if not exists public.push_subscriptions (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null references public.organizations(id) on delete cascade,
  user_id                     uuid        not null references public.profiles(id) on delete cascade,

  -- La URL del servicio de push del navegador (FCM, Mozilla, Apple). Es larga
  -- y es el identificador real del dispositivo.
  endpoint                    text        not null,
  -- Las dos claves con las que se cifra el mensaje. Sin ellas el push viaja
  -- sin contenido y el teléfono no tiene qué mostrar.
  p256dh                      text        not null,
  auth                        text        not null,

  device_name                 text        not null default 'Dispositivo',
  user_agent                  text,
  -- 'ios' | 'android' | 'desktop' — para poder explicar en la pantalla por qué
  -- en iPhone hay que instalar la app antes de que esto funcione.
  platform                    text,
  -- Si el navegador reportó estar corriendo como PWA instalada.
  standalone                  boolean,

  enabled                     boolean     not null default true,
  wash_notifications          boolean     not null default true,
  machine_error_notifications boolean     not null default true,
  daily_close_notifications   boolean     not null default true,

  -- Cuándo el servicio de push dijo que este endpoint ya no existe. Se marca
  -- en vez de borrar: saber que un dispositivo se dio de baja solo es la
  -- diferencia entre «nunca se suscribió» y «se desinstaló la app».
  invalidated_at              timestamptz,
  invalidated_reason          text,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  last_seen_at                timestamptz not null default now(),
  last_push_at                timestamptz,

  constraint push_subscriptions_endpoint_unique unique (endpoint)
);

comment on table public.push_subscriptions is
  'Dispositivos suscritos a Push. Una fila por navegador; el endpoint es único en toda la tabla porque el navegador da el mismo sin importar quién inició sesión.';

create index if not exists idx_push_subs_user
  on public.push_subscriptions(user_id) where enabled;
create index if not exists idx_push_subs_org
  on public.push_subscriptions(organization_id) where enabled;

alter table public.push_subscriptions enable row level security;

-- Cada quien ve y administra SUS dispositivos. Quien administra usuarios ve
-- todos los de la organización —hace falta para resolver «a mí no me llegan
-- las notificaciones» sin pedirle a la persona que lea una tabla— pero la
-- escritura sigue siendo de cada quien: nadie suscribe un dispositivo ajeno.
drop policy if exists "push_subscriptions_select" on public.push_subscriptions;
create policy "push_subscriptions_select"
  on public.push_subscriptions for select
  using (
    user_id = auth.uid()
    or (organization_id = public.get_my_organization_id()
        and public.has_permission('users.manage'))
  );

drop policy if exists "push_subscriptions_write_own" on public.push_subscriptions;
create policy "push_subscriptions_write_own"
  on public.push_subscriptions for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and organization_id = public.get_my_organization_id());


-- ═════════════════════════════════════════════════════════════
-- PARTE 3 — LOS EVENTOS
--
--   La cola y el historial son la misma tabla, a propósito. Dos tablas —una
--   para «lo que hay que mandar» y otra para «lo que se mandó»— se
--   desincronizan el día que falle el paso entre ellas, y entonces el centro
--   de notificaciones muestra algo que nadie recibió, o al revés.
-- ═════════════════════════════════════════════════════════════

create table if not exists public.notification_events (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null references public.organizations(id) on delete cascade,

  -- WASH_COMPLETED | MACHINE_ERROR | DAILY_CLOSE | TEST.
  -- Sin CHECK: agregar GATEWAY_OFFLINE mañana no puede requerir una migración.
  -- Qué se hace con cada tipo lo decide notification_rules, que es una tabla.
  event_type       text        not null,
  severity         text        not null default 'INFO'
                               check (severity in ('INFO', 'WARNING', 'CRITICAL')),

  machine_id       text,
  wash_id          uuid,
  service_type     text,

  -- Ya redactados, no plantillas. El texto se arma en el momento en que el
  -- hecho ocurre, con los números de ese momento: así el historial muestra
  -- exactamente lo que sonó en el teléfono, y no una reconstrucción que meses
  -- después daría otro número.
  title            text        not null,
  body             text        not null,
  -- A dónde lleva tocar la notificación. Ruta relativa: el dominio lo pone el
  -- Service Worker, que es el único que sabe desde dónde se instaló la app.
  deep_link        text,

  metadata         jsonb       not null default '{}'::jsonb,

  -- El cinturón contra duplicados. Ver la cabecera del archivo.
  idempotency_key  text        not null,

  status           text        not null default 'PENDING'
                               check (status in ('PENDING', 'DISPATCHING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts         int         not null default 0,
  dispatched_at    timestamptz,
  sent_at          timestamptz,

  created_at       timestamptz not null default now(),

  constraint notification_events_idempotency_unique unique (idempotency_key)
);

comment on table public.notification_events is
  'Cola e historial de notificaciones. idempotency_key UNIQUE es lo que hace imposible notificar dos veces el mismo hecho.';
comment on column public.notification_events.idempotency_key is
  'Identidad del HECHO, no del envío: wash-<id del ciclo>, machine-error-<id del incidente>, daily-close-YYYY-MM-DD.';

create index if not exists idx_notification_events_pendientes
  on public.notification_events(created_at)
  where status in ('PENDING', 'DISPATCHING');
create index if not exists idx_notification_events_historial
  on public.notification_events(organization_id, created_at desc);

alter table public.notification_events enable row level security;

-- Lo que las máquinas informan lo ve quien puede ver las máquinas. Es la misma
-- información que ya está en el tablero, contada de otra forma.
drop policy if exists "notification_events_select" on public.notification_events;
create policy "notification_events_select"
  on public.notification_events for select
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.read'));

-- Nadie inserta desde la app. Los eventos nacen de los triggers y de las
-- funciones security definer de este archivo; el único camino desde la app es
-- corsa_simular_evento(), que valida permiso y bandera de simulación.


-- ─────────────────────────────────────────────
-- 3.1 Quién marcó como leída cuál
--
--     Tabla aparte y no una columna `read`: el evento es uno y los lectores
--     son varios. Una columna haría que el primero que abre la campana la
--     apague para todos.
-- ─────────────────────────────────────────────
create table if not exists public.notification_reads (
  user_id               uuid        not null references public.profiles(id) on delete cascade,
  notification_event_id uuid        not null references public.notification_events(id) on delete cascade,
  read_at               timestamptz not null default now(),
  primary key (user_id, notification_event_id)
);

alter table public.notification_reads enable row level security;

drop policy if exists "notification_reads_own" on public.notification_reads;
create policy "notification_reads_own"
  on public.notification_reads for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ─────────────────────────────────────────────
-- 3.2 Las reglas: qué evento va a quién y por dónde
--
--     Es la pieza que hace que agregar GATEWAY_OFFLINE mañana sea una fila y
--     no una función nueva.
--
--     `subscription_flag` conecta un tipo de evento con la casilla que el
--     usuario ve en la pantalla de notificaciones. Un evento cuya regla no
--     nombra ninguna casilla va a todos los dispositivos habilitados — que es
--     lo correcto para algo como GATEWAY_OFFLINE, que nadie querría apagar por
--     separado antes de que exista la casilla.
-- ─────────────────────────────────────────────
create table if not exists public.notification_rules (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null references public.organizations(id) on delete cascade,

  event_type         text        not null,
  -- Hoy sólo WEB_PUSH. SMS, WHATSAPP y EMAIL entran acá sin tocar nada de lo
  -- que detecta los eventos: cada canal es un despachador que lee la misma cola.
  channel            text        not null default 'WEB_PUSH'
                                 check (channel in ('WEB_PUSH', 'SMS', 'WHATSAPP', 'EMAIL')),

  -- PERMISSION: todos los que tengan el permiso `required_permission`.
  -- USER: sólo `user_id`. ROLE: los que tengan `role_id`.
  audience           text        not null default 'PERMISSION'
                                 check (audience in ('PERMISSION', 'ROLE', 'USER')),
  required_permission text       not null default 'plc.read',
  role_id            uuid        references public.roles(id) on delete cascade,
  user_id            uuid        references public.profiles(id) on delete cascade,

  -- Nombre de la columna de push_subscriptions que el usuario puede apagar.
  subscription_flag  text        check (subscription_flag in (
                                   'wash_notifications',
                                   'machine_error_notifications',
                                   'daily_close_notifications')),

  enabled            boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint notification_rules_unica unique (organization_id, event_type, channel)
);

comment on table public.notification_rules is
  'Evento → destinatario → canal. Agregar un tipo de notificación es insertar acá, no escribir una función.';

alter table public.notification_rules enable row level security;

drop policy if exists "notification_rules_select" on public.notification_rules;
create policy "notification_rules_select"
  on public.notification_rules for select
  using (organization_id = public.get_my_organization_id());

drop policy if exists "notification_rules_manage" on public.notification_rules;
create policy "notification_rules_manage"
  on public.notification_rules for all
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.manage'))
  with check (organization_id = public.get_my_organization_id()
              and public.has_permission('plc.manage'));

insert into public.notification_rules
  (organization_id, event_type, channel, audience, required_permission, subscription_flag)
select o.id, r.tipo, 'WEB_PUSH', 'PERMISSION', 'plc.read', r.flag
  from public.organizations o
  cross join (values
    ('WASH_COMPLETED', 'wash_notifications'),
    ('MACHINE_ERROR',  'machine_error_notifications'),
    ('DAILY_CLOSE',    'daily_close_notifications'),
    -- El push de prueba no tiene casilla: apagarlo haría imposible probar si
    -- las notificaciones funcionan, que es justo para lo que existe.
    ('TEST',           null)
  ) as r(tipo, flag)
on conflict (organization_id, event_type, channel) do nothing;


-- ─────────────────────────────────────────────
-- 3.3 Las entregas: una fila por (evento, dispositivo)
--
--     La UNIQUE es lo que hace que un despachador que se reinicia a mitad de
--     tanda no reenvíe lo ya enviado. El registro por dispositivo es también
--     lo que permite responder «¿por qué a mí no me llegó?» sin adivinar.
-- ─────────────────────────────────────────────
create table if not exists public.notification_deliveries (
  id                    uuid        primary key default gen_random_uuid(),
  notification_event_id uuid        not null references public.notification_events(id) on delete cascade,
  subscription_id       uuid        references public.push_subscriptions(id) on delete set null,

  channel               text        not null default 'WEB_PUSH',
  -- Copia del endpoint y del nombre al momento del envío: si después el
  -- dispositivo se borra, el log tiene que seguir diciendo a dónde se mandó.
  endpoint              text,
  device_name           text,
  user_id               uuid        references public.profiles(id) on delete set null,

  status                text        not null default 'PENDING'
                                    check (status in ('PENDING', 'SENT', 'FAILED', 'EXPIRED', 'SKIPPED')),
  attempts              int         not null default 0,
  http_status           int,
  provider_error        text,

  created_at            timestamptz not null default now(),
  sent_at               timestamptz,
  failed_at             timestamptz,

  constraint notification_deliveries_unica unique (notification_event_id, subscription_id)
);

comment on table public.notification_deliveries is
  'Un intento de entrega por dispositivo y evento. La UNIQUE evita el reenvío cuando el despachador se reinicia.';

create index if not exists idx_deliveries_pendientes
  on public.notification_deliveries(notification_event_id)
  where status = 'PENDING';
create index if not exists idx_deliveries_sub
  on public.notification_deliveries(subscription_id, created_at desc);

alter table public.notification_deliveries enable row level security;

drop policy if exists "notification_deliveries_select" on public.notification_deliveries;
create policy "notification_deliveries_select"
  on public.notification_deliveries for select
  using (
    user_id = auth.uid()
    or exists (select 1 from public.notification_events e
                where e.id = notification_event_id
                  and e.organization_id = public.get_my_organization_id()
                  and public.has_permission('users.manage'))
  );


-- ═════════════════════════════════════════════════════════════
-- PARTE 4 — INCIDENTES Y CIERRES
--
--   Dos tablas de estado. Existen porque las dos preguntas que hay que
--   responder no son «¿pasó algo?» sino «¿esto ya lo avisamos?», y esa
--   pregunta necesita memoria.
-- ═════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 4.1 Incidentes de falla
--
--     Una máquina en falla emite el mismo estado durante horas. Sin esto,
--     cada lectura del PLC sería un push, el teléfono vibraría cada segundo y
--     a los diez minutos nadie miraría más una alerta de CORSA.
--
--     La máquina de estados que pide la especificación es exactamente el
--     índice único de abajo: NO PUEDE haber dos incidentes abiertos para la
--     misma máquina. Mientras uno esté abierto, el evento nuevo no crea nada
--     y por lo tanto no notifica. Cuando la falla se limpia, el incidente se
--     cierra y la próxima falla vuelve a ser un incidente nuevo — y un push
--     nuevo, que es lo correcto: es otro incidente.
--
--     Queda además como el registro de fallas y downtime que el negocio va a
--     querer graficar.
-- ─────────────────────────────────────────────
create table if not exists public.machine_error_incidents (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  machine_id        text        not null,
  gateway_id        text,

  started_at        timestamptz not null,
  resolved_at       timestamptz,
  -- Null mientras esté abierto: es lo que se grafica como downtime cuando cierra.
  duration_seconds  int,

  -- Lo que el PLC haya dicho. Puede venir vacío, y la notificación está
  -- escrita para ese caso: «Revisar máquina».
  error_code        text,
  error_description text,
  -- El evento crudo que lo abrió y el que lo cerró. La auditoría completa.
  source_event_id   uuid,
  resolved_event_id uuid,
  resolved_by       text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.machine_error_incidents is
  'Un incidente por falla, no por lectura del PLC. El índice parcial de abajo es la máquina de estados NORMAL→ERROR→NORMAL.';

-- ESTO es la regla ERROR→ERROR = no notificar. No hay código que la
-- implemente: la implementa la base rechazando el segundo incidente abierto.
create unique index if not exists uniq_incidente_abierto
  on public.machine_error_incidents(organization_id, machine_id)
  where resolved_at is null;

create index if not exists idx_incidentes_maquina
  on public.machine_error_incidents(organization_id, machine_id, started_at desc);

alter table public.machine_error_incidents enable row level security;

drop policy if exists "machine_error_incidents_select" on public.machine_error_incidents;
create policy "machine_error_incidents_select"
  on public.machine_error_incidents for select
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.read'));


-- ─────────────────────────────────────────────
-- 4.2 Cierres del día
--
--     Una fila por día operativo, y la PK compuesta garantiza que no haya dos.
--     Si a las once de la noche alguien enciende una máquina por error, el día
--     ya está cerrado y no se vuelve a cerrar: la fila existe.
-- ─────────────────────────────────────────────
create table if not exists public.daily_closes (
  organization_id   uuid        not null references public.organizations(id) on delete cascade,
  -- El día del carwash (corsa_hoy()), no el día UTC.
  fecha_operativa   date        not null,

  cerrado_at        timestamptz not null default now(),
  -- MAQUINAS_APAGADAS | HORA_TOPE | MANUAL | SIMULADO
  motivo            text        not null,
  -- En prosa: qué se vio exactamente para decidirlo. Es lo que se lee cuando
  -- alguien pregunta por qué el cierre llegó a las 7 y no a las 9.
  deteccion         text,

  total_lavados     int         not null default 0,
  -- Por máquina: { "machine-1": { "lavados": 18, "pro": 7, ..., "busy_seconds": 9660 } }
  resumen           jsonb       not null default '{}'::jsonb,

  -- 'SISTEMA' o el id del usuario que lo forzó.
  generado_por      text        not null default 'SISTEMA',
  notification_event_id uuid    references public.notification_events(id) on delete set null,
  notification_sent_at  timestamptz,

  primary key (organization_id, fecha_operativa)
);

comment on table public.daily_closes is
  'Un cierre por día operativo. La llave primaria es la garantía de que no hay dos.';

alter table public.daily_closes enable row level security;

drop policy if exists "daily_closes_select" on public.daily_closes;
create policy "daily_closes_select"
  on public.daily_closes for select
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.read'));


-- ═════════════════════════════════════════════════════════════
-- PARTE 5 — CÓMO SE ESCRIBE UNA NOTIFICACIÓN
--
--   Las funciones de texto viven acá y no en el frontend porque el frontend no
--   está abierto cuando esto ocurre. El Service Worker recibe el texto ya
--   armado; su trabajo es mostrarlo, no interpretarlo.
-- ═════════════════════════════════════════════════════════════

-- «machine-2» no se le muestra a nadie. Se usa el nombre que tenga la máquina
-- y, si no tiene, se arma «Máquina N» con el número del código — que es como
-- el equipo las llama.
create or replace function public.corsa_nombre_maquina(p_org uuid, p_machine text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select nullif(m.name, m.machine_code)
       from public.plc_machines m
      where m.organization_id = p_org and m.machine_code = p_machine),
    case when p_machine ~ '(\d+)\s*$'
         then 'Máquina ' || (regexp_match(p_machine, '(\d+)\s*$'))[1]
         else p_machine end
  )
$$;

grant execute on function public.corsa_nombre_maquina(uuid, text) to authenticated, service_role;

-- PRO / ELITE / SIGNATURE son los nombres comerciales. «corto», «medio» y
-- «largo» son cómo se deducen, no cómo se venden, y no aparecen nunca en una
-- notificación.
create or replace function public.corsa_nombre_servicio(p_servicio text)
returns text
language sql
immutable
as $$
  select case upper(coalesce(p_servicio, ''))
           when 'PRO'       then 'Pro'
           when 'ELITE'     then 'Elite'
           when 'SIGNATURE' then 'Signature'
           else null
         end
$$;

grant execute on function public.corsa_nombre_servicio(text) to anon, authenticated, service_role;

-- 522 s → «8m 42s». Segundos crudos en una notificación obligan a dividir
-- mentalmente, y nadie lo hace: se saltea el dato.
create or replace function public.corsa_duracion_humana(p_segundos int)
returns text
language sql
immutable
as $$
  select case
    when p_segundos is null or p_segundos <= 0 then null
    when p_segundos < 60 then p_segundos || 's'
    when p_segundos < 3600 then (p_segundos / 60) || 'm ' || lpad((p_segundos % 60)::text, 2, '0') || 's'
    else (p_segundos / 3600) || 'h ' || lpad(((p_segundos % 3600) / 60)::text, 2, '0') || 'm'
  end
$$;

grant execute on function public.corsa_duracion_humana(int) to anon, authenticated, service_role;

-- El acumulado del día, sumando TODAS las máquinas. Usa exactamente las mismas
-- funciones que el tablero —corsa_cuenta_como_lavado y el día de El Salvador—
-- para que el número del push y el de la pantalla no puedan discrepar.
create or replace function public.corsa_lavados_del_dia(p_org uuid, p_fecha date default null)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from public.plc_wash_cycles c
   where c.organization_id = p_org
     and public.corsa_cuenta_como_lavado(c.status)
     and c.started_at >= public.corsa_inicio_del_dia(coalesce(p_fecha, public.corsa_hoy()))
     and c.started_at <  public.corsa_fin_del_dia(coalesce(p_fecha, public.corsa_hoy()))
$$;

grant execute on function public.corsa_lavados_del_dia(uuid, date) to authenticated, service_role;


-- ─────────────────────────────────────────────
-- 5.1 El resumen del día, por máquina
--
--     Devuelve el objeto que después lee tanto el push como la pantalla de
--     cierre diario. Una sola consulta, para que las dos digan lo mismo.
-- ─────────────────────────────────────────────
create or replace function public.corsa_resumen_del_dia(p_org uuid, p_fecha date default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with dia as (
    select coalesce(p_fecha, public.corsa_hoy()) as f
  ),
  ciclos as (
    select c.*
      from public.plc_wash_cycles c, dia
     where c.organization_id = p_org
       and c.started_at >= public.corsa_inicio_del_dia(dia.f)
       and c.started_at <  public.corsa_fin_del_dia(dia.f)
  ),
  por_maquina as (
    select
      c.machine_id,
      public.corsa_nombre_maquina(p_org, c.machine_id)                     as nombre,
      count(*) filter (where public.corsa_cuenta_como_lavado(c.status))    as lavados,
      count(*) filter (where c.service_type = 'PRO')                       as pro,
      count(*) filter (where c.service_type = 'ELITE')                     as elite,
      count(*) filter (where c.service_type = 'SIGNATURE')                 as signature,
      count(*) filter (where public.corsa_cuenta_como_lavado(c.status)
                         and c.service_type = 'UNKNOWN')                   as unknown,
      count(*) filter (where c.status = 'FAULTED')                         as faulted,
      count(*) filter (where c.status = 'STOPPED')                         as interrumpidos,
      -- Tiempo efectivamente lavando. Sólo de los ciclos que cuentan: sumar
      -- los interrumpidos inflaría el tiempo de trabajo con ciclos que no
      -- produjeron nada.
      coalesce(sum(c.duration_seconds) filter (
        where public.corsa_cuenta_como_lavado(c.status)), 0)::int          as busy_seconds,
      min(c.started_at)                                                    as primer_lavado,
      max(c.completed_at)                                                  as ultimo_lavado
    from ciclos c
    group by c.machine_id
  )
  select jsonb_build_object(
    'fecha', (select f from dia),
    'total_lavados', coalesce((select sum(lavados) from por_maquina), 0),
    'total_pro', coalesce((select sum(pro) from por_maquina), 0),
    'total_elite', coalesce((select sum(elite) from por_maquina), 0),
    'total_signature', coalesce((select sum(signature) from por_maquina), 0),
    'total_busy_seconds', coalesce((select sum(busy_seconds) from por_maquina), 0),
    'primer_lavado', (select min(primer_lavado) from por_maquina),
    'ultimo_lavado', (select max(ultimo_lavado) from por_maquina),
    'maquinas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'machine_id', machine_id,
        'nombre', nombre,
        'lavados', lavados,
        'pro', pro,
        'elite', elite,
        'signature', signature,
        'unknown', unknown,
        'faulted', faulted,
        'interrumpidos', interrumpidos,
        'busy_seconds', busy_seconds,
        'primer_lavado', primer_lavado,
        'ultimo_lavado', ultimo_lavado
      ) order by machine_id)
      from por_maquina), '[]'::jsonb)
  )
$$;

comment on function public.corsa_resumen_del_dia(uuid, date) is
  'El cierre del día en un objeto. Lo leen el push y la pantalla /dashboard/cierre-diario: una sola consulta para que no puedan discrepar.';

grant execute on function public.corsa_resumen_del_dia(uuid, date) to authenticated, service_role;


-- ═════════════════════════════════════════════════════════════
-- PARTE 6 — EMITIR UN EVENTO
--
--   La única puerta de entrada a la cola. Todo lo que quiera notificar algo
--   —hoy tres triggers, mañana lo que sea— pasa por acá.
-- ═════════════════════════════════════════════════════════════

create or replace function public.corsa_emitir_notificacion(
  p_org          uuid,
  p_tipo         text,
  p_clave        text,
  p_titulo       text,
  p_cuerpo       text,
  p_deep_link    text    default null,
  p_metadata     jsonb   default '{}'::jsonb,
  p_machine_id   text    default null,
  p_wash_id      uuid    default null,
  p_service_type text    default null,
  p_severidad    text    default 'INFO'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id  uuid;
  v_cfg public.corsa_notification_config;
begin
  v_cfg := public.corsa_config_notificaciones(p_org);
  if not v_cfg.enabled then
    return null;
  end if;

  -- Sin ninguna regla activa para este tipo, el evento no tendría a quién ir.
  -- Se registra igual —el centro de notificaciones dentro de CORSA lo va a
  -- mostrar— pero marcado SKIPPED, que es la verdad: no se intentó enviar.
  insert into public.notification_events (
    organization_id, event_type, severity, machine_id, wash_id, service_type,
    title, body, deep_link, metadata, idempotency_key, status
  ) values (
    p_org, p_tipo, p_severidad, p_machine_id, p_wash_id, p_service_type,
    p_titulo, p_cuerpo, p_deep_link, coalesce(p_metadata, '{}'::jsonb), p_clave,
    case when exists (
      select 1 from public.notification_rules r
       where r.organization_id = p_org and r.event_type = p_tipo and r.enabled
    ) then 'PENDING' else 'SKIPPED' end
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  -- v_id null significa que la clave ya existía: este hecho ya se notificó.
  -- No es un error y no se registra como tal — es el sistema funcionando.
  return v_id;
end $$;

comment on function public.corsa_emitir_notificacion is
  'Única puerta de entrada a la cola de notificaciones. Devuelve null si el hecho ya se había notificado.';

revoke all on function public.corsa_emitir_notificacion(uuid, text, text, text, text, text, jsonb, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.corsa_emitir_notificacion(uuid, text, text, text, text, text, jsonb, text, uuid, text, text)
  to service_role;


-- ═════════════════════════════════════════════════════════════
-- PARTE 7 — EVENTO 1: LAVADO FINALIZADO
--
--   Trigger sobre plc_wash_cycles y no una llamada dentro de
--   plc_derive_from_event, por las dos razones de la cabecera: cubre las dos
--   rutas de ingesta que hoy conviven, y observa la verdad en lugar de
--   recalcularla.
--
--   CUÁNDO DISPARA
--     Cuando un ciclo queda con un estado que cuenta como lavado y con hora
--     de cierre. Puede dispararse varias veces por el mismo lavado —la
--     derivación cierra el ciclo y después lo clasifica, y son dos UPDATE—
--     y no importa: la clave idempotente es el id del ciclo, así que del
--     segundo en adelante no pasa nada.
--
--   POR QUÉ HAY UNA VENTANA DE FRESCURA
--     corsa_reclasificar_lavados() reescribe hasta noventa días de ciclos.
--     Sin el filtro por antigüedad, correrla mandaría miles de pushes de
--     lavados de hace tres meses. La regla es simple: se notifica lo que acaba
--     de pasar, no lo que se acaba de recalcular.
-- ═════════════════════════════════════════════════════════════

create or replace function public.corsa_tg_lavado_finalizado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg      public.corsa_notification_config;
  v_servicio text;
  v_nombre   text;
  v_dur      text;
  v_hoy      int;
  v_cuerpo   text;
begin
  if not public.corsa_cuenta_como_lavado(new.status) or new.completed_at is null then
    return null;
  end if;

  v_cfg := public.corsa_config_notificaciones(new.organization_id);
  if not v_cfg.enabled then return null; end if;

  -- La ventana de frescura. Ver arriba.
  if new.completed_at < now() - make_interval(mins => v_cfg.ventana_frescura_minutos) then
    return null;
  end if;

  -- Si la clasificación todavía no corrió —este trigger puede dispararse
  -- entre el UPDATE que cierra el ciclo y el que lo clasifica— se resuelve el
  -- servicio con la MISMA función que usa el clasificador. No es un segundo
  -- criterio: es el mismo, preguntado un instante antes.
  v_servicio := case
    when new.service_type in ('PRO', 'ELITE', 'SIGNATURE') then new.service_type
    else public.corsa_servicio_de(new.organization_id, new.machine_id, new.duration_seconds)
  end;

  v_nombre := public.corsa_nombre_maquina(new.organization_id, new.machine_id);
  v_dur    := public.corsa_duracion_humana(new.duration_seconds);
  v_hoy    := public.corsa_lavados_del_dia(new.organization_id);

  -- Tres líneas cortas: en el teléfono, la notificación colapsada muestra la
  -- primera y poco más. Lo importante va arriba.
  v_cuerpo := coalesce('Lavado ' || public.corsa_nombre_servicio(v_servicio) || ' finalizado',
                       'Lavado finalizado');
  if v_dur is not null then
    v_cuerpo := v_cuerpo || E'\nDuración: ' || v_dur;
  end if;
  v_cuerpo := v_cuerpo || E'\nHoy: ' || v_hoy || case when v_hoy = 1 then ' lavado' else ' lavados' end;

  perform public.corsa_emitir_notificacion(
    p_org          => new.organization_id,
    p_tipo         => 'WASH_COMPLETED',
    -- El id del ciclo. Ya existe, ya es único, y sobrevive a cualquier
    -- reproceso: es la identidad del lavado, no la del envío.
    p_clave        => 'wash-' || new.id::text,
    p_titulo       => '🚗 CORSA — ' || v_nombre,
    p_cuerpo       => v_cuerpo,
    p_deep_link    => '/machines?maquina=' || new.machine_id,
    p_metadata     => jsonb_build_object(
                        'machine_name', v_nombre,
                        'duration_seconds', new.duration_seconds,
                        'duration_label', v_dur,
                        'washes_today', v_hoy,
                        'status', new.status,
                        'closed_by', new.closed_by,
                        'started_at', new.started_at,
                        'completed_at', new.completed_at),
    p_machine_id   => new.machine_id,
    p_wash_id      => new.id,
    p_service_type => v_servicio,
    p_severidad    => 'INFO'
  );

  return null;
exception when others then
  -- Las máquinas no dependen de las notificaciones. Si algo de esto falla, el
  -- lavado ya quedó guardado y tiene que seguir así: propagar el error
  -- abortaría la transacción de ingesta y el carwash perdería el registro de
  -- un lavado real por culpa de un push.
  raise warning 'CORSA notificaciones: falló el aviso de lavado % (%)', new.id, sqlerrm;
  return null;
end $$;

drop trigger if exists tg_corsa_lavado_finalizado on public.plc_wash_cycles;
create trigger tg_corsa_lavado_finalizado
  after insert or update of status, service_type, completed_at, duration_seconds
  on public.plc_wash_cycles
  for each row
  execute function public.corsa_tg_lavado_finalizado();


-- ═════════════════════════════════════════════════════════════
-- PARTE 8 — EVENTO 2: ERROR DE MÁQUINA
--
--   La máquina de estados vive en el índice único de machine_error_incidents:
--   mientras haya un incidente abierto para esa máquina, abrir otro es
--   imposible, y por lo tanto notificar de nuevo también.
--
--       NORMAL → ERROR   abre incidente   → push
--       ERROR  → ERROR   no abre nada     → sin push
--       ERROR  → NORMAL  cierra incidente → sin push
--       NORMAL → ERROR   abre otro        → push
--
--   Hay dos triggers porque hay dos rutas de ingesta: el Worker deriva y
--   escribe plc_machine_status; la Edge Function sólo escribe los eventos
--   crudos. Los dos terminan llamando a la misma función, y el incidente
--   abierto hace que el segundo en llegar no duplique nada.
-- ═════════════════════════════════════════════════════════════

create or replace function public.corsa_abrir_incidente(
  p_org        uuid,
  p_machine    text,
  p_gateway    text,
  p_at         timestamptz,
  p_event_id   uuid    default null,
  p_codigo     text    default null,
  p_desc       text    default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_nombre text;
  v_cuerpo text;
  v_cfg    public.corsa_notification_config;
begin
  v_cfg := public.corsa_config_notificaciones(p_org);
  if not v_cfg.enabled then return null; end if;
  if p_at < now() - make_interval(mins => v_cfg.ventana_frescura_minutos) then
    return null;
  end if;

  insert into public.machine_error_incidents (
    organization_id, machine_id, gateway_id, started_at,
    error_code, error_description, source_event_id
  ) values (
    p_org, p_machine, p_gateway, p_at,
    nullif(trim(coalesce(p_codigo, '')), ''),
    nullif(trim(coalesce(p_desc, '')), ''),
    p_event_id
  )
  -- Ya hay uno abierto para esta máquina: la falla sigue siendo la misma.
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    return null;
  end if;

  v_nombre := public.corsa_nombre_maquina(p_org, p_machine);

  -- El cuerpo se arma con lo que haya. Si el PLC no dio código ni
  -- descripción, la notificación no dice menos de lo que sabe: dice que hay
  -- que ir a ver, que es toda la acción que se puede tomar con ese dato.
  v_cuerpo := 'ERROR DETECTADO';
  if p_codigo is not null and trim(p_codigo) <> '' then
    v_cuerpo := v_cuerpo || E'\nCódigo: ' || trim(p_codigo);
  end if;
  if p_desc is not null and trim(p_desc) <> '' then
    v_cuerpo := v_cuerpo || E'\n' || trim(p_desc);
  end if;
  if (p_codigo is null or trim(p_codigo) = '') and (p_desc is null or trim(p_desc) = '') then
    v_cuerpo := v_cuerpo || E'\nRevisar máquina.';
  end if;
  v_cuerpo := v_cuerpo || E'\nHora: ' ||
    to_char(p_at at time zone 'America/El_Salvador', 'HH12:MI AM');

  perform public.corsa_emitir_notificacion(
    p_org        => p_org,
    p_tipo       => 'MACHINE_ERROR',
    -- El id del incidente, no el del evento del PLC: si el PLC repite la
    -- señal, el incidente sigue siendo uno solo y la clave no cambia.
    p_clave      => 'machine-error-' || v_id::text,
    p_titulo     => '⚠️ CORSA — ' || v_nombre,
    p_cuerpo     => v_cuerpo,
    p_deep_link  => '/machines?maquina=' || p_machine,
    p_metadata   => jsonb_build_object(
                      'incident_id', v_id,
                      'machine_name', v_nombre,
                      'error_code', p_codigo,
                      'error_description', p_desc,
                      'started_at', p_at),
    p_machine_id => p_machine,
    p_severidad  => 'CRITICAL'
  );

  return v_id;
end $$;

revoke all on function public.corsa_abrir_incidente(uuid, text, text, timestamptz, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.corsa_abrir_incidente(uuid, text, text, timestamptz, uuid, text, text)
  to service_role;


-- Cerrar no notifica. Que una máquina se recupere no es una urgencia, y una
-- alerta por cada recuperación duplicaría el ruido justo cuando la falla es
-- intermitente — que es cuando más importa que las alertas se sigan leyendo.
create or replace function public.corsa_cerrar_incidente(
  p_org      uuid,
  p_machine  text,
  p_at       timestamptz,
  p_event_id uuid default null,
  p_por      text default 'FAULT_CLEARED'
) returns void
language sql
security definer
set search_path = public
as $$
  update public.machine_error_incidents
     set resolved_at = p_at,
         duration_seconds = greatest(0, extract(epoch from (p_at - started_at))::int),
         resolved_event_id = p_event_id,
         resolved_by = p_por,
         updated_at = now()
   where organization_id = p_org
     and machine_id = p_machine
     and resolved_at is null
     and p_at >= started_at
$$;

revoke all on function public.corsa_cerrar_incidente(uuid, text, timestamptz, uuid, text)
  from public, anon, authenticated;
grant execute on function public.corsa_cerrar_incidente(uuid, text, timestamptz, uuid, text) to service_role;


-- ─────────────────────────────────────────────
-- 8.1 Ruta A — el evento crudo (cubre las dos ingestas)
-- ─────────────────────────────────────────────
create or replace function public.corsa_tg_falla_desde_evento()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codigo text;
  v_desc   text;
begin
  if new.event_type in ('FAULT_STARTED', 'MACHINE_FAULT') then
    -- Del payload crudo, con los nombres que el gateway podría usar. Ninguno
    -- es obligatorio: hoy el PLC no informa código, y la notificación está
    -- escrita para funcionar sin él.
    v_codigo := coalesce(
      new.payload->'data'->>'error_code',
      new.payload->'data'->>'fault_code',
      new.payload->'data'->>'code',
      new.new_value);
    v_desc := coalesce(
      new.payload->'data'->>'error_description',
      new.payload->'data'->>'fault_description',
      new.payload->'data'->>'description');

    perform public.corsa_abrir_incidente(
      new.organization_id, new.machine_id, new.gateway_id,
      new.event_timestamp, new.id, v_codigo, v_desc);

  elsif new.event_type in ('FAULT_CLEARED', 'MACHINE_READY') then
    perform public.corsa_cerrar_incidente(
      new.organization_id, new.machine_id, new.event_timestamp, new.id, new.event_type);
  end if;

  return null;
exception when others then
  raise warning 'CORSA notificaciones: falló el aviso de falla del evento % (%)', new.id, sqlerrm;
  return null;
end $$;

drop trigger if exists tg_corsa_falla_evento on public.plc_machine_events;
create trigger tg_corsa_falla_evento
  after insert on public.plc_machine_events
  for each row
  execute function public.corsa_tg_falla_desde_evento();


-- ─────────────────────────────────────────────
-- 8.2 Ruta B — el estado derivado
--
--     Existe para el caso en que el estado llegue a FAULT por un camino que no
--     sea un evento de falla —hoy no ocurre, pero el heartbeat ya escribe
--     estados y mañana podría hacerlo otra cosa—. Si el evento crudo ya abrió
--     el incidente, esto no abre nada: el índice único lo impide.
-- ─────────────────────────────────────────────
create or replace function public.corsa_tg_falla_desde_estado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'FAULT' and (tg_op = 'INSERT' or old.status is distinct from 'FAULT') then
    perform public.corsa_abrir_incidente(
      new.organization_id, new.machine_id, new.gateway_id,
      new.last_event_timestamp, null, null, null);

  elsif new.status in ('READY', 'WASHING', 'ONLINE')
    and tg_op = 'UPDATE' and old.status = 'FAULT' then
    perform public.corsa_cerrar_incidente(
      new.organization_id, new.machine_id, new.last_event_timestamp, null, new.last_event_type);
  end if;

  return null;
exception when others then
  raise warning 'CORSA notificaciones: falló el aviso de estado de % (%)', new.machine_id, sqlerrm;
  return null;
end $$;

drop trigger if exists tg_corsa_falla_estado on public.plc_machine_status;
create trigger tg_corsa_falla_estado
  after insert or update of status on public.plc_machine_status
  for each row
  execute function public.corsa_tg_falla_desde_estado();


-- ═════════════════════════════════════════════════════════════
-- PARTE 9 — EVENTO 3: CIERRE DEL DÍA
--
--   ESTA ES LA PARTE DELICADA, y conviene dejar escrito por qué.
--
--   «Se terminó la operación» no es un dato que exista en ninguna parte. Hay
--   que deducirlo, y la deducción ingenua —«dejaron de llegar datos, entonces
--   cerraron»— es falsa la primera vez que se cae el Internet a las tres de
--   la tarde. El resumen del día llegaría en plena hora pico, con la mitad de
--   los lavados, y a partir de ese día nadie volvería a creerle.
--
--   QUÉ SEÑALES HAY, Y QUÉ SIGNIFICA CADA UNA
--
--   1. El heartbeat del gateway (cada 30 s) trae `machines`, donde el gateway
--      dice de cada máquina si logra hablarle por Modbus.
--
--      Esa es la señal buena, y lo es por un motivo preciso: SEPARA las dos
--      cosas que se confunden. Si el gateway está latiendo y dice que la
--      máquina no responde, el observador está vivo y lo que se apagó es la
--      máquina. Si el gateway no late, no sabemos nada de las máquinas — y no
--      saber no es lo mismo que saber que están apagadas.
--
--   2. plc_machine_status.status = 'OFFLINE', que la derivación escribe desde
--      PLC_DISCONNECTED / MACHINE_OFFLINE. Es la misma información por otra
--      vía; sirve de respaldo cuando el heartbeat no trae `machines`.
--
--   LO QUE SE DECIDIÓ
--
--   Cierre por MAQUINAS_APAGADAS — el camino normal. Requiere las cuatro:
--     · el gateway está latiendo ahora (hay un observador vivo);
--     · TODAS las máquinas activas están reportadas como apagadas;
--     · lo están de forma sostenida desde hace `cierre_ventana_minutos`
--       (45 por defecto). Una caída de red de cinco minutos no alcanza;
--     · es más tarde que `cierre_hora_minima` (14:00 por defecto). A las diez
--       de la mañana, dos máquinas apagadas son un corte de luz, no un cierre.
--
--   Cierre por HORA_TOPE — la red de seguridad. Para la noche en que el
--   gateway se apaga junto con el local y por lo tanto nunca llega a reportar
--   las máquinas apagadas. Requiere:
--     · pasó la `cierre_hora_tope` (23:30);
--     · hubo lavados hoy;
--     · hace `cierre_inactividad_minutos` (90) que no termina ninguno.
--
--   Y la condición que gobierna las dos: si hoy no hubo NINGÚN lavado, no se
--   cierra nada. Un domingo sin operación no necesita un resumen que diga
--   cero — y además es indistinguible de un día en que el sistema estuvo caído.
--
--   LO QUE NO SE HACE
--   No se cierra un día pasado automáticamente. Si toda la tarde el sistema
--   estuvo caído y nadie pudo evaluar, ese día se queda sin cierre automático
--   y se cierra a mano con corsa_cerrar_dia_manual(). Mandar el resumen de
--   ayer a las ocho de la mañana de hoy confunde más de lo que informa.
-- ═════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 9.1 Desde cuándo está apagada una máquina
--
--     El primer latido que la reportó apagada DESPUÉS del último que la
--     reportó encendida. Null = no está apagada, o nunca se supo de ella.
--
--     Se mira así y no «hace cuánto que no la vemos» porque son preguntas
--     distintas: una máquina encendida y ociosa no genera eventos durante
--     horas y seguiría estando encendida.
-- ─────────────────────────────────────────────
create or replace function public.corsa_maquina_apagada_desde(
  p_org     uuid,
  p_machine text
) returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  with encendida as (
    select max(h.reported_at) as at
      from public.plc_gateway_heartbeats h,
           lateral jsonb_array_elements(coalesce(h.machines, '[]'::jsonb)) m
     where h.organization_id = p_org
       and m->>'machine_id' = p_machine
       and coalesce(m->>'online', '') in ('true', 't', '1')
       -- Doce horas cubre cualquier jornada. Mirar más atrás no cambia
       -- ninguna respuesta —una máquina apagada hace doce horas no lavó hoy,
       -- y sin lavados no hay cierre— y multiplica lo que hay que recorrer.
       and h.reported_at > now() - interval '12 hours'
  ),
  apagada as (
    select min(h.reported_at) as at
      from public.plc_gateway_heartbeats h,
           lateral jsonb_array_elements(coalesce(h.machines, '[]'::jsonb)) m,
           encendida e
     where h.organization_id = p_org
       and m->>'machine_id' = p_machine
       and coalesce(m->>'online', '') in ('false', 'f', '0')
       and h.reported_at > now() - interval '12 hours'
       and h.reported_at > coalesce(e.at, '-infinity'::timestamptz)
  )
  select coalesce(
    (select at from apagada),
    -- Respaldo: el estado derivado. Sólo vale si es más nuevo que el último
    -- latido que la vio encendida; si no, es información vieja.
    (select s.last_event_timestamp
       from public.plc_machine_status s, encendida e
      where s.organization_id = p_org
        and s.machine_id = p_machine
        and s.status = 'OFFLINE'
        and s.last_event_timestamp > coalesce(e.at, '-infinity'::timestamptz))
  )
$$;

comment on function public.corsa_maquina_apagada_desde(uuid, text) is
  'Desde cuándo el gateway reporta esta máquina como apagada. Null significa encendida o desconocida: no son lo mismo que apagada.';

grant execute on function public.corsa_maquina_apagada_desde(uuid, text) to authenticated, service_role;


-- ─────────────────────────────────────────────
-- 9.2 Qué se ve ahora mismo
--
--     Una función que devuelve el diagnóstico completo, en vez de un booleano.
--     Sirve para decidir el cierre y también para mostrarlo en pantalla: la
--     pregunta «¿por qué todavía no cerró el día?» tiene que tener respuesta
--     sin abrir el SQL Editor.
-- ─────────────────────────────────────────────
create or replace function public.corsa_estado_operativo(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg         public.corsa_notification_config;
  v_gw_online   boolean;
  v_gw_ultimo   timestamptz;
  v_maquinas    jsonb;
  v_total       int;
  v_apagadas    int;
  v_apagada_max timestamptz;
  v_ultimo      timestamptz;
  v_lavados     int;
begin
  v_cfg := public.corsa_config_notificaciones(p_org);

  select max(g.last_seen_at) into v_gw_ultimo
    from public.plc_gateways g
   where g.organization_id = p_org and g.active;

  v_gw_online := v_gw_ultimo is not null
             and v_gw_ultimo > now() - make_interval(mins => v_cfg.gateway_offline_minutos);

  select
    jsonb_agg(jsonb_build_object(
      'machine_id', x.machine_code,
      'nombre', public.corsa_nombre_maquina(p_org, x.machine_code),
      'estado', x.status,
      'apagada_desde', x.apagada_desde,
      'minutos_apagada', case when x.apagada_desde is null then null
                              else floor(extract(epoch from (now() - x.apagada_desde)) / 60)::int end
    ) order by x.machine_code),
    count(*)::int,
    count(*) filter (where x.apagada_desde is not null)::int,
    max(x.apagada_desde)
  into v_maquinas, v_total, v_apagadas, v_apagada_max
  from (
    select m.machine_code,
           s.status,
           public.corsa_maquina_apagada_desde(p_org, m.machine_code) as apagada_desde
      from public.plc_machines m
      left join public.plc_machine_status s
             on s.organization_id = m.organization_id and s.machine_id = m.machine_code
     where m.organization_id = p_org and m.active
  ) x;

  select max(c.completed_at) into v_ultimo
    from public.plc_wash_cycles c
   where c.organization_id = p_org
     and public.corsa_cuenta_como_lavado(c.status)
     and c.started_at >= public.corsa_inicio_del_dia();

  v_lavados := public.corsa_lavados_del_dia(p_org);

  return jsonb_build_object(
    'fecha', public.corsa_hoy(),
    'hora_local', to_char(now() at time zone 'America/El_Salvador', 'HH24:MI'),
    'gateway_online', v_gw_online,
    'gateway_ultimo_latido', v_gw_ultimo,
    'maquinas', coalesce(v_maquinas, '[]'::jsonb),
    'maquinas_totales', coalesce(v_total, 0),
    'maquinas_apagadas', coalesce(v_apagadas, 0),
    -- La más reciente de las «apagada desde»: la ventana se cuenta desde que
    -- la ÚLTIMA se apagó, no desde la primera.
    'apagadas_desde', v_apagada_max,
    'lavados_hoy', v_lavados,
    'ultimo_lavado', v_ultimo,
    'cerrado', exists (select 1 from public.daily_closes d
                        where d.organization_id = p_org
                          and d.fecha_operativa = public.corsa_hoy())
  );
end $$;

grant execute on function public.corsa_estado_operativo(uuid) to authenticated, service_role;


-- ─────────────────────────────────────────────
-- 9.3 Registrar el cierre y avisarlo
--
--     Separado de la evaluación a propósito: el cierre manual usa esta misma
--     función, así que hay UN solo lugar que escribe un cierre y arma su
--     notificación. Dos caminos que escriben la misma tabla terminan
--     escribiéndola distinto.
-- ─────────────────────────────────────────────
create or replace function public.corsa_registrar_cierre(
  p_org       uuid,
  p_fecha     date,
  p_motivo    text,
  p_deteccion text,
  p_por       text default 'SISTEMA'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resumen jsonb;
  v_total   int;
  v_linea   text;
  v_cuerpo  text := '';
  v_evento  uuid;
  v_maq     jsonb;
begin
  v_resumen := public.corsa_resumen_del_dia(p_org, p_fecha);
  v_total   := coalesce((v_resumen->>'total_lavados')::int, 0);

  -- La PK (organization_id, fecha_operativa) es la protección contra el doble
  -- cierre. No hay que acordarse de verificar: la base no deja.
  insert into public.daily_closes (
    organization_id, fecha_operativa, motivo, deteccion,
    total_lavados, resumen, generado_por
  ) values (
    p_org, p_fecha, p_motivo, p_deteccion, v_total, v_resumen, p_por
  )
  on conflict (organization_id, fecha_operativa) do nothing;

  if not found then
    return null;   -- Ya estaba cerrado.
  end if;

  -- El cuerpo del push: una línea por máquina y el total. El detalle completo
  -- —servicios, horarios, interrupciones— está en la pantalla a la que lleva
  -- tocarlo. Una notificación de diez líneas la trunca el teléfono y se pierde
  -- justo el total, que es lo único que alguien mira desde la cama.
  for v_maq in select * from jsonb_array_elements(v_resumen->'maquinas')
  loop
    v_linea := (v_maq->>'nombre') || ': ' || (v_maq->>'lavados') ||
               case when (v_maq->>'lavados')::int = 1 then ' lavado' else ' lavados' end;
    if coalesce((v_maq->>'busy_seconds')::int, 0) > 0 then
      v_linea := v_linea || ' · ' ||
                 public.corsa_duracion_humana((v_maq->>'busy_seconds')::int);
    end if;
    v_cuerpo := v_cuerpo || v_linea || E'\n';
  end loop;

  v_cuerpo := v_cuerpo || 'TOTAL: ' || v_total ||
              case when v_total = 1 then ' lavado' else ' lavados' end;

  v_evento := public.corsa_emitir_notificacion(
    p_org        => p_org,
    p_tipo       => 'DAILY_CLOSE',
    -- La clave que pide la especificación. Un día, un cierre, una notificación.
    p_clave      => 'daily-close-' || p_fecha::text,
    p_titulo     => '🌙 CORSA — Cierre del día',
    p_cuerpo     => v_cuerpo,
    p_deep_link  => '/dashboard/cierre-diario?date=' || p_fecha::text,
    p_metadata   => jsonb_build_object(
                      'fecha', p_fecha,
                      'motivo', p_motivo,
                      'deteccion', p_deteccion,
                      'resumen', v_resumen),
    p_severidad  => 'INFO'
  );

  update public.daily_closes
     set notification_event_id = v_evento,
         notification_sent_at = case when v_evento is not null then now() end
   where organization_id = p_org and fecha_operativa = p_fecha;

  return v_evento;
end $$;

revoke all on function public.corsa_registrar_cierre(uuid, date, text, text, text)
  from public, anon, authenticated;
grant execute on function public.corsa_registrar_cierre(uuid, date, text, text, text) to service_role;


-- ─────────────────────────────────────────────
-- 9.4 La evaluación
-- ─────────────────────────────────────────────
create or replace function public.corsa_evaluar_cierre_del_dia(p_org uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_cfg      public.corsa_notification_config;
  v_est      jsonb;
  v_hora     time;
  v_fecha    date;
  v_evento   uuid;
  v_min      int;
  v_result   jsonb := '[]'::jsonb;
  v_motivo   text;
  v_detecc   text;
begin
  for v_org in
    select o.id from public.organizations o
     where p_org is null or o.id = p_org
  loop
    v_cfg := public.corsa_config_notificaciones(v_org);
    if not v_cfg.enabled then continue; end if;

    v_fecha := public.corsa_hoy();

    -- Un solo evaluador a la vez por organización. Los latidos de dos gateways
    -- pueden llegar en el mismo instante, y sin esto los dos evaluarían y los
    -- dos intentarían cerrar; la PK salvaría igual, pero el lock evita el
    -- trabajo y el ruido en el log.
    if not pg_try_advisory_xact_lock(hashtext('corsa_cierre_' || v_org::text)) then
      continue;
    end if;

    v_est  := public.corsa_estado_operativo(v_org);
    v_hora := (now() at time zone 'America/El_Salvador')::time;

    -- Ya cerrado, o no hubo operación que cerrar.
    if (v_est->>'cerrado')::boolean then continue; end if;
    if coalesce((v_est->>'lavados_hoy')::int, 0) = 0 then continue; end if;

    v_motivo := null;

    -- ── Camino normal: las máquinas están apagadas y lo sabemos ──
    if (v_est->>'gateway_online')::boolean
       and coalesce((v_est->>'maquinas_totales')::int, 0) > 0
       and (v_est->>'maquinas_apagadas')::int = (v_est->>'maquinas_totales')::int
       and v_est->>'apagadas_desde' is not null
       and v_hora >= v_cfg.cierre_hora_minima
    then
      v_min := floor(extract(epoch from (now() - (v_est->>'apagadas_desde')::timestamptz)) / 60)::int;
      if v_min >= v_cfg.cierre_ventana_minutos then
        v_motivo := 'MAQUINAS_APAGADAS';
        v_detecc := format(
          'El gateway sigue reportando (último latido %s) y las %s máquinas activas están apagadas desde hace %s minutos, por encima de la ventana de confirmación de %s.',
          to_char((v_est->>'gateway_ultimo_latido')::timestamptz at time zone 'America/El_Salvador', 'HH24:MI'),
          v_est->>'maquinas_totales', v_min, v_cfg.cierre_ventana_minutos);
      end if;
    end if;

    -- ── Red de seguridad: pasó la hora tope y hace rato que no pasa nada ──
    if v_motivo is null and v_hora >= v_cfg.cierre_hora_tope then
      v_min := case when v_est->>'ultimo_lavado' is null then 99999
                    else floor(extract(epoch from (now() - (v_est->>'ultimo_lavado')::timestamptz)) / 60)::int end;
      if v_min >= v_cfg.cierre_inactividad_minutos then
        v_motivo := 'HORA_TOPE';
        v_detecc := format(
          'Pasó la hora tope (%s) y hace %s minutos que no termina un lavado. El gateway %s.',
          to_char(v_cfg.cierre_hora_tope, 'HH24:MI'), v_min,
          case when (v_est->>'gateway_online')::boolean then 'sigue reportando'
               else 'dejó de reportar, así que no se pudo confirmar el estado de las máquinas' end);
      end if;
    end if;

    if v_motivo is not null then
      v_evento := public.corsa_registrar_cierre(v_org, v_fecha, v_motivo, v_detecc, 'SISTEMA');
      v_result := v_result || jsonb_build_object(
        'organization_id', v_org, 'fecha', v_fecha,
        'motivo', v_motivo, 'notification_event_id', v_evento);
    end if;
  end loop;

  return jsonb_build_object('cierres', v_result);
end $$;

comment on function public.corsa_evaluar_cierre_del_dia(uuid) is
  'Decide si la operación del día terminó. Ver la cabecera de la PARTE 9 para la lógica exacta y por qué es esa.';

revoke all on function public.corsa_evaluar_cierre_del_dia(uuid) from public, anon, authenticated;
grant execute on function public.corsa_evaluar_cierre_del_dia(uuid) to service_role;


-- ─────────────────────────────────────────────
-- 9.5 Quién dispara la evaluación
--
--     El latido del gateway, cada 30 segundos. No hace falta un cron: el
--     momento en que llega evidencia nueva sobre el estado de las máquinas es
--     exactamente el momento en que tiene sentido volver a preguntarse si el
--     día terminó.
--
--     El caso que esto NO cubre —el gateway se apaga con el local y deja de
--     latir— es justamente el que atiende la red de seguridad por hora tope, y
--     ésa sí necesita que algo la llame. La llama el despachador de push, que
--     corre cada minuto. Ver docs/NOTIFICACIONES_PUSH.md.
--
--     El filtro por hora es para que esto no corra doscientas veces en una
--     mañana en la que no puede pasar nada.
-- ─────────────────────────────────────────────
create or replace function public.corsa_tg_latido_evalua_cierre()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.corsa_notification_config;
begin
  v_cfg := public.corsa_config_notificaciones(new.organization_id);
  if not v_cfg.enabled then return null; end if;

  if (now() at time zone 'America/El_Salvador')::time < v_cfg.cierre_hora_minima then
    return null;
  end if;

  -- Acelerador, como prueba-y-marca atómico: el UPDATE sólo toca la fila si
  -- pasó el minuto, y `found` dice si le tocó a este latido. Dos gateways
  -- latiendo a la vez no pueden pasar los dos.
  --
  -- Un minuto no retrasa nada: la ventana de confirmación del cierre se mide
  -- en decenas de minutos.
  insert into public.corsa_notification_config as c
    (organization_id, ultima_evaluacion_cierre_at)
  values (new.organization_id, now())
  on conflict (organization_id) do update
     set ultima_evaluacion_cierre_at = now()
   where c.ultima_evaluacion_cierre_at is null
      or c.ultima_evaluacion_cierre_at < now() - interval '60 seconds';

  if not found then return null; end if;

  perform public.corsa_evaluar_cierre_del_dia(new.organization_id);
  return null;
exception when others then
  raise warning 'CORSA notificaciones: falló la evaluación de cierre (%)', sqlerrm;
  return null;
end $$;

drop trigger if exists tg_corsa_latido_cierre on public.plc_gateway_heartbeats;
create trigger tg_corsa_latido_cierre
  after insert on public.plc_gateway_heartbeats
  for each row
  execute function public.corsa_tg_latido_evalua_cierre();


-- ─────────────────────────────────────────────
-- 9.6 Cerrar un día a mano
--
--     Para el día en que la detección no alcanzó. Queda registrado quién lo
--     hizo, que es lo que distingue un cierre del sistema de uno de una
--     persona cuando dentro de tres meses alguien mire la tabla.
-- ─────────────────────────────────────────────
create or replace function public.corsa_cerrar_dia_manual(p_fecha date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid;
  v_fecha  date := coalesce(p_fecha, public.corsa_hoy());
  v_evento uuid;
begin
  if not public.has_permission('plc.manage') then
    raise exception 'Sin permiso para cerrar el día';
  end if;

  v_org := public.get_my_organization_id();
  if v_org is null then
    raise exception 'Usuario sin organización';
  end if;

  v_evento := public.corsa_registrar_cierre(
    v_org, v_fecha, 'MANUAL',
    'Cerrado a mano desde la aplicación.',
    auth.uid()::text);

  if v_evento is null then
    return jsonb_build_object('ok', false, 'motivo', 'El día ya estaba cerrado');
  end if;

  return jsonb_build_object('ok', true, 'notification_event_id', v_evento, 'fecha', v_fecha);
end $$;

grant execute on function public.corsa_cerrar_dia_manual(date) to authenticated;


-- ═════════════════════════════════════════════════════════════
-- PARTE 10 — DESTINATARIOS Y DESPACHO
--
--   El despachador es una Edge Function (supabase/functions/push-dispatch).
--   No puede recibir eventos «empujados»: los saca de acá.
--
--   Por qué el reparto se decide en la base y no en la función: la función
--   corre con service_role y por lo tanto podría mandarle cualquier cosa a
--   cualquiera. Que el reparto se calcule en SQL, con las reglas y las
--   casillas del usuario, deja a la función sin ninguna decisión que tomar —
--   su trabajo se reduce a cifrar y hacer un POST.
-- ═════════════════════════════════════════════════════════════

-- has_permission() mira al usuario de la sesión. Acá no hay sesión: el
-- despachador corre solo. Ésta es la misma consulta, para un usuario dado.
create or replace function public.corsa_usuario_tiene_permiso(p_user uuid, p_code text)
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
     where ur.user_id = p_user
       and p.code = p_code
       and r.active = true
  )
$$;

revoke all on function public.corsa_usuario_tiene_permiso(uuid, text) from public, anon;
grant execute on function public.corsa_usuario_tiene_permiso(uuid, text) to authenticated, service_role;


-- A qué dispositivos va un evento. Una sola definición, usada tanto por el
-- despacho como por la pantalla que explica «a cuántos dispositivos llegó».
create or replace function public.corsa_destinatarios_de(p_evento uuid)
returns table (
  subscription_id uuid,
  user_id         uuid,
  endpoint        text,
  p256dh          text,
  auth_secret     text,
  device_name     text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.user_id, s.endpoint, s.p256dh, s.auth, s.device_name
    from public.notification_events e
    join public.notification_rules r
      on r.organization_id = e.organization_id
     and r.event_type = e.event_type
     and r.channel = 'WEB_PUSH'
     and r.enabled
    join public.push_subscriptions s
      on s.organization_id = e.organization_id
     and s.enabled
     and s.invalidated_at is null
   where e.id = p_evento
     -- Quién: por permiso, por rol o una persona concreta.
     and (
       (r.audience = 'PERMISSION'
        and public.corsa_usuario_tiene_permiso(s.user_id, r.required_permission))
       or (r.audience = 'ROLE'
           and exists (select 1 from public.user_roles ur
                        where ur.user_id = s.user_id and ur.role_id = r.role_id))
       or (r.audience = 'USER' and s.user_id = r.user_id)
     )
     -- Y la casilla que el dueño del dispositivo puede apagar. Una regla sin
     -- casilla va a todos: es lo correcto para un tipo de evento nuevo que
     -- todavía no tiene su interruptor en la pantalla.
     and (
       r.subscription_flag is null
       or (r.subscription_flag = 'wash_notifications'          and s.wash_notifications)
       or (r.subscription_flag = 'machine_error_notifications' and s.machine_error_notifications)
       or (r.subscription_flag = 'daily_close_notifications'   and s.daily_close_notifications)
     )
     -- Un evento dirigido a una persona (el push de prueba) no se le manda a
     -- toda la organización aunque la regla sea por permiso.
     and (e.metadata->>'target_user_id' is null
          or s.user_id = (e.metadata->>'target_user_id')::uuid)
$$;

revoke all on function public.corsa_destinatarios_de(uuid) from public, anon;
grant execute on function public.corsa_destinatarios_de(uuid) to authenticated, service_role;


-- ─────────────────────────────────────────────
-- 10.1 Sacar trabajo de la cola
--
--     FOR UPDATE SKIP LOCKED: si dos despachadores corren a la vez —el cron y
--     el disparo inmediato— cada uno se lleva eventos distintos en lugar de
--     pelearse por los mismos.
--
--     Las filas de notification_deliveries se crean ACÁ, antes de mandar
--     nada. Así, si el despachador se muere a mitad de tanda, la próxima
--     corrida ve exactamente qué quedó pendiente en lugar de volver a mandar
--     todo.
-- ─────────────────────────────────────────────
create or replace function public.corsa_push_pendientes(p_limite int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evento record;
  v_lote   jsonb := '[]'::jsonb;
  v_dest   jsonb;
begin
  for v_evento in
    select e.*
      from public.notification_events e
     where e.status in ('PENDING', 'DISPATCHING')
       -- Un evento en DISPATCHING hace más de cinco minutos es un despachador
       -- que se murió; se vuelve a tomar. Los que acaban de salir, no.
       and (e.status = 'PENDING' or e.dispatched_at < now() - interval '5 minutes')
       -- Nada viejo: un push de un lavado de hace dos horas ya no sirve, y
       -- mandarlo después de una caída larga sería una avalancha.
       and e.created_at > now() - interval '2 hours'
       and e.attempts < 5
     order by e.created_at
     limit greatest(1, least(coalesce(p_limite, 20), 100))
       for update of e skip locked
  loop
    update public.notification_events
       set status = 'DISPATCHING', dispatched_at = now(), attempts = attempts + 1
     where id = v_evento.id;

    -- Una fila por dispositivo. La UNIQUE(evento, dispositivo) es lo que hace
    -- que repetir esta llamada no duplique entregas.
    insert into public.notification_deliveries (
      notification_event_id, subscription_id, channel, endpoint, device_name, user_id
    )
    select v_evento.id, d.subscription_id, 'WEB_PUSH', d.endpoint, d.device_name, d.user_id
      from public.corsa_destinatarios_de(v_evento.id) d
    on conflict (notification_event_id, subscription_id) do nothing;

    select jsonb_agg(jsonb_build_object(
             'delivery_id', dl.id,
             'subscription_id', dl.subscription_id,
             'endpoint', s.endpoint,
             'p256dh', s.p256dh,
             'auth', s.auth,
             'device_name', s.device_name))
      into v_dest
      from public.notification_deliveries dl
      join public.push_subscriptions s on s.id = dl.subscription_id
     where dl.notification_event_id = v_evento.id
       and dl.status = 'PENDING'
       and s.enabled and s.invalidated_at is null;

    if v_dest is null then
      -- Nadie a quién mandárselo: ningún dispositivo suscrito, o todos lo
      -- tienen apagado. No es un fallo, y marcarlo como tal llenaría el
      -- monitoreo de errores que no lo son.
      update public.notification_events
         set status = 'SKIPPED', sent_at = now()
       where id = v_evento.id;
      continue;
    end if;

    v_lote := v_lote || jsonb_build_object(
      'event_id', v_evento.id,
      'event_type', v_evento.event_type,
      'title', v_evento.title,
      'body', v_evento.body,
      'deep_link', v_evento.deep_link,
      'severity', v_evento.severity,
      'machine_id', v_evento.machine_id,
      'created_at', v_evento.created_at,
      'targets', v_dest);
  end loop;

  return jsonb_build_object('events', v_lote);
end $$;

revoke all on function public.corsa_push_pendientes(int) from public, anon, authenticated;
grant execute on function public.corsa_push_pendientes(int) to service_role;


-- ─────────────────────────────────────────────
-- 10.2 Registrar cómo fue
--
--     Y dar de baja lo que el servicio de push declare muerto. Un endpoint
--     404/410 no vuelve nunca: seguir intentándolo es gastar una llamada por
--     push por dispositivo desinstalado, para siempre.
-- ─────────────────────────────────────────────
create or replace function public.corsa_push_resultado(p_resultados jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          jsonb;
  v_id       uuid;
  v_ok       boolean;
  v_http     int;
  v_error    text;
  v_sub      uuid;
  v_eventos  uuid[] := '{}';
  v_ev       uuid;
  v_bajas    int := 0;
  v_env      int := 0;
  v_fallos   int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_resultados, '[]'::jsonb))
  loop
    v_id    := (r->>'delivery_id')::uuid;
    v_ok    := coalesce((r->>'ok')::boolean, false);
    v_http  := nullif(r->>'http_status', '')::int;
    v_error := left(nullif(r->>'error', ''), 500);

    update public.notification_deliveries
       set status = case
                      when v_ok then 'SENT'
                      -- 404 y 410 son «este endpoint ya no existe». No es un
                      -- fallo transitorio y no se reintenta.
                      when v_http in (404, 410) then 'EXPIRED'
                      else 'FAILED' end,
           attempts = attempts + 1,
           http_status = v_http,
           provider_error = v_error,
           sent_at = case when v_ok then now() end,
           failed_at = case when not v_ok then now() end
     where id = v_id
     returning notification_event_id, subscription_id into v_ev, v_sub;

    if v_ev is null then continue; end if;
    if not (v_ev = any(v_eventos)) then v_eventos := v_eventos || v_ev; end if;

    if v_ok then
      v_env := v_env + 1;
      update public.push_subscriptions
         set last_push_at = now(), last_seen_at = greatest(last_seen_at, now())
       where id = v_sub;
    else
      v_fallos := v_fallos + 1;
      if v_http in (404, 410) then
        update public.push_subscriptions
           set enabled = false,
               invalidated_at = now(),
               invalidated_reason = 'El servicio de push respondió ' || v_http,
               updated_at = now()
         where id = v_sub;
        v_bajas := v_bajas + 1;
      end if;
    end if;
  end loop;

  -- El evento queda SENT si llegó a algún dispositivo. Que un teléfono viejo
  -- haya fallado no significa que la notificación no ocurrió.
  foreach v_ev in array v_eventos loop
    update public.notification_events e
       set status = case
             when exists (select 1 from public.notification_deliveries d
                           where d.notification_event_id = e.id and d.status = 'SENT')
               then 'SENT'
             when exists (select 1 from public.notification_deliveries d
                           where d.notification_event_id = e.id and d.status = 'PENDING')
               then 'DISPATCHING'
             else 'FAILED' end,
           sent_at = coalesce(e.sent_at, case
             when exists (select 1 from public.notification_deliveries d
                           where d.notification_event_id = e.id and d.status = 'SENT')
               then now() end)
     where e.id = v_ev;
  end loop;

  return jsonb_build_object(
    'enviados', v_env, 'fallidos', v_fallos, 'dispositivos_dados_de_baja', v_bajas);
end $$;

revoke all on function public.corsa_push_resultado(jsonb) from public, anon, authenticated;
grant execute on function public.corsa_push_resultado(jsonb) to service_role;


-- ═════════════════════════════════════════════════════════════
-- PARTE 11 — LO QUE LLAMA LA APLICACIÓN
--
--   Cuatro RPC y una consulta. Todas validan la sesión: no hay forma de
--   registrar un dispositivo a nombre de otro ni de leer las notificaciones de
--   otra organización.
-- ═════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 11.1 Registrar (o volver a registrar) este dispositivo
--
--     El navegador puede darle al mismo dispositivo un endpoint nuevo cuando
--     rota su suscripción; y el mismo endpoint puede pasar de un usuario a
--     otro si dos personas usan la misma computadora. El upsert sobre endpoint
--     cubre las dos cosas: una sola fila por dispositivo, del usuario que lo
--     está usando ahora.
--
--     SECURITY DEFINER porque tiene que poder reasignar una fila que hoy es de
--     otro usuario —la RLS, correctamente, no lo dejaría— y en el mismo
--     movimiento verifica que el llamante tenga sesión y le pone SU id, no el
--     que venga en el pedido.
--     El `drop` de abajo es por una versión anterior de esta misma función que
--     quedó viva en la base: no tenía `p_reactivar`. `create or replace` no la
--     reemplaza —una firma distinta es una función distinta— sino que deja las
--     dos, y ahí `corsa_registrar_dispositivo` deja de ser un nombre único.
--     Una llamada por nombre de parámetro que no mencione `p_reactivar` encaja
--     en las dos y Postgres la rechaza por ambigua, así que hay que sacarla.
-- ─────────────────────────────────────────────
drop function if exists public.corsa_registrar_dispositivo(
  text, text, text, text, text, text, boolean);

create or replace function public.corsa_registrar_dispositivo(
  p_endpoint    text,
  p_p256dh      text,
  p_auth        text,
  p_device_name text default null,
  p_user_agent  text default null,
  p_platform    text default null,
  p_standalone  boolean default null,
  -- true  = el usuario acaba de tocar «Activar»: la suscripción se enciende.
  -- false = la app está sincronizando al abrir. Refresca las claves y la
  --         actividad, pero NO toca el interruptor.
  --
  -- La diferencia importa: sin ella, alguien que apaga las notificaciones de
  -- su laptop desde la pantalla de configuración las ve volver solas en la
  -- próxima recarga, porque la app sincroniza en cada apertura.
  p_reactivar   boolean default true
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_org  uuid;
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'Se necesita una sesión para registrar el dispositivo';
  end if;

  select organization_id into v_org from public.profiles where id = v_user;
  if v_org is null then
    raise exception 'Usuario sin organización';
  end if;

  if coalesce(trim(p_endpoint), '') = '' or coalesce(trim(p_p256dh), '') = ''
     or coalesce(trim(p_auth), '') = '' then
    raise exception 'Suscripción incompleta';
  end if;

  insert into public.push_subscriptions (
    organization_id, user_id, endpoint, p256dh, auth,
    device_name, user_agent, platform, standalone, enabled, last_seen_at
  ) values (
    v_org, v_user, p_endpoint, p_p256dh, p_auth,
    coalesce(nullif(trim(p_device_name), ''), 'Dispositivo'),
    left(p_user_agent, 400), p_platform, p_standalone, true, now()
  )
  on conflict (endpoint) do update set
    user_id         = v_user,
    organization_id = v_org,
    p256dh          = excluded.p256dh,
    auth            = excluded.auth,
    device_name     = coalesce(nullif(trim(p_device_name), ''),
                               public.push_subscriptions.device_name),
    user_agent      = coalesce(excluded.user_agent, public.push_subscriptions.user_agent),
    platform        = coalesce(excluded.platform, public.push_subscriptions.platform),
    standalone      = coalesce(excluded.standalone, public.push_subscriptions.standalone),
    -- Volver a suscribirse A PROPÓSITO reactiva un dispositivo que se había
    -- dado de baja por endpoint muerto: es un endpoint nuevo, o el mismo que
    -- revivió. Una sincronización no: ver p_reactivar.
    enabled         = case when p_reactivar then true
                           else public.push_subscriptions.enabled end,
    invalidated_at  = case when p_reactivar then null
                           else public.push_subscriptions.invalidated_at end,
    invalidated_reason = case when p_reactivar then null
                              else public.push_subscriptions.invalidated_reason end,
    last_seen_at    = now(),
    updated_at      = now()
  returning id into v_id;

  return v_id;
end $$;

grant execute on function public.corsa_registrar_dispositivo(text, text, text, text, text, text, boolean, boolean)
  to authenticated;


-- Apagar un dispositivo sin borrarlo: la persona puede volver a encenderlo
-- desde la misma pantalla sin tener que volver a dar permiso al navegador.
create or replace function public.corsa_dispositivo_preferencias(
  p_id      uuid,
  p_enabled boolean default null,
  p_wash    boolean default null,
  p_error   boolean default null,
  p_cierre  boolean default null,
  p_nombre  text    default null
) returns void
language sql
security invoker
set search_path = public
as $$
  update public.push_subscriptions
     set enabled                     = coalesce(p_enabled, enabled),
         wash_notifications          = coalesce(p_wash, wash_notifications),
         machine_error_notifications = coalesce(p_error, machine_error_notifications),
         daily_close_notifications   = coalesce(p_cierre, daily_close_notifications),
         device_name                 = coalesce(nullif(trim(p_nombre), ''), device_name),
         updated_at                  = now()
   where id = p_id
     and user_id = auth.uid()
$$;

grant execute on function public.corsa_dispositivo_preferencias(uuid, boolean, boolean, boolean, boolean, text)
  to authenticated;


-- Marca que este dispositivo sigue vivo. La llama la app al abrir: es lo que
-- llena la columna «última actividad» de la pantalla.
create or replace function public.corsa_dispositivo_visto(p_endpoint text)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.push_subscriptions
     set last_seen_at = now()
   where endpoint = p_endpoint
     and user_id = auth.uid()
$$;

grant execute on function public.corsa_dispositivo_visto(text) to authenticated;


-- ─────────────────────────────────────────────
-- 11.2 El centro de notificaciones
--
--     Lee de notification_events, que es donde ya está todo. No hay una tabla
--     de «notificaciones de la campana»: sería la misma información escrita
--     dos veces, y el día que una se escribiera y la otra no, la campana
--     mentiría.
--
--     SECURITY INVOKER a propósito: así la RLS de notification_events decide
--     qué ve cada quien, en lugar de que lo decida esta función.
-- ─────────────────────────────────────────────
create or replace function public.corsa_notificaciones_recientes(p_limite int default 40)
returns table (
  id           uuid,
  event_type   text,
  severity     text,
  machine_id   text,
  service_type text,
  title        text,
  body         text,
  deep_link    text,
  metadata     jsonb,
  created_at   timestamptz,
  leida        boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select e.id, e.event_type, e.severity, e.machine_id, e.service_type,
         e.title, e.body, e.deep_link, e.metadata, e.created_at,
         (n.user_id is not null) as leida
    from public.notification_events e
    left join public.notification_reads n
           on n.notification_event_id = e.id and n.user_id = auth.uid()
   order by e.created_at desc
   limit greatest(1, least(coalesce(p_limite, 40), 200))
$$;

grant execute on function public.corsa_notificaciones_recientes(int) to authenticated;


create or replace function public.corsa_marcar_leidas(p_ids uuid[] default null)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare v_n int;
begin
  insert into public.notification_reads (user_id, notification_event_id)
  select auth.uid(), e.id
    from public.notification_events e
   where (p_ids is null or e.id = any(p_ids))
     and e.created_at > now() - interval '30 days'
  on conflict do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end $$;

grant execute on function public.corsa_marcar_leidas(uuid[]) to authenticated;


-- ─────────────────────────────────────────────
-- 11.3 El cierre de un día, para la pantalla
-- ─────────────────────────────────────────────
create or replace function public.corsa_cierre_del_dia(p_fecha date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org   uuid := public.get_my_organization_id();
  v_fecha date := coalesce(p_fecha, public.corsa_hoy());
  v_row   public.daily_closes;
begin
  if v_org is null or not public.has_permission('plc.read') then
    raise exception 'Sin permiso para ver el cierre del día';
  end if;

  select * into v_row from public.daily_closes
   where organization_id = v_org and fecha_operativa = v_fecha;

  -- Un día sin cierre registrado igual tiene números: son los del día hasta
  -- ahora. La pantalla los muestra con la aclaración de que todavía no cerró,
  -- que es más útil que una pantalla vacía.
  return jsonb_build_object(
    'fecha', v_fecha,
    'cerrado', found,
    'cerrado_at', v_row.cerrado_at,
    'motivo', v_row.motivo,
    'deteccion', v_row.deteccion,
    'generado_por', v_row.generado_por,
    'notification_sent_at', v_row.notification_sent_at,
    'resumen', coalesce(v_row.resumen, public.corsa_resumen_del_dia(v_org, v_fecha))
  );
end $$;

grant execute on function public.corsa_cierre_del_dia(date) to authenticated;


-- El estado operativo, para la misma pantalla: por qué el día todavía no cerró.
create or replace function public.corsa_estado_operativo_actual()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_org uuid := public.get_my_organization_id();
begin
  if v_org is null or not public.has_permission('plc.read') then
    raise exception 'Sin permiso';
  end if;
  return public.corsa_estado_operativo(v_org);
end $$;

grant execute on function public.corsa_estado_operativo_actual() to authenticated;


-- ═════════════════════════════════════════════════════════════
-- PARTE 12 — PRUEBAS
--
--   Esperar un lavado real para saber si las notificaciones funcionan es
--   garantía de que no se prueben.
--
--   DOS CERROJOS, y el importante es el de acá:
--     · la interfaz sólo muestra los controles en desarrollo (import.meta.env.DEV);
--     · esta función exige `simulacion_habilitada` en la configuración, que
--       nace en false. Un build de producción mal armado no alcanza para
--       disparar un evento simulado.
--
--   Y la regla que no se negocia: esto NO escribe en plc_wash_cycles ni en
--   ninguna tabla de máquinas. Un lavado simulado que sumara en el conteo del
--   día sería falsear la venta.
-- ═════════════════════════════════════════════════════════════

create or replace function public.corsa_simular_evento(
  p_tipo     text,
  p_machine  text default null,
  p_servicio text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid := public.get_my_organization_id();
  v_user    uuid := auth.uid();
  v_cfg     public.corsa_notification_config;
  v_maquina text;
  v_nombre  text;
  v_evento  uuid;
  v_clave   text;
  v_hoy     int;
  v_cuerpo  text;
  v_resumen jsonb;
begin
  if v_user is null or v_org is null then
    raise exception 'Se necesita una sesión';
  end if;
  if not public.has_permission('plc.manage') then
    raise exception 'Sin permiso para simular eventos';
  end if;

  v_cfg := public.corsa_config_notificaciones(v_org);
  if not v_cfg.simulacion_habilitada then
    raise exception 'La simulación de eventos está deshabilitada en esta organización';
  end if;

  v_maquina := coalesce(p_machine,
    (select machine_code from public.plc_machines
      where organization_id = v_org and active order by machine_code limit 1),
    'machine-1');
  v_nombre := public.corsa_nombre_maquina(v_org, v_maquina);

  -- Cada simulación es un hecho distinto, así que la clave lleva el instante:
  -- si compartieran clave, la segunda prueba del día no mandaría nada y
  -- parecería que el sistema dejó de funcionar.
  v_clave := 'sim-' || lower(p_tipo) || '-' || to_char(now(), 'YYYYMMDDHH24MISSMS');

  if p_tipo = 'WASH_COMPLETED' then
    v_hoy := public.corsa_lavados_del_dia(v_org);
    v_cuerpo := 'Lavado ' || coalesce(public.corsa_nombre_servicio(p_servicio), 'Pro') ||
                ' finalizado' || E'\nDuración: 8m 42s' ||
                E'\nHoy: ' || v_hoy || ' lavados';
    v_evento := public.corsa_emitir_notificacion(
      v_org, 'WASH_COMPLETED', v_clave,
      '🚗 CORSA — ' || v_nombre, v_cuerpo,
      '/machines?maquina=' || v_maquina,
      jsonb_build_object('simulado', true, 'target_user_id', v_user,
                         'machine_name', v_nombre, 'duration_seconds', 522),
      v_maquina, null, coalesce(upper(p_servicio), 'PRO'), 'INFO');

  elsif p_tipo = 'MACHINE_ERROR' then
    v_evento := public.corsa_emitir_notificacion(
      v_org, 'MACHINE_ERROR', v_clave,
      '⚠️ CORSA — ' || v_nombre,
      'ERROR DETECTADO' || E'\nRevisar máquina.' || E'\nHora: ' ||
        to_char(now() at time zone 'America/El_Salvador', 'HH12:MI AM'),
      '/machines?maquina=' || v_maquina,
      jsonb_build_object('simulado', true, 'target_user_id', v_user,
                         'machine_name', v_nombre),
      v_maquina, null, null, 'CRITICAL');

  elsif p_tipo = 'DAILY_CLOSE' then
    v_resumen := public.corsa_resumen_del_dia(v_org, public.corsa_hoy());
    v_cuerpo := coalesce((
      select string_agg((m->>'nombre') || ': ' || (m->>'lavados') || ' lavados', E'\n')
        from jsonb_array_elements(v_resumen->'maquinas') m), 'Sin actividad registrada');
    v_cuerpo := v_cuerpo || E'\nTOTAL: ' || coalesce(v_resumen->>'total_lavados', '0') || ' lavados';
    v_evento := public.corsa_emitir_notificacion(
      v_org, 'DAILY_CLOSE', v_clave,
      '🌙 CORSA — Cierre del día (simulado)', v_cuerpo,
      '/dashboard/cierre-diario?date=' || public.corsa_hoy()::text,
      jsonb_build_object('simulado', true, 'target_user_id', v_user, 'resumen', v_resumen),
      null, null, null, 'INFO');

  elsif p_tipo = 'TEST' then
    v_evento := public.corsa_emitir_notificacion(
      v_org, 'TEST', v_clave,
      '🔔 CORSA',
      'Push de prueba. Si ves esto, las notificaciones funcionan en este dispositivo.',
      '/settings/notificaciones',
      jsonb_build_object('simulado', true, 'target_user_id', v_user),
      null, null, null, 'INFO');

  else
    raise exception 'Tipo de evento desconocido: %', p_tipo;
  end if;

  return jsonb_build_object('ok', v_evento is not null, 'notification_event_id', v_evento);
end $$;

grant execute on function public.corsa_simular_evento(text, text, text) to authenticated;


-- ═════════════════════════════════════════════════════════════
-- PARTE 13 — QUIÉN DESPIERTA AL DESPACHADOR
--
--   La base no puede mandar un push: no habla HTTPS ni sabe cifrar para el
--   navegador. Eso lo hace la Edge Function `push-dispatch`, que tiene que ser
--   llamada por alguien.
--
--   Hay dos llamadores, y los dos son opcionales — el sistema funciona con
--   cualquiera de los dos, y con los dos juntos funciona mejor:
--
--   1. INMEDIATO (pg_net). Un trigger sobre notification_events hace un POST
--      asíncrono en cuanto nace el evento. Es lo que hace que el push llegue
--      en segundos y no en el próximo minuto.
--
--   2. BARRIDO (pg_cron, cada minuto). Recoge lo que el inmediato no pudo
--      —pg_net caído, la función devolvió 500, el push falló y hay que
--      reintentar— y además es lo que llama a la evaluación de cierre por
--      hora tope cuando el gateway dejó de latir.
--
--   Ninguno de los dos se activa acá: hacen falta la URL del proyecto y un
--   secreto, que no van escritos en una migración que vive en el repositorio.
--   Se activan con corsa_configurar_despacho(). Ver docs/NOTIFICACIONES_PUSH.md.
-- ═════════════════════════════════════════════════════════════

-- El secreto con el que la base se identifica ante la Edge Function.
--
-- RLS habilitada y SIN NINGUNA POLICY: eso no es un olvido. Una tabla con RLS
-- y sin policies es invisible para `anon` y `authenticated` — ni select. Sólo
-- la alcanzan las funciones security definer de este archivo y service_role.
create table if not exists public.corsa_dispatch_config (
  id          int         primary key default 1 check (id = 1),
  url         text        not null,
  secret      text        not null,
  enabled     boolean     not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.corsa_dispatch_config enable row level security;
revoke all on public.corsa_dispatch_config from anon, authenticated;

comment on table public.corsa_dispatch_config is
  'URL y secreto con los que la base despierta al despachador. Sin policies de RLS a propósito: nadie la lee desde la app.';


create or replace function public.corsa_configurar_despacho(
  p_url text, p_secret text, p_enabled boolean default true
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.corsa_dispatch_config (id, url, secret, enabled, updated_at)
  values (1, p_url, p_secret, p_enabled, now())
  on conflict (id) do update
     set url = excluded.url, secret = excluded.secret,
         enabled = excluded.enabled, updated_at = now()
$$;

revoke all on function public.corsa_configurar_despacho(text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.corsa_configurar_despacho(text, text, boolean) to service_role;


-- El POST asíncrono. Si pg_net no está instalado, no hace nada y no falla:
-- el barrido por cron sigue entregando todo, sólo que un minuto más tarde.
-- Que falte una extensión opcional no puede romper la ingesta de un lavado.
create or replace function public.corsa_disparar_despacho()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_cfg record;
begin
  select * into v_cfg from public.corsa_dispatch_config where id = 1 and enabled;
  if not found then return; end if;

  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return;
  end if;

  perform net.http_post(
    url     := v_cfg.url,
    body    := jsonb_build_object('source', 'trigger'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'X-Dispatch-Key', v_cfg.secret),
    timeout_milliseconds := 5000);
exception when others then
  raise warning 'CORSA notificaciones: no se pudo despertar al despachador (%)', sqlerrm;
end $$;

revoke all on function public.corsa_disparar_despacho() from public, anon, authenticated;
grant execute on function public.corsa_disparar_despacho() to service_role;


create or replace function public.corsa_tg_despertar_despachador()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'PENDING' then
    perform public.corsa_disparar_despacho();
  end if;
  return null;
exception when others then
  return null;
end $$;

drop trigger if exists tg_corsa_despertar_despachador on public.notification_events;
create trigger tg_corsa_despertar_despachador
  after insert on public.notification_events
  for each row
  execute function public.corsa_tg_despertar_despachador();


-- Lo que corre el barrido: devolver a la cola lo que quedó a medias y volver a
-- preguntarse si el día terminó.
create or replace function public.corsa_mantenimiento_notificaciones()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reencolados int;
  v_vencidos    int;
begin
  -- Eventos que un despachador tomó y nunca terminó.
  update public.notification_events
     set status = 'PENDING'
   where status = 'DISPATCHING'
     and dispatched_at < now() - interval '5 minutes'
     and attempts < 5;
  get diagnostics v_reencolados = row_count;

  -- Y los que ya no vale la pena intentar. Un push de un lavado de hace dos
  -- horas no le sirve a nadie, y dejarlos PENDING haría que la cola creciera
  -- para siempre después de una caída larga.
  update public.notification_events
     set status = 'FAILED'
   where status in ('PENDING', 'DISPATCHING')
     and (created_at < now() - interval '2 hours' or attempts >= 5);
  get diagnostics v_vencidos = row_count;

  perform public.corsa_evaluar_cierre_del_dia();

  return jsonb_build_object('reencolados', v_reencolados, 'vencidos', v_vencidos);
end $$;

revoke all on function public.corsa_mantenimiento_notificaciones() from public, anon, authenticated;
grant execute on function public.corsa_mantenimiento_notificaciones() to service_role;


-- ═════════════════════════════════════════════════════════════
-- PARTE 14 — MONITOREO
--
--   Qué se generó, qué se envió, qué falló y a qué dispositivo. Sin esto, la
--   única forma de saber si las notificaciones funcionan es preguntarle a
--   alguien si le sonó el teléfono.
-- ═════════════════════════════════════════════════════════════

-- security_invoker: la vista se ejecuta con los permisos de QUIEN la consulta,
-- no con los de su dueño.
--
-- Sin esto, en Postgres 15 una vista corre como el rol que la creó —postgres,
-- que se salta la RLS— y entonces la vista deja ver exactamente lo que las
-- policies de las tablas de abajo prohíben. No es una optimización: es la
-- diferencia entre que la RLS se aplique y que no.
drop view if exists public.v_corsa_notificaciones cascade;
create view public.v_corsa_notificaciones
  with (security_invoker = true) as
select
  e.id,
  e.organization_id,
  e.event_type,
  e.severity,
  e.machine_id,
  e.service_type,
  e.title,
  e.body,
  e.deep_link,
  e.status,
  e.attempts,
  e.created_at,
  e.sent_at,
  (e.metadata->>'simulado')::boolean                              as simulado,
  count(d.id)                                                     as dispositivos,
  count(d.id) filter (where d.status = 'SENT')                    as entregados,
  count(d.id) filter (where d.status = 'FAILED')                  as fallidos,
  count(d.id) filter (where d.status = 'EXPIRED')                 as vencidos,
  min(d.sent_at)                                                  as primera_entrega
from public.notification_events e
left join public.notification_deliveries d on d.notification_event_id = e.id
group by e.id;

comment on view public.v_corsa_notificaciones is
  'Cada notificación con su reparto: a cuántos dispositivos salió, a cuántos llegó y cuántos fallaron.';

grant select on public.v_corsa_notificaciones to authenticated, service_role;


-- security_invoker por la misma razón, y acá es lo que impide una fuga
-- concreta: sin él, cualquier usuario con plc.read vería los dispositivos de
-- todo el equipo, que es justo lo que la policy de push_subscriptions prohíbe.
drop view if exists public.v_corsa_dispositivos cascade;
create view public.v_corsa_dispositivos
  with (security_invoker = true) as
select
  s.id,
  s.organization_id,
  s.user_id,
  trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))  as usuario,
  s.device_name,
  s.platform,
  s.standalone,
  s.enabled,
  s.wash_notifications,
  s.machine_error_notifications,
  s.daily_close_notifications,
  s.created_at,
  s.last_seen_at,
  s.last_push_at,
  s.invalidated_at,
  s.invalidated_reason,
  -- Sólo el final del endpoint: alcanza para distinguir dos dispositivos en
  -- una lista y no expone la URL con la que cualquiera podría mandarle pushes.
  right(s.endpoint, 12)                                                 as endpoint_corto,
  (select count(*) from public.notification_deliveries d
    where d.subscription_id = s.id and d.status = 'SENT')               as recibidas
from public.push_subscriptions s
left join public.profiles p on p.id = s.user_id;

comment on view public.v_corsa_dispositivos is
  'Los dispositivos suscritos, con su dueño y su actividad. El endpoint sale recortado: entero sería una credencial de envío.';

grant select on public.v_corsa_dispositivos to authenticated, service_role;


-- ─────────────────────────────────────────────
-- Limpieza: los dispositivos que el servicio de push declaró muertos hace más
-- de noventa días ya no dicen nada útil. Se borran para que la pantalla de
-- notificaciones no se llene de teléfonos que ya no existen.
-- ─────────────────────────────────────────────
create or replace function public.corsa_limpiar_dispositivos_muertos()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  delete from public.push_subscriptions
   where invalidated_at is not null
     and invalidated_at < now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.corsa_limpiar_dispositivos_muertos() from public, anon, authenticated;
grant execute on function public.corsa_limpiar_dispositivos_muertos() to service_role;


-- ─────────────────────────────────────────────
-- Permisos de lectura de las tablas nuevas. Qué ve cada quien lo sigue
-- decidiendo la RLS; esto sólo evita el «permission denied» que aparecería si
-- los defaults del esquema public cambiaran.
-- ─────────────────────────────────────────────
grant select on public.push_subscriptions        to authenticated;
grant insert, update, delete on public.push_subscriptions to authenticated;
grant select on public.notification_events       to authenticated;
grant select, insert on public.notification_reads to authenticated;
grant select on public.notification_deliveries   to authenticated;
grant select on public.notification_rules        to authenticated;
grant select on public.machine_error_incidents   to authenticated;
grant select on public.daily_closes              to authenticated;
grant select on public.corsa_notification_config to authenticated;
