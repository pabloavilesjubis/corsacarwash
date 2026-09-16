/**
 * CORSA — Despachador de notificaciones Push
 *
 * La base decide QUÉ se notifica y A QUIÉN. Esta función sólo cifra y hace el
 * POST. Esa división no es estética: la función corre con service_role y, si
 * además eligiera destinatarios, un error suyo podría mandarle a cualquiera
 * cualquier cosa. Acá no hay ninguna decisión que tomar — pide la tanda,
 * manda, informa cómo fue.
 *
 * RUTAS
 *   POST /push-dispatch            (= /run)  Despacha la cola. X-Dispatch-Key.
 *   POST /push-dispatch/test                 Push de prueba al que llama. JWT.
 *   POST /push-dispatch/simulate             Evento simulado. JWT + permiso.
 *   GET  /push-dispatch/vapid-public-key     La clave pública. Sin autenticar.
 *
 * QUIÉN LA LLAMA
 *   · Un trigger de la base la despierta en cuanto nace un evento (pg_net),
 *     que es lo que hace que el push llegue en segundos.
 *   · Un cron cada minuto recoge lo que haya quedado y corre el mantenimiento.
 *   Ninguno de los dos es obligatorio; con cualquiera de los dos funciona.
 *
 * SECRETOS (variables de entorno de la función, nunca en el frontend)
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_DISPATCH_SECRET
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { enviarPush, type ClavesVapid } from './webpush.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-dispatch-key, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

const env = (k: string) => Deno.env.get(k) ?? ''

function clavesVapid(): ClavesVapid | null {
  const publicKey = env('VAPID_PUBLIC_KEY')
  const privateKey = env('VAPID_PRIVATE_KEY')
  if (!publicKey || !privateKey) return null
  return {
    publicKey,
    privateKey,
    // `sub` tiene que ser un mailto: o un https:. Si nadie lo configuró, un
    // valor por defecto es mejor que fallar: sin él, el push no sale.
    subject: env('VAPID_SUBJECT') || 'mailto:soporte@corsacarwash.com',
  }
}

function admin() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Cliente que actúa COMO el usuario que llama: auth.uid() y la RLS aplican. */
function comoUsuario(authHeader: string) {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } },
  })
}

// ─── Tipos del contrato con corsa_push_pendientes() ──────────

interface Destino {
  delivery_id: string
  subscription_id: string
  endpoint: string
  p256dh: string
  auth: string
  device_name: string
}

interface EventoPendiente {
  event_id: string
  event_type: string
  title: string
  body: string
  deep_link: string | null
  severity: string
  machine_id: string | null
  created_at: string
  targets: Destino[]
}

/**
 * Lo que recibe el Service Worker.
 *
 * Va el texto ya armado y no los datos crudos: el Service Worker corre con la
 * app cerrada, sin acceso a la sesión ni a la base, así que no podría resolver
 * el nombre de una máquina ni contar los lavados del día. Su trabajo es
 * mostrar; el de la base, redactar.
 */
function carga(e: EventoPendiente) {
  return JSON.stringify({
    id: e.event_id,
    type: e.event_type,
    title: e.title,
    body: e.body,
    url: e.deep_link ?? '/',
    severity: e.severity,
    // El tag agrupa: dos avisos de la misma máquina se reemplazan en lugar de
    // apilarse. Es por evento, así que dos lavados distintos sí se ven los dos.
    tag: `${e.event_type}-${e.event_id}`,
    timestamp: new Date(e.created_at).getTime(),
  })
}

/** Una falla no puede esperar en la cola del servicio de push como un resumen. */
function urgencia(tipo: string): 'high' | 'normal' {
  return tipo === 'MACHINE_ERROR' ? 'high' : 'normal'
}

/** Un aviso de lavado que llega cuatro horas tarde ya no le sirve a nadie. */
function ttl(tipo: string): number {
  if (tipo === 'MACHINE_ERROR') return 3600 * 6
  if (tipo === 'WASH_COMPLETED') return 3600 * 2
  return 3600 * 24
}

/**
 * Saca una tanda, la manda y registra cómo fue.
 *
 * Los envíos van en paralelo pero de a diez: mil dispositivos de golpe
 * agotarían las conexiones salientes de la función, y entonces fallarían
 * envíos que no tenían nada malo.
 */
async function despachar(limite: number) {
  const vapid = clavesVapid()
  if (!vapid) {
    return { error: 'Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en la función' }
  }

  const sb = admin()
  const { data, error } = await sb.rpc('corsa_push_pendientes', { p_limite: limite })
  if (error) return { error: error.message }

  const eventos = (data?.events ?? []) as EventoPendiente[]
  if (eventos.length === 0) return { eventos: 0, enviados: 0, fallidos: 0 }

  const resultados: Array<Record<string, unknown>> = []
  let enviados = 0
  let fallidos = 0

  for (const evento of eventos) {
    const mensaje = carga(evento)

    for (let i = 0; i < evento.targets.length; i += 10) {
      const tanda = evento.targets.slice(i, i + 10)
      const salidas = await Promise.all(tanda.map(t =>
        enviarPush(
          { endpoint: t.endpoint, p256dh: t.p256dh, auth: t.auth },
          mensaje, vapid,
          { ttl: ttl(evento.event_type), urgencia: urgencia(evento.event_type) },
        )))

      salidas.forEach((r, j) => {
        r.ok ? enviados++ : fallidos++
        if (!r.ok) {
          console.error(
            `push fallido · evento ${evento.event_id} · ${tanda[j].device_name} · ` +
            `${r.status} ${r.error ?? ''}`)
        }
        resultados.push({
          delivery_id: tanda[j].delivery_id,
          ok: r.ok,
          http_status: r.status,
          error: r.error ?? null,
        })
      })
    }
  }

  // Siempre se informa, incluso si todo falló: es lo que da de baja los
  // endpoints muertos y lo que saca a los eventos del estado DISPATCHING.
  const { error: errRes } = await sb.rpc('corsa_push_resultado', { p_resultados: resultados })
  if (errRes) console.error('no se pudo registrar el resultado:', errRes.message)

  return { eventos: eventos.length, enviados, fallidos }
}

// ─── Entrada ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const url = new URL(req.url)
  const partes = url.pathname.split('/').filter(Boolean)
  // La ruta llega como /push-dispatch[/<acción>].
  const accion = partes.length > 1 ? partes[partes.length - 1] : 'run'

  // ── La clave pública VAPID ──
  // Se sirve sin autenticar a propósito: es pública por definición —el
  // navegador la necesita para suscribirse y viaja en cada push—. Tenerla acá
  // evita repetirla como variable de build del frontend, donde una copia
  // desactualizada haría que las suscripciones nuevas fallaran en silencio.
  if (accion === 'vapid-public-key') {
    const k = env('VAPID_PUBLIC_KEY')
    if (!k) return json({ error: 'VAPID no está configurado' }, 503)
    return json({ publicKey: k })
  }

  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  let cuerpo: Record<string, unknown> = {}
  try { cuerpo = await req.json() } catch { /* cuerpo vacío es válido */ }

  // ── Despacho de la cola ──
  if (accion === 'run' || accion === 'push-dispatch') {
    const secreto = env('PUSH_DISPATCH_SECRET')
    // Sin secreto configurado NO se abre: un despachador sin llave es un
    // endpoint público que cualquiera puede usar para vaciar la cola.
    if (!secreto) return json({ error: 'PUSH_DISPATCH_SECRET no está configurado' }, 503)
    if (req.headers.get('x-dispatch-key') !== secreto) {
      return json({ error: 'No autorizado' }, 401)
    }

    // El mantenimiento —reencolar lo que quedó a medias y evaluar el cierre
    // por hora tope— sólo corre en el barrido. En el disparo inmediato sería
    // trabajo repetido en cada lavado.
    if (cuerpo.source !== 'trigger') {
      const { error } = await admin().rpc('corsa_mantenimiento_notificaciones')
      if (error) console.error('mantenimiento:', error.message)
    }

    const r = await despachar(Number(cuerpo.limite) || 25)
    return json(r, 'error' in r ? 500 : 200)
  }

  // ── Las dos rutas con sesión de usuario ──
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return json({ error: 'Se necesita una sesión' }, 401)

  const usuario = comoUsuario(auth)
  const { data: { user }, error: errUser } = await usuario.auth.getUser()
  if (errUser || !user) return json({ error: 'Sesión inválida' }, 401)

  if (accion === 'test' || accion === 'simulate') {
    const tipo = accion === 'test' ? 'TEST' : String(cuerpo.tipo ?? 'TEST')

    // Se llama COMO el usuario: corsa_simular_evento valida su permiso y la
    // bandera de simulación de la organización. Llamarla con service_role
    // saltearía las dos validaciones, que son justamente las que impiden que
    // esto exista en producción.
    const { data, error } = await usuario.rpc('corsa_simular_evento', {
      p_tipo: tipo,
      p_machine: cuerpo.machine ?? null,
      p_servicio: cuerpo.servicio ?? null,
    })

    if (error) return json({ error: error.message }, 400)

    // Y se despacha en el acto, que es todo el punto de un botón de prueba.
    const envio = await despachar(5)
    return json({ evento: data, envio })
  }

  return json({ error: `Acción desconocida '${accion}'` }, 404)
})
