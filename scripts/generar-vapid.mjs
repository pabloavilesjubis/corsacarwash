#!/usr/bin/env node
/**
 * CORSA — genera el par de claves VAPID para Web Push.
 *
 *   node scripts/generar-vapid.mjs
 *
 * VAPID identifica al servidor ante el servicio de push del navegador. La
 * pública viaja en cada suscripción y en cada push; la privada firma. Son un
 * par: cambiar la pública invalida TODAS las suscripciones existentes, porque
 * el navegador ata cada suscripción a la clave con la que se creó.
 *
 * Por eso se generan una vez y se guardan. Si algún día hay que rotarlas, hay
 * que contar con que todos los dispositivos tienen que volver a suscribirse.
 *
 * El formato es el estándar —los 65 bytes sin comprimir de la pública y los 32
 * del escalar privado, en base64url— así que estas claves sirven igual con
 * cualquier otra herramienta de Web Push.
 */
import { webcrypto as crypto } from 'node:crypto'

const b64url = bytes =>
  Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const par = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])

const publica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey))
const jwk = await crypto.subtle.exportKey('jwk', par.privateKey)

console.log(`
─────────────────────────────────────────────────────────────
  CORSA — claves VAPID
─────────────────────────────────────────────────────────────

Secretos de la Edge Function (Supabase → Edge Functions → Secrets):

  VAPID_PUBLIC_KEY=${b64url(publica)}
  VAPID_PRIVATE_KEY=${jwk.d}
  VAPID_SUBJECT=mailto:soporte@corsacarwash.com

O desde la terminal:

  supabase secrets set \\
    VAPID_PUBLIC_KEY=${b64url(publica)} \\
    VAPID_PRIVATE_KEY=${jwk.d} \\
    VAPID_SUBJECT=mailto:soporte@corsacarwash.com \\
    PUSH_DISPATCH_SECRET=$(openssl rand -hex 32 2>/dev/null || echo '<generar con: openssl rand -hex 32>')

Opcional, en .env.local del frontend (evita una llamada al suscribirse):

  VITE_VAPID_PUBLIC_KEY=${b64url(publica)}

─────────────────────────────────────────────────────────────
  LA PRIVADA NO VA AL FRONTEND, NI AL REPOSITORIO, NI A UN
  CHAT. Con ella, cualquiera puede mandarle notificaciones a
  los teléfonos del equipo en nombre de CORSA.
─────────────────────────────────────────────────────────────
`)
