/**
 * CORSA — prueba del cifrado de Web Push.
 *
 * Verifica supabase/functions/push-dispatch/webpush.ts contra el vector de
 * prueba oficial del RFC 8291, apéndice A.
 *
 * POR QUÉ ESTA PRUEBA Y NO UNA DE IDA Y VUELTA
 * Un cifrado mal derivado —las dos claves públicas al revés dentro del `info`,
 * el byte 0x00 de más o de menos— se descifra perfectamente con el MISMO
 * código equivocado. La prueba de ida y vuelta pasaría y el teléfono no
 * mostraría nada, sin ningún error del lado del servidor. El vector del RFC es
 * un dato externo: si el resultado coincide byte a byte con el que publicó el
 * IETF, la derivación es la correcta y no la nuestra.
 *
 * Correr:  node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// El módulo bajo prueba es TypeScript de Deno. Se transpila acá en vez de
// mantener una copia en JavaScript: una copia se desincroniza y la prueba
// pasaría a verificar código que ya no es el que se despliega.
const raiz = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const fuente = readFileSync(join(raiz, 'supabase/functions/push-dispatch/webpush.ts'), 'utf8')
const js = ts.transpileModule(fuente, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const destino = join(mkdtempSync(join(tmpdir(), 'corsa-webpush-')), 'webpush.mjs')
writeFileSync(destino, js)
const webpush = await import(destino)

// ─── Vector del RFC 8291 (§5 y apéndice A) ───────────────────
const VECTOR = {
  textoPlano: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  esperado:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

/** La privada del emisor, importada como clave ECDH a partir de su escalar. */
async function importarPrivadaEcdh(privadaB64url, publicaB64url) {
  const pub = webpush.b64urlToBytes(publicaB64url)
  return await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256',
      x: webpush.bytesToB64url(pub.slice(1, 33)),
      y: webpush.bytesToB64url(pub.slice(33, 65)),
      d: privadaB64url,
      ext: true,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  )
}

test('el cifrado reproduce byte a byte el vector del RFC 8291', async () => {
  const cuerpo = await webpush.cifrar(
    VECTOR.textoPlano, VECTOR.uaPublic, VECTOR.authSecret,
    {
      salt: webpush.b64urlToBytes(VECTOR.salt),
      privada: await importarPrivadaEcdh(VECTOR.asPrivate, VECTOR.asPublic),
      publica: webpush.b64urlToBytes(VECTOR.asPublic),
    },
  )

  assert.equal(webpush.bytesToB64url(cuerpo), VECTOR.esperado)
})

test('la cabecera del registro tiene la forma de la RFC 8188', async () => {
  const cuerpo = await webpush.cifrar('hola', VECTOR.uaPublic, VECTOR.authSecret)

  // salt(16) ‖ tamaño de registro(4) ‖ largo del id(1) ‖ clave pública(65)
  assert.equal(cuerpo[20], 65, 'el largo del id debe ser 65')
  assert.equal(new DataView(cuerpo.buffer, cuerpo.byteOffset).getUint32(16, false), 4096)
  assert.equal(cuerpo[21], 0x04, 'la clave pública va sin comprimir')

  // Dos cifrados del mismo texto no pueden dar lo mismo: la sal y el par
  // efímero son nuevos cada vez.
  const otro = await webpush.cifrar('hola', VECTOR.uaPublic, VECTOR.authSecret)
  assert.notEqual(webpush.bytesToB64url(cuerpo), webpush.bytesToB64url(otro))
})

test('el JWT de VAPID se firma y se verifica con la clave pública', async () => {
  // Un par VAPID cualquiera, generado acá mismo.
  const par = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey))
  const jwk = await crypto.subtle.exportKey('jwk', par.privateKey)

  const jwt = await webpush.firmarVapid(
    'https://fcm.googleapis.com/fcm/send/abc123',
    webpush.bytesToB64url(publica),
    jwk.d,
    'mailto:corsa@ejemplo.com',
  )

  const [cabecera, cuerpo, firma] = jwt.split('.')
  const dec = b => JSON.parse(new TextDecoder().decode(webpush.b64urlToBytes(b)))

  assert.deepEqual(dec(cabecera), { typ: 'JWT', alg: 'ES256' })
  // `aud` es el ORIGEN, no el endpoint: un token para Google no sirve en Apple.
  assert.equal(dec(cuerpo).aud, 'https://fcm.googleapis.com')
  assert.equal(dec(cuerpo).sub, 'mailto:corsa@ejemplo.com')
  assert.ok(dec(cuerpo).exp > Math.floor(Date.now() / 1000))
  assert.ok(dec(cuerpo).exp <= Math.floor(Date.now() / 1000) + 24 * 3600)

  const valida = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, par.publicKey,
    webpush.b64urlToBytes(firma),
    new TextEncoder().encode(`${cabecera}.${cuerpo}`),
  )
  assert.ok(valida, 'la firma no verifica contra la clave pública')
})
