/**
 * CORSA Carwash — Web Push del lado del navegador.
 *
 * Todo lo que el navegador necesita para suscribirse, y nada más: qué decide
 * quién recibe qué está en la base, no acá.
 *
 * LA REGLA DE LOS PERMISOS
 * No se pide permiso al abrir la app. Un navegador que pregunta por
 * notificaciones antes de que el usuario sepa qué hace la aplicación recibe un
 * «Bloquear», y ese bloqueo es permanente: Chrome y Safari no vuelven a
 * preguntar nunca. Se pierde la posibilidad para siempre por haber preguntado
 * cinco segundos antes de tiempo. Por eso `activar()` sólo se llama desde un
 * clic explícito.
 */

import { supabase } from './supabase'

// ─── Qué puede hacer este dispositivo ────────────────────────

export type MotivoSinSoporte =
  | 'sin-service-worker'
  | 'sin-push'
  | 'sin-notificaciones'
  | 'ios-sin-instalar'
  | 'contexto-inseguro'

export interface Capacidades {
  soportado: boolean
  motivo: MotivoSinSoporte | null
  permiso: NotificationPermission | 'no-disponible'
  esIOS: boolean
  instalada: boolean
}

/** Corriendo como app instalada y no como pestaña del navegador. */
export function estaInstalada(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches
    // iOS no implementa display-mode: standalone; usa esta propiedad propia.
    || (navigator as unknown as { standalone?: boolean }).standalone === true
}

export function esIOS(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua)
    // iPadOS se hace pasar por Mac; el touch lo delata.
    || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

export function capacidades(): Capacidades {
  const ios = esIOS()
  const instalada = estaInstalada()
  const base = { esIOS: ios, instalada }

  // Sin HTTPS no hay Service Worker. Pasa en desarrollo cuando se abre la app
  // por la IP de la red en vez de por localhost.
  if (!window.isSecureContext) {
    return { ...base, soportado: false, motivo: 'contexto-inseguro', permiso: 'no-disponible' }
  }
  if (!('serviceWorker' in navigator)) {
    return { ...base, soportado: false, motivo: 'sin-service-worker', permiso: 'no-disponible' }
  }
  if (!('Notification' in window)) {
    return { ...base, soportado: false, motivo: 'sin-notificaciones', permiso: 'no-disponible' }
  }
  if (!('PushManager' in window)) {
    // En iOS es lo que pasa mientras la app no está instalada: Safari expone
    // Notification pero no PushManager hasta que se agrega a la pantalla de
    // inicio. No es que el teléfono no pueda: es que falta un paso.
    return {
      ...base,
      soportado: false,
      motivo: ios && !instalada ? 'ios-sin-instalar' : 'sin-push',
      permiso: Notification.permission,
    }
  }

  return { ...base, soportado: true, motivo: null, permiso: Notification.permission }
}

// ─── Utilidades ──────────────────────────────────────────────

/**
 * La clave VAPID viaja en base64url y `pushManager.subscribe` la pide en
 * bytes. No hay atajo: pasarle el texto hace que el navegador rechace la
 * suscripción con un error que no dice nada de esto.
 */
function claveABytes(base64url: string): Uint8Array {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/')
  const binario = atob(base64)
  const bytes = new Uint8Array(binario.length)
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i)
  return bytes
}

function bytesAB64url(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binario = ''
  for (const b of bytes) binario += String.fromCharCode(b)
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function urlDelDespachador(ruta = ''): string {
  const base = import.meta.env.VITE_SUPABASE_URL as string
  return `${base}/functions/v1/push-dispatch${ruta}`
}

/**
 * La clave pública VAPID.
 *
 * Primero la variable de build, si está; si no, se le pregunta a la función.
 * La segunda vía existe para que la clave tenga UN solo dueño: si se rotara y
 * el frontend siguiera con la vieja compilada adentro, las suscripciones
 * nuevas se crearían contra una clave que el servidor ya no tiene y los pushes
 * fallarían sin que nada lo indique.
 */
let claveEnCache: string | null = null

export async function claveVapid(): Promise<string> {
  if (claveEnCache) return claveEnCache

  const deBuild = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (deBuild) {
    claveEnCache = deBuild
    return deBuild
  }

  // La anon key va aunque la función no exija sesión: es lo que la pasarela de
  // Supabase espera, y sin ella algunos proyectos responden 401 antes de que la
  // función llegue a ejecutarse.
  const res = await fetch(urlDelDespachador('/vapid-public-key'), {
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
  })
  if (!res.ok) throw new Error('El servidor no tiene configuradas las claves VAPID')
  const { publicKey } = await res.json()
  if (!publicKey) throw new Error('El servidor no devolvió la clave pública')

  claveEnCache = publicKey
  return publicKey
}

/** Un nombre reconocible en una lista de dispositivos. */
export function nombreDelDispositivo(): string {
  const ua = navigator.userAgent

  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/Android/.test(ua)) {
    // Los Android traen el modelo en el user agent, entre el «; » y el «)».
    const modelo = ua.match(/;\s*([^;)]+)\s*(?:Build|\))/)
    return modelo ? modelo[1].trim() : 'Android'
  }
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Linux/.test(ua)) return 'Linux'
  return 'Dispositivo'
}

export function plataforma(): string {
  if (esIOS()) return 'ios'
  if (/Android/.test(navigator.userAgent)) return 'android'
  return 'desktop'
}

// ─── Service Worker ──────────────────────────────────────────

export async function registrarServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null
  try {
    // scope '/' para que el Service Worker controle toda la app: registrado
    // desde una subruta sólo vería esa rama.
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch {
    return null
  }
}

async function registroListo(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  const existente = await navigator.serviceWorker.getRegistration('/')
  if (existente) return existente
  return await registrarServiceWorker()
}

// ─── Activar / desactivar ────────────────────────────────────

export interface ResultadoActivacion {
  ok: boolean
  permiso: NotificationPermission | 'no-disponible'
  error?: string
}

/**
 * Pide permiso, se suscribe y registra el dispositivo. SÓLO desde un clic.
 */
export async function activar(): Promise<ResultadoActivacion> {
  const cap = capacidades()
  if (!cap.soportado) {
    return { ok: false, permiso: cap.permiso, error: cap.motivo ?? 'sin-soporte' }
  }

  const permiso = await Notification.requestPermission()
  if (permiso !== 'granted') {
    return { ok: false, permiso, error: 'permiso-denegado' }
  }

  const registro = await registroListo()
  if (!registro) return { ok: false, permiso, error: 'sin-service-worker' }

  try {
    const clave = await claveVapid()

    // Puede haber una suscripción previa creada con OTRA clave VAPID —si se
    // rotaron— y en ese caso subscribe() falla con InvalidStateError. Se da de
    // baja la vieja antes de pedir la nueva.
    const previa = await registro.pushManager.getSubscription()
    if (previa) {
      const mismaClave = bytesAB64url(previa.options.applicationServerKey ?? null) === clave
      if (!mismaClave) await previa.unsubscribe()
    }

    const suscripcion = await registro.pushManager.getSubscription()
      ?? await registro.pushManager.subscribe({
        // Obligatorio en todos los navegadores: se compromete a que cada push
        // muestre algo. Un push silencioso haría que el navegador revoque el
        // permiso por su cuenta.
        userVisibleOnly: true,
        applicationServerKey: claveABytes(clave) as BufferSource,
      })

    await guardarSuscripcion(suscripcion)
    return { ok: true, permiso }
  } catch (err) {
    return {
      ok: false,
      permiso,
      error: err instanceof Error ? err.message : 'no-se-pudo-suscribir',
    }
  }
}

/**
 * Manda la suscripción al servidor.
 *
 * `reactivar` distingue las dos razones por las que se llama. Al tocar
 * «Activar» va en true y el dispositivo queda encendido. Al sincronizar en cada
 * apertura va en false: refresca las claves y la actividad sin tocar el
 * interruptor, porque si no, alguien que apagó las notificaciones de su laptop
 * las vería volver solas en la próxima recarga.
 */
export async function guardarSuscripcion(s: PushSubscription, reactivar = true): Promise<void> {
  const json = s.toJSON()
  const { error } = await (supabase.rpc as any)('corsa_registrar_dispositivo', {
    p_endpoint: s.endpoint,
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
    p_device_name: nombreDelDispositivo(),
    p_user_agent: navigator.userAgent,
    p_platform: plataforma(),
    p_standalone: estaInstalada(),
    p_reactivar: reactivar,
  })
  if (error) throw new Error(error.message)
}

/**
 * Da de baja este dispositivo.
 *
 * Se desuscribe en el navegador Y se apaga la fila en la base. Sólo lo primero
 * dejaría al servidor mandando pushes a un endpoint muerto hasta que el
 * servicio de push devolviera 410.
 */
export async function desactivar(): Promise<void> {
  const registro = await navigator.serviceWorker.getRegistration('/')
  const suscripcion = await registro?.pushManager.getSubscription()

  if (suscripcion) {
    const { data } = await (supabase as any)
      .from('push_subscriptions')
      .select('id')
      .eq('endpoint', suscripcion.endpoint)
      .maybeSingle()

    if (data?.id) {
      await (supabase.rpc as any)('corsa_dispositivo_preferencias', {
        p_id: data.id, p_enabled: false,
      })
    }
    await suscripcion.unsubscribe()
  }
}

/**
 * El id de la fila de ESTE dispositivo en la base, si está registrado.
 *
 * Se busca por el endpoint completo y no por un fragmento: dos endpoints del
 * mismo servicio de push comparten estructura y terminan pareciéndose, y
 * confundir dos dispositivos haría que la pantalla marcara «Este dispositivo»
 * sobre el teléfono de otra persona.
 */
export async function idDeEsteDispositivo(): Promise<string | null> {
  const s = await suscripcionActual()
  if (!s) return null

  const { data } = await (supabase as any)
    .from('push_subscriptions')
    .select('id')
    .eq('endpoint', s.endpoint)
    .maybeSingle()

  return data?.id ?? null
}

/** La suscripción vigente de este navegador, si la hay. */
export async function suscripcionActual(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  const registro = await navigator.serviceWorker.getRegistration('/')
  return (await registro?.pushManager.getSubscription()) ?? null
}

/**
 * Sincroniza al abrir la app.
 *
 * Es lo que cubre la rotación del endpoint: el navegador puede cambiárselo a
 * un dispositivo por su cuenta, y el Service Worker, que es quien se entera,
 * no tiene la sesión del usuario para avisarle al servidor. La app sí.
 *
 * No pide permiso ni se suscribe: si el usuario nunca activó nada, esto no
 * hace absolutamente nada.
 */
export async function sincronizar(): Promise<void> {
  try {
    if (!capacidades().soportado || Notification.permission !== 'granted') return
    const suscripcion = await suscripcionActual()
    if (!suscripcion) return
    await guardarSuscripcion(suscripcion, false)
  } catch {
    // Que falle la sincronización no puede impedir que la app cargue.
  }
}

/** Dispara un evento simulado. Sólo funciona con la simulación habilitada. */
export async function enviarPrueba(
  tipo: 'TEST' | 'WASH_COMPLETED' | 'MACHINE_ERROR' | 'DAILY_CLOSE' = 'TEST',
  extra: { machine?: string; servicio?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { ok: false, error: 'Sin sesión' }

  const res = await fetch(urlDelDespachador(tipo === 'TEST' ? '/test' : '/simulate'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ tipo, machine: extra.machine ?? null, servicio: extra.servicio ?? null }),
  })

  const cuerpo = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: cuerpo.error ?? `Error ${res.status}` }
  return { ok: true }
}
