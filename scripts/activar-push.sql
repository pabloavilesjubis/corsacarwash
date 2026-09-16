-- ============================================================
-- Encender el envío de notificaciones push
--
-- Diagnóstico confirmado: los eventos se crean y quedan en PENDING para
-- siempre porque nadie despierta al despachador. La Edge Function está
-- desplegada y con sus claves VAPID; lo que falta es del lado de la base.
--
-- Correr bloque por bloque en el SQL Editor de Supabase, en orden.
-- ============================================================


-- ── PASO 1 · Vencer lo que quedó atrás ──────────────────────
--
-- HACER ESTO ANTES DE ENCENDER, no después.
--
-- Hay una decena de eventos PENDING de esta mañana. En cuanto el despachador
-- arranque, saldrían TODOS de golpe: el teléfono sonaría diez veces seguidas
-- anunciando lavados que terminaron hace dos horas. Eso no le sirve a nadie y
-- es la clase de cosa que hace que la gente apague las notificaciones el
-- primer día.
--
-- Se marcan como vencidos. Siguen en el historial —la lista de la app los
-- muestra igual— pero ya no se envían.
update public.notification_events
   set status = 'FAILED'
 where status in ('PENDING', 'DISPATCHING')
   and created_at < now() - interval '10 minutes';

-- Verificar que no quedó nada viejo por salir:
select status, count(*) from public.notification_events group by status;


-- ── PASO 2 · Decirle a la base a quién llamar ───────────────
--
-- El secreto tiene que ser EXACTAMENTE el mismo PUSH_DISPATCH_SECRET que está
-- cargado en la Edge Function. Si no coinciden, la función responde 401 y los
-- eventos se quedan en PENDING igual que ahora — mismo síntoma, otra causa.
--
-- Si no lo recordás, volvé a fijarlo en los dos lados:
--   supabase secrets set PUSH_DISPATCH_SECRET='<nuevo>' --project-ref zvbpkfuehnmqlqimyxcs
select public.corsa_configurar_despacho(
  'https://zvbpkfuehnmqlqimyxcs.supabase.co/functions/v1/push-dispatch/run',
  '<PEGAR ACÁ EL PUSH_DISPATCH_SECRET>');

-- Verificar (no muestra el secreto):
select url, enabled, updated_at from public.corsa_dispatch_config where id = 1;


-- ── PASO 3 · El aviso inmediato ─────────────────────────────
--
-- Sin pg_net el trigger no hace nada: está escrito para detectar si la
-- extensión existe y salir en silencio si no, para que la falta de una
-- extensión opcional no pueda romper la ingesta de un lavado.
create extension if not exists pg_net;

select extname, extversion from pg_extension where extname = 'pg_net';


-- ── PASO 4 · El barrido cada minuto ─────────────────────────
--
-- Recoge lo que el inmediato no pudo: pg_net caído, la función devolvió 500,
-- un push que hay que reintentar. También es lo que evalúa el cierre del día
-- cuando el gateway dejó de latir.
create extension if not exists pg_cron;

select cron.schedule('corsa-push', '* * * * *', $$
  select net.http_post(
    url := (select url from public.corsa_dispatch_config where id = 1),
    body := '{"source":"cron"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Dispatch-Key', (select secret from public.corsa_dispatch_config where id = 1)));
$$);

select jobid, jobname, schedule, active from cron.job where jobname = 'corsa-push';


-- ── PASO 5 · Comprobar que sale ─────────────────────────────
--
-- Despertar al despachador a mano, sin esperar al próximo lavado ni al cron.
select public.corsa_disparar_despacho();

-- Esperar unos segundos y mirar qué pasó con las llamadas HTTP que hizo la
-- base. Acá aparece el 401 si el secreto no coincide.
select id, status_code, left(content, 200) as respuesta, created
  from net._http_response
 order by created desc
 limit 5;


-- ── PASO 6 · ¿Hay teléfonos a los que mandar? ───────────────
--
-- Encender el despachador no alcanza si nadie se suscribió. Un evento puede
-- salir perfecto y no sonar en ningún lado.
--
-- Si esto sale vacío: entrar a la app en el teléfono y tocar «Activar» en
-- notificaciones. En iPhone hay que agregar CORSA a la pantalla de inicio
-- PRIMERO — desde una pestaña de Safari la opción ni aparece.
select
  platform,
  device_name,
  enabled,
  standalone      as instalada_como_app,
  last_seen_at,
  last_push_at,
  invalidated_at  as dada_de_baja
from public.push_subscriptions
order by created_at desc;


-- ── PASO 7 · Un push de prueba ──────────────────────────────
--
-- Desde la app: pantalla de Notificaciones → «Enviar prueba». Llega en
-- segundos si todo lo anterior quedó bien.
--
-- Para ver el resultado del envío, con el motivo real si falla:
select
  e.created_at at time zone 'America/El_Salvador' as hora_local,
  e.event_type, e.status as evento,
  d.status as entrega, d.http_status, d.provider_error, d.device_name
from public.notification_events e
left join public.notification_deliveries d on d.notification_event_id = e.id
order by e.created_at desc
limit 10;
