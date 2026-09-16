/**
 * CORSA Carwash — Service Worker
 *
 * Hace dos cosas, y conviene no pedirle más:
 *
 *   1. Recibe los Push y los muestra. Es lo único que sigue corriendo con la
 *      app cerrada, así que es la pieza sin la cual nada de esto existe.
 *
 *   2. Atiende `fetch` con un mínimo: sin un manejador de fetch, Chrome no
 *      considera a CORSA instalable y no ofrece «Agregar a la pantalla de
 *      inicio» — y sin instalar no hay Push en iPhone.
 *
 * LO QUE NO HACE, A PROPÓSITO: no cachea la aplicación. Un Service Worker que
 * guarda el JavaScript de la app sirve una versión vieja después de cada
 * despliegue, y el equipo termina viendo precios o pantallas que ya se
 * cambiaron sin ninguna forma de darse cuenta. Para un sistema de caja eso es
 * peor que no funcionar sin Internet. Lo único que se guarda es la página que
 * se muestra cuando se navega sin red.
 */

// Subir esta versión borra las cachés anteriores al activarse. Se subió al
// regenerar los iconos desde el brandmark real: no porque el Service Worker
// los cachee —no lo hace— sino para que no quede nada de la versión anterior
// dando vueltas.
const VERSION = 'corsa-v2'
const CACHE_OFFLINE = `${VERSION}-offline`
const PAGINA_OFFLINE = '/offline.html'

const ICONO = '/icons/corsa-192.png'
const BADGE = '/icons/corsa-badge-96.png'

// ─── Ciclo de vida ───────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_OFFLINE)
      .then(c => c.add(PAGINA_OFFLINE))
      // Que falle el precacheo no puede impedir la instalación: sin el
      // Service Worker instalado no hay notificaciones, que es lo importante.
      .catch(() => {})
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const nombres = await caches.keys()
    await Promise.all(nombres
      .filter(n => n.startsWith('corsa-') && !n.startsWith(VERSION))
      .map(n => caches.delete(n)))
    await self.clients.claim()
  })())
})

// ─── Red ─────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  // Sólo las navegaciones. Todo lo demás —el JavaScript de la app, las
  // llamadas a Supabase— va directo a la red sin que el Service Worker
  // intervenga, que es lo que garantiza que nunca sirva una versión vieja.
  if (event.request.mode !== 'navigate') return

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(CACHE_OFFLINE)
      return (await cache.match(PAGINA_OFFLINE)) ?? Response.error()
    }),
  )
})

// ─── Push ────────────────────────────────────────────────────

self.addEventListener('push', event => {
  // El texto llega ya redactado desde el servidor. El Service Worker no tiene
  // sesión ni acceso a la base: no podría resolver el nombre de una máquina ni
  // contar los lavados del día aunque quisiera.
  let datos = {}
  try {
    datos = event.data ? event.data.json() : {}
  } catch {
    datos = { title: 'CORSA', body: event.data ? event.data.text() : '' }
  }

  const titulo = datos.title || 'CORSA'
  const opciones = {
    body: datos.body || '',
    icon: ICONO,
    badge: BADGE,
    // El tag agrupa por evento. Dos avisos del mismo evento —un reintento— se
    // reemplazan; dos lavados distintos se ven los dos.
    tag: datos.tag || datos.id || 'corsa',
    timestamp: datos.timestamp || Date.now(),
    // Una falla de máquina se queda hasta que alguien la toca. Un lavado
    // terminado no: a treinta lavados por día, notificaciones que no se van
    // solas dejan el teléfono inservible y se apagan todas.
    requireInteraction: datos.severity === 'CRITICAL',
    vibrate: datos.severity === 'CRITICAL' ? [200, 100, 200] : [100],
    // Lo que lee `notificationclick` para saber a dónde ir.
    data: {
      url: datos.url || '/',
      id: datos.id || null,
      type: datos.type || null,
    },
  }

  event.waitUntil(self.registration.showNotification(titulo, opciones))
})

// ─── Toque en la notificación ────────────────────────────────

self.addEventListener('notificationclick', event => {
  event.notification.close()

  const destino = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({
      type: 'window',
      // Incluye las que todavía no controla este Service Worker: si no, una
      // pestaña abierta desde antes de la instalación no se encuentra y se
      // abre una segunda con la misma app.
      includeUncontrolled: true,
    })

    const base = new URL(destino, self.location.origin)

    // Si CORSA ya está abierta, se navega ESA ventana. Abrir una nueva cada
    // vez deja al usuario con seis pestañas de CORSA al final del turno.
    for (const v of ventanas) {
      if (new URL(v.url).origin !== base.origin) continue
      await v.focus()
      if ('navigate' in v) {
        try {
          await v.navigate(base.href)
          return
        } catch {
          // Algunos navegadores no dejan navegar una ventana ajena. El mensaje
          // de abajo es el plan B: la app escucha y hace el ruteo por dentro.
        }
      }
      v.postMessage({ tipo: 'corsa:navegar', url: destino })
      return
    }

    await self.clients.openWindow(base.href)
  })())
})

// ─── Rotación de la suscripción ──────────────────────────────

/**
 * El navegador puede cambiarle el endpoint a un dispositivo por su cuenta.
 * Cuando pasa, el Service Worker se vuelve a suscribir para no perder el push
 * en curso, pero NO puede avisarle al servidor: no tiene la sesión del
 * usuario. Quien sincroniza es la aplicación, que registra la suscripción
 * vigente cada vez que se abre.
 */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const anterior = event.oldSubscription || await self.registration.pushManager.getSubscription()
    const clave = event.newSubscription?.options?.applicationServerKey
      ?? anterior?.options?.applicationServerKey
    if (!clave) return

    try {
      await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: clave,
      })
    } catch {
      // Sin suscripción nueva, la app la va a crear en la próxima apertura.
    }
  })())
})
