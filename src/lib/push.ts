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

// ─── Rastro ──────────────────────────────────────────────────

/**
 * Las etapas de la activación, en orden. Un fallo sin etapa es imposible de
 * diagnosticar: «Failed to fetch» puede venir de la clave VAPID o del registro
 * en el backend, y son dos problemas que no se parecen en nada.
 */
export type EtapaPush =
  | 'capacidades'
  | 'permission'
  | 'service worker ready'
  | 'vapid key'
  | 'subscription created'
  | 'sending subscription to backend'
  | 'backend response'
  | 'subscription saved'

/**
 * El detalle completo de un fallo. `name`, `message` y `stack` del error real,
 * más la URL y el código HTTP cuando los hay.
 *
 * `Failed to fetch` solo no dice nada: es el mensaje que tira el navegador para
 * TODO lo que no llegó a ser una respuesta —DNS, TLS, CORS, un preflight que no
 * devolvió 2xx—. Sin la URL al lado, no hay forma de saber cuál de esas cosas
 * pasó ni contra qué servidor.
 */
export interface ErrorPush {
  etapa: EtapaPush
  name: string
  message: string
  stack?: string
  url?: string
  status?: number
  /** Qué hacer, cuando se puede deducir. */
  sugerencia?: string
}

/**
 * El rastro se imprime SIEMPRE, no sólo en desarrollo.
 *
 * Es deliberado: el fallo que hay que diagnosticar ocurre en el teléfono contra
 * el CORSA desplegado, donde `import.meta.env.DEV` es false y un log de
 * desarrollo no existiría. Son seis líneas por clic en «Activar»; el ruido es
 * nada al lado de tener que conectar el teléfono por USB para ver por qué no
 * funciona.
 */
function paso(etapa: EtapaPush, extra?: unknown): void {
  if (extra === undefined) console.info(`[PUSH] ${etapa}`)
  else console.info(`[PUSH] ${etapa}`, extra)
}

function fallo(etapa: EtapaPush, err: unknown, extra: Partial<ErrorPush> = {}): ErrorPush {
  const e = err instanceof Error ? err : new Error(String(err))
  const detalle: ErrorPush = {
    etapa,
    name: e.name,
    message: e.message,
    stack: e.stack,
    ...extra,
  }
  console.error(`[PUSH] ✗ ${etapa}`, detalle)
  return detalle
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

/** De dónde salió la clave: sirve para el diagnóstico en pantalla. */
export let origenDeLaClave: 'build' | 'funcion' | null = null

export async function claveVapid(): Promise<string> {
  if (claveEnCache) return claveEnCache

  const deBuild = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (deBuild) {
    claveEnCache = deBuild
    origenDeLaClave = 'build'
    paso('vapid key', { origen: 'VITE_VAPID_PUBLIC_KEY', largo: deBuild.length })
    return deBuild
  }

  const url = urlDelDespachador('/vapid-public-key')

  // SIN cabeceras. `apikey` no está en la lista blanca de CORS, así que basta
  // con mandarla para que el navegador haga un preflight OPTIONS antes del GET.
  //
  // Y ahí está el problema que esto arregla: si la función no está desplegada,
  // la pasarela de Supabase responde el preflight con 404. Un preflight que no
  // devuelve 2xx es, para el navegador, un error de red: `fetch` rechaza con
  // «TypeError: Failed to fetch» y NUNCA se llega a ver el 404. El síntoma
  // oculta la causa.
  //
  // Sin cabeceras el GET es una petición simple, no hay preflight, y un 404
  // llega como lo que es: un 404 que se puede leer y explicar.
  let res: Response
  try {
    res = await fetch(url, { method: 'GET' })

    // Cinturón: si algún día la pasarela exigiera la anon key, el GET simple
    // daría 401. Se reintenta CON la cabecera, aceptando el preflight — que en
    // ese escenario sí va a responder 2xx, porque la función existe.
    if (res.status === 401 || res.status === 403) {
      res = await fetch(url, {
        headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
      })
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    throw Object.assign(
      new Error(`No se pudo contactar a ${url} (${e.name}: ${e.message})`),
      {
        url,
        sugerencia: 'Puede ser que la Edge Function push-dispatch no esté desplegada, '
                  + 'que la respuesta no traiga CORS, o que no haya red.',
      })
  }

  if (!res.ok) {
    const pista = res.status === 404
      ? 'La Edge Function push-dispatch no está desplegada. Corré: supabase functions deploy push-dispatch'
      : 'El servidor no tiene configuradas las claves VAPID (VAPID_PUBLIC_KEY).'
    throw Object.assign(new Error(pista), { url, status: res.status })
  }

  const { publicKey } = await res.json()
  if (!publicKey) {
    throw Object.assign(new Error('El servidor no devolvió la clave pública'),
      { url, status: res.status })
  }

  claveEnCache = publicKey
  origenDeLaClave = 'funcion'
  paso('vapid key', { origen: url, largo: publicKey.length })
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
  /** Código corto para decidir qué mensaje mostrar. */
  error?: string
  /** El detalle completo, para la pantalla de diagnóstico y la consola. */
  detalle?: ErrorPush
}

/**
 * Pide permiso, se suscribe y registra el dispositivo. SÓLO desde un clic.
 */
export async function activar(): Promise<ResultadoActivacion> {
  const cap = capacidades()
  paso('capacidades', cap)
  if (!cap.soportado) {
    return { ok: false, permiso: cap.permiso, error: cap.motivo ?? 'sin-soporte' }
  }

  const permiso = await Notification.requestPermission()
  paso('permission', permiso)
  if (permiso !== 'granted') {
    return { ok: false, permiso, error: 'permiso-denegado' }
  }

  let etapa: EtapaPush = 'service worker ready'
  try {
    const registro = await registroListo()
    if (!registro) {
      return {
        ok: false, permiso, error: 'sin-service-worker',
        detalle: fallo(etapa, new Error('No se pudo registrar /sw.js'),
          { url: new URL('/sw.js', location.origin).href,
            sugerencia: 'Verificá que /sw.js se sirva desde la raíz del dominio.' }),
      }
    }
    paso('service worker ready', { scope: registro.scope, activo: Boolean(registro.active) })

    etapa = 'vapid key'
    const clave = await claveVapid()

    etapa = 'subscription created'
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
    paso('subscription created', { endpoint: suscripcion.endpoint.slice(0, 60) + '…' })

    etapa = 'sending subscription to backend'
    await guardarSuscripcion(suscripcion)

    paso('subscription saved')
    return { ok: true, permiso }
  } catch (err) {
    const extra = err as { url?: string; status?: number; sugerencia?: string }
    return {
      ok: false,
      permiso,
      error: err instanceof Error ? err.message : 'no-se-pudo-suscribir',
      detalle: fallo(etapa, err, {
        url: extra?.url,
        status: extra?.status,
        sugerencia: extra?.sugerencia,
      }),
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
  const urlRpc = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/corsa_registrar_dispositivo`
  paso('sending subscription to backend', { url: urlRpc, reactivar })

  const { data, error } = await (supabase.rpc as any)('corsa_registrar_dispositivo', {
    p_endpoint: s.endpoint,
    p_p256dh: json.keys?.p256dh ?? '',
    p_auth: json.keys?.auth ?? '',
    p_device_name: nombreDelDispositivo(),
    p_user_agent: navigator.userAgent,
    p_platform: plataforma(),
    p_standalone: estaInstalada(),
    p_reactivar: reactivar,
  })

  // supabase-js NO lanza: devuelve { data, error }. Un `error` acá puede ser
  // tanto un rechazo del servidor (RLS, permiso, sesión vencida) como un fallo
  // de red, y hay que poder distinguirlos: el `code` viene sólo en el primer
  // caso.
  paso('backend response', error
    ? { ok: false, code: (error as any).code, message: error.message, details: (error as any).details }
    : { ok: true, id: data })

  if (error) {
    const e = error as { message: string; code?: string; details?: string; hint?: string }
    throw Object.assign(new Error(e.message), {
      url: urlRpc,
      name: e.code ? `PostgrestError ${e.code}` : 'PostgrestError',
      sugerencia: e.code === 'PGRST202'
        ? 'El RPC corsa_registrar_dispositivo no existe: falta correr la migración 0042.'
        : e.message.includes('sesión')
          ? 'La sesión de Supabase no llegó al servidor. Volvé a iniciar sesión.'
          : undefined,
    })
  }
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

// ─── Diagnóstico ─────────────────────────────────────────────

export interface Chequeo {
  clave: string
  titulo: string
  /** true = bien · false = mal · null = no aplica en este dispositivo. */
  ok: boolean | null
  detalle: string
  sugerencia?: string
}

/**
 * Revisa el camino completo, paso por paso, sin activar nada.
 *
 * POR QUÉ ESTO VIVE EN LA PANTALLA Y NO EN LA CONSOLA
 * El fallo que hay que diagnosticar pasa en un teléfono contra el CORSA
 * desplegado. Leer la consola de un Android exige un cable USB y
 * chrome://inspect desde una computadora; en un iPhone, macOS con Safari.
 * Un diagnóstico que sólo se ve en la consola es un diagnóstico que, en la
 * práctica, nadie va a mirar.
 *
 * Todo lo que hace son lecturas: no pide permisos, no suscribe y no escribe.
 */
export async function diagnosticar(): Promise<Chequeo[]> {
  const out: Chequeo[] = []
  const cap = capacidades()

  // 1 · Contexto seguro
  out.push({
    clave: 'contexto',
    titulo: 'Conexión segura (HTTPS)',
    ok: window.isSecureContext,
    detalle: `${location.protocol}//${location.host}`,
    sugerencia: window.isSecureContext ? undefined
      : 'Las notificaciones necesitan https:// o localhost. Por IP de la red no funcionan.',
  })

  // 2 · Service Worker
  let registro: ServiceWorkerRegistration | null = null
  if ('serviceWorker' in navigator) {
    registro = (await navigator.serviceWorker.getRegistration('/')) ?? null
  }
  out.push({
    clave: 'sw',
    titulo: 'Service Worker',
    ok: Boolean(registro?.active),
    detalle: registro
      ? `scope ${registro.scope} · ${registro.active ? 'activo' : 'instalándose'}`
      : 'no registrado',
    sugerencia: registro ? undefined
      : 'Recargá la página. Si sigue, verificá que /sw.js se sirva desde la raíz.',
  })

  // 3 · Soporte de Push y permiso
  out.push({
    clave: 'push',
    titulo: 'API de Push',
    ok: cap.soportado,
    detalle: cap.soportado
      ? `disponible · permiso: ${cap.permiso}`
      : `no disponible (${cap.motivo}) · ${cap.esIOS ? 'iOS' : plataforma()}${cap.instalada ? ' · instalada' : ' · en el navegador'}`,
    sugerencia: cap.motivo === 'ios-sin-instalar'
      ? 'En iPhone hay que agregar CORSA a la pantalla de inicio y abrirla desde ahí.'
      : undefined,
  })

  // 4 · Clave VAPID. Es la etapa donde más falla, porque depende de que la
  //     Edge Function esté desplegada.
  const urlVapid = urlDelDespachador('/vapid-public-key')
  const deBuild = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  if (deBuild) {
    out.push({
      clave: 'vapid',
      titulo: 'Clave pública VAPID',
      ok: true,
      detalle: `de VITE_VAPID_PUBLIC_KEY · ${deBuild.length} caracteres`,
    })
  } else {
    try {
      const res = await fetch(urlVapid, { method: 'GET' })
      const cuerpo = await res.json().catch(() => ({}))
      out.push({
        clave: 'vapid',
        titulo: 'Clave pública VAPID',
        ok: res.ok && Boolean(cuerpo.publicKey),
        detalle: res.ok
          ? `de push-dispatch · ${String(cuerpo.publicKey ?? '').length} caracteres`
          : `HTTP ${res.status} en ${urlVapid}`,
        sugerencia: res.status === 404
          ? 'La Edge Function push-dispatch no está desplegada: supabase functions deploy push-dispatch'
          : res.ok ? undefined
            : 'Faltan los secretos VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en la función.',
      })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      out.push({
        clave: 'vapid',
        titulo: 'Clave pública VAPID',
        ok: false,
        detalle: `${e.name}: ${e.message} · ${urlVapid}`,
        sugerencia: 'No se llegó al servidor: función sin desplegar, CORS o falta de red.',
      })
    }
  }

  // 5 · Sesión
  const { data: { session } } = await supabase.auth.getSession()
  out.push({
    clave: 'sesion',
    titulo: 'Sesión de CORSA',
    ok: Boolean(session),
    detalle: session
      ? `${session.user.email ?? session.user.id} · expira ${new Date((session.expires_at ?? 0) * 1000).toLocaleTimeString('es-SV')}`
      : 'sin sesión',
    sugerencia: session ? undefined : 'Volvé a iniciar sesión.',
  })

  // 6 · El backend, con la sesión puesta. Una lectura que pasa por la misma
  //     autenticación y la misma RLS que el registro del dispositivo.
  try {
    const { error } = await (supabase.rpc as any)('corsa_notificaciones_recientes', { p_limite: 1 })
    out.push({
      clave: 'backend',
      titulo: 'Base de datos (autenticación y RLS)',
      ok: !error,
      detalle: error
        ? `${(error as any).code ?? 'error'}: ${error.message}`
        : 'responde correctamente',
      sugerencia: (error as any)?.code === 'PGRST202'
        ? 'Falta correr la migración 0042 en Supabase.' : undefined,
    })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    out.push({
      clave: 'backend',
      titulo: 'Base de datos (autenticación y RLS)',
      ok: false,
      detalle: `${e.name}: ${e.message}`,
    })
  }

  console.info('[PUSH] diagnóstico', out)
  return out
}
