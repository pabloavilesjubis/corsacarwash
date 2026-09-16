/**
 * CORSA — Web Push, implementado sobre Web Crypto.
 *
 * POR QUÉ NO SE USA LA LIBRERÍA `web-push`
 * Esa librería está escrita para Node: usa `https.request`, `Buffer` y el
 * módulo `crypto` de Node. En el runtime de las Edge Functions eso funciona
 * *por compatibilidad*, que es otra forma de decir que funciona hasta que
 * Supabase actualice el runtime. Este archivo usa sólo lo que el estándar
 * garantiza —`crypto.subtle` y `fetch`— y por eso no se puede romper solo.
 *
 * Son dos criptografías distintas y conviene no confundirlas:
 *
 *   1. VAPID (RFC 8292) identifica al SERVIDOR ante el servicio de push. Es un
 *      JWT firmado con ES256. Le dice a Google/Apple/Mozilla «este que manda
 *      soy yo, el dueño de esta clave pública». No cifra nada.
 *
 *   2. El cifrado del contenido (RFC 8291 sobre RFC 8188) protege el MENSAJE
 *      del servicio de push. Google reenvía el push al teléfono sin poder
 *      leerlo: la clave sale de un ECDH contra la clave pública que generó el
 *      navegador. Por eso el servidor guarda `p256dh` y `auth` de cada
 *      dispositivo — sin ellos, el push viaja vacío.
 */

// ─── base64url ───────────────────────────────────────────────
// Sin relleno y con - _ en vez de + /. Es lo que usan tanto las claves VAPID
// como lo que devuelve `PushSubscription.toJSON()` en el navegador.

export function b64urlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function bytesToB64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}

const utf8 = (s: string) => new TextEncoder().encode(s)

// ─── VAPID ───────────────────────────────────────────────────

/**
 * La privada VAPID se guarda como los 32 bytes crudos del escalar (que es lo
 * que genera cualquier herramienta de VAPID). Web Crypto sólo importa EC como
 * JWK o PKCS#8, así que hay que armar el JWK — y para eso hacen falta también
 * las coordenadas de la pública, que salen de sus 65 bytes: 0x04 ‖ X(32) ‖ Y(32).
 */
async function importarClaveVapid(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicKey)
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY no es una clave P-256 sin comprimir (65 bytes que empiezan en 0x04)')
  }
  const d = b64urlToBytes(privateKey)
  if (d.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY no tiene 32 bytes')
  }

  return await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      d: bytesToB64url(d),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

/**
 * El JWT que identifica a CORSA ante el servicio de push.
 *
 * `aud` es el ORIGEN del endpoint, no el endpoint entero: un token emitido
 * para fcm.googleapis.com no sirve contra Apple, que es justo lo que se busca.
 *
 * Doce horas de vigencia: el máximo que acepta la especificación es 24 y
 * quedarse corto evita problemas de reloj desincronizado en los dos extremos.
 */
export async function firmarVapid(
  endpoint: string,
  publicKey: string,
  privateKey: string,
  subject: string,
): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = { typ: 'JWT', alg: 'ES256' }
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  }

  const entrada = `${bytesToB64url(utf8(JSON.stringify(header)))}.${bytesToB64url(utf8(JSON.stringify(payload)))}`
  const key = await importarClaveVapid(publicKey, privateKey)
  // ECDSA en Web Crypto devuelve la firma cruda r‖s (64 bytes), que es
  // exactamente el formato que pide JWS. No hay que desenvolver DER.
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(entrada))

  return `${entrada}.${bytesToB64url(new Uint8Array(firma))}`
}

// ─── Cifrado del contenido (RFC 8291 / aes128gcm) ────────────

async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8)
  return new Uint8Array(bits)
}

/** Tamaño de registro. Un solo registro alcanza: los mensajes son de texto. */
const RECORD_SIZE = 4096
/** 17 = el byte delimitador (0x02) más los 16 del tag de AES-GCM. */
const MAX_PAYLOAD = RECORD_SIZE - 17

/**
 * El material efímero del mensaje. En producción se genera al azar y nadie lo
 * pasa; el parámetro existe para poder correr el vector de prueba del RFC 8291
 * contra esta misma función, que es la única forma de saber que el cifrado es
 * correcto sin tener un teléfono en la mano.
 */
export interface MaterialEfimero {
  salt: Uint8Array
  privada: CryptoKey
  publica: Uint8Array
}

export async function cifrar(
  texto: string, p256dh: string, authSecret: string, material?: MaterialEfimero,
): Promise<Uint8Array> {
  const claro = utf8(texto)
  if (claro.length > MAX_PAYLOAD) {
    throw new Error(`El mensaje excede ${MAX_PAYLOAD} bytes`)
  }

  const uaPublic = b64urlToBytes(p256dh)
  const auth = b64urlToBytes(authSecret)
  const salt = material?.salt ?? crypto.getRandomValues(new Uint8Array(16))

  // Par efímero: uno nuevo por mensaje. Reusarlo haría que dos pushes al mismo
  // dispositivo compartieran clave, y ahí el cifrado deja de servir de mucho.
  const efimero = material
    ? { privateKey: material.privada, publicKey: null as unknown as CryptoKey }
    : await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPublic = material?.publica
    ?? new Uint8Array(await crypto.subtle.exportKey('raw', efimero.publicKey))

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const compartido = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, efimero.privateKey, 256))

  // El orden de las claves públicas dentro del `info` importa y no es
  // arbitrario: primero la del navegador, después la nuestra. Invertirlas da
  // un secreto distinto y el teléfono recibe un mensaje que no puede descifrar
  // — sin ningún error visible del lado del servidor.
  const prk = await hkdf(
    auth, compartido,
    concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32)

  const cek   = await hkdf(salt, prk, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, prk, utf8('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // 0x02 marca el último registro. Sin él, el navegador espera otro más.
  const conRelleno = concat(claro, new Uint8Array([0x02]))
  const cifrado = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, conRelleno))

  // Cabecera de RFC 8188: salt(16) ‖ tamaño de registro(4, big-endian) ‖
  // largo del id(1) ‖ id (acá, nuestra clave pública efímera).
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false)

  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cifrado)
}

// ─── Envío ───────────────────────────────────────────────────

export interface Suscripcion {
  endpoint: string
  p256dh: string
  auth: string
}

export interface ClavesVapid {
  publicKey: string
  privateKey: string
  subject: string
}

export interface ResultadoEnvio {
  ok: boolean
  status: number
  error?: string
}

/**
 * Un push a un dispositivo.
 *
 * Nunca lanza: devuelve el resultado. Quien llama tiene que registrar el
 * fallo de un dispositivo y seguir con los demás — que a un teléfono viejo le
 * falle el push no puede impedir que le llegue a los otros cuatro.
 */
export async function enviarPush(
  sub: Suscripcion,
  mensaje: string,
  vapid: ClavesVapid,
  opciones: { ttl?: number; urgencia?: 'very-low' | 'low' | 'normal' | 'high' } = {},
): Promise<ResultadoEnvio> {
  try {
    const cuerpo = await cifrar(mensaje, sub.p256dh, sub.auth)
    const jwt = await firmarVapid(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject)

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        // TTL: cuánto guarda el servicio el push si el teléfono está apagado.
        // Un día para lo normal; quien llama lo baja para lo que caduca.
        'TTL': String(opciones.ttl ?? 86400),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Urgency': opciones.urgencia ?? 'normal',
        'Authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
      },
      body: cuerpo,
    })

    if (res.ok) return { ok: true, status: res.status }

    // El cuerpo del error dice cosas útiles («UnauthorizedRegistration»,
    // «VAPID credential mismatch») que después aparecen en el monitoreo.
    const detalle = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: detalle.slice(0, 400) || res.statusText }
  } catch (err) {
    // status 0 = ni siquiera se llegó a hablar con el servicio de push.
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
