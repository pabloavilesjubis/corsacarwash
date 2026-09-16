-- ============================================================
-- ¿Por qué la notificación aparece en la lista pero no suena el teléfono?
--
-- La cadena tiene cuatro eslabones y cada bloque revisa uno. El primero que
-- salga mal es la causa; los siguientes son consecuencia.
--
--   1. La base crea el evento          → notification_events
--   2. La base despierta al despachador → corsa_dispatch_config + pg_net
--   3. El despachador envía            → Edge Function push-dispatch
--   4. El servicio de push entrega     → notification_deliveries
--
-- Pegar completo en el SQL Editor de Supabase.
-- ============================================================

-- ── 1. ¿La base puede despertar al despachador? ──
--
-- Ésta es LA causa más probable del síntoma. Sin esta fila, los eventos se
-- crean (por eso aparecen en la lista) y nadie los envía nunca. La migración
-- no la crea a propósito: lleva la URL del proyecto y un secreto, que no van
-- escritos en un archivo del repositorio.
select
  case when exists (select 1 from public.corsa_dispatch_config where id = 1)
       then 'configurado' else '❌ NO CONFIGURADO — ver abajo cómo' end  as despachador,
  (select enabled from public.corsa_dispatch_config where id = 1)        as habilitado,
  (select url     from public.corsa_dispatch_config where id = 1)        as url,
  (select updated_at from public.corsa_dispatch_config where id = 1)     as configurado_el;


-- ── 2. ¿Están las extensiones que hacen el envío? ──
--
-- pg_net manda el aviso inmediato. pg_cron hace el barrido de lo que quedó
-- pendiente. Con ninguna de las dos, nada sale nunca.
select
  extname as extension,
  extversion as version,
  '✓ instalada' as estado
from pg_extension
where extname in ('pg_net', 'pg_cron')
union all
select 'pg_net', '', '❌ FALTA — el push inmediato no funciona'
where not exists (select 1 from pg_extension where extname = 'pg_net')
union all
select 'pg_cron', '', '❌ FALTA — el barrido de reintentos no corre'
where not exists (select 1 from pg_extension where extname = 'pg_cron');


-- ── 3. ¿Hay teléfonos suscritos? ──
--
-- Un evento puede salir perfecto y no sonar en ningún lado simplemente porque
-- ningún dispositivo se registró. En iPhone pasa seguido: sin agregar la app
-- a la pantalla de inicio, Safari ni siquiera ofrece suscribirse.
select
  coalesce(platform, 'sin plataforma')                     as plataforma,
  count(*)                                                 as dispositivos,
  count(*) filter (where enabled)                          as encendidos,
  count(*) filter (where standalone)                       as instalados_como_app,
  count(*) filter (where invalidated_at is not null)       as dados_de_baja,
  max(last_seen_at)                                        as ultimo_contacto,
  max(last_push_at)                                        as ultimo_push_recibido
from public.push_subscriptions
group by rollup (platform)
order by platform nulls last;


-- ── 4. ¿En qué estado quedaron los eventos? ──
--
-- Cómo leerlo:
--   PENDING     → nadie los recogió: el despachador no se está despertando (bloque 1 o 2)
--   DISPATCHING → alguien los tomó y no terminó: la Edge Function falla a mitad
--   SENT        → salieron; si igual no sonó, seguí al bloque 5
--   FAILED      → se agotaron los intentos o pasaron 2 horas
--   SKIPPED     → una regla decidió no notificar esto
select
  status,
  count(*)                        as eventos,
  min(created_at)                 as mas_viejo,
  max(created_at)                 as mas_nuevo,
  max(attempts)                   as intentos_max
from public.notification_events
group by status
order by count(*) desc;


-- ── 5. ¿Qué dijo el servicio de push? ──
--
-- Acá aparece el motivo real cuando el evento salió pero no llegó.
--   410 / 404 → el endpoint murió: el navegador rotó la suscripción
--   403       → la clave VAPID del servidor no es la que usó el navegador
--   413       → el payload es muy grande
select
  d.status,
  d.http_status,
  count(*)                        as entregas,
  max(d.provider_error)           as ejemplo_de_error,
  max(d.sent_at)                  as ultima
from public.notification_deliveries d
group by d.status, d.http_status
order by count(*) desc;


-- ── 6. Las últimas 10 notificaciones, con su reparto ──
select
  created_at at time zone 'America/El_Salvador' as hora_local,
  event_type,
  status,
  dispositivos,
  entregados,
  fallidos,
  left(title, 40)                 as titulo
from public.v_corsa_notificaciones
order by created_at desc
limit 10;
