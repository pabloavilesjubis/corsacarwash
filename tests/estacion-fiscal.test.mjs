/**
 * CORSA — sonda de la estación fiscal (src/services/estacion-local.ts).
 *
 * Lo que importa: que la app sólo hable con la URL fija de loopback, sin
 * credenciales, y que cualquier cosa que no sea el CORSA Gateway se trate
 * como «no detectado» en vez de mostrarse como estación lista.
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

const raiz = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const fuente = readFileSync(join(raiz, 'src/services/estacion-local.ts'), 'utf8')
const js = ts.transpileModule(fuente, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const destino = join(mkdtempSync(join(tmpdir(), 'corsa-estacion-')), 'estacion.mjs')
writeFileSync(destino, js)
const m = await import(destino)

const LISTA = {
  product: 'corsa-gateway', version: '1.2.0', gateway: 'available', firmador: 'available',
  certificate: { status: 'detected', nit: '06231909241018', fingerprint: 'cf8209e11c00a34c' },
  fiscalSigning: 'available', fiscalSigningMissing: null, allowProduction: false, ready: true,
}

function fetcherQueResponde(body, status = 200) {
  const llamadas = []
  const f = async (url, init) => {
    llamadas.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { f, llamadas }
}

test('la URL es loopback fija, puerto 5055', () => {
  assert.equal(m.GATEWAY_STATION_URL, 'http://127.0.0.1:5055/station')
})

test('estación lista: se detecta y se conserva el estado', async () => {
  const { f, llamadas } = fetcherQueResponde(LISTA)
  const r = await m.probarEstacion(f)
  assert.equal(r.detectado, true)
  assert.equal(r.estado.version, '1.2.0')
  assert.equal(r.estado.certificate.fingerprint, 'cf8209e11c00a34c')
  assert.equal(r.estado.ready, true)
  assert.equal(llamadas[0].url, m.GATEWAY_STATION_URL)
  assert.equal(llamadas[0].init.credentials, 'omit')
  assert.equal(llamadas[0].init.method, 'GET')
})

test('sin gateway (fetch falla): no detectado', async () => {
  const r = await m.probarEstacion(async () => { throw new TypeError('Failed to fetch') })
  assert.deepEqual(r, { detectado: false, motivo: 'sin_respuesta' })
})

test('algo que no es el CORSA Gateway en el 5055: no detectado', async () => {
  const { f } = fetcherQueResponde({ status: 'ok' })
  assert.deepEqual(await m.probarEstacion(f), { detectado: false, motivo: 'respuesta_invalida' })
  const { f: f2 } = fetcherQueResponde(LISTA, 500)
  assert.equal((await m.probarEstacion(f2)).detectado, false)
})

test('valores inesperados no se muestran como buenos', () => {
  const e = m.interpretarEstacion({
    ...LISTA, firmador: 'quizas', fiscalSigning: 'si', ready: 'true',
    certificate: { status: 'detected', nit: 5, fingerprint: '<script>' },
  })
  assert.equal(e.firmador, 'unavailable')
  assert.equal(e.fiscalSigning, 'not_configured')
  assert.equal(e.ready, false)
  assert.equal(e.certificate.fingerprint, null)
  assert.equal(e.certificate.nit, null)
})

test('firma configurada pero la prueba falló: se distingue de «no configurada»', () => {
  const e = m.interpretarEstacion({
    ...LISTA, fiscalSigning: 'failed', ready: false,
    fiscalSigningError: 'La contraseña configurada no corresponde al certificado del NIT (803)',
  })
  assert.equal(e.fiscalSigning, 'failed')
  assert.match(e.fiscalSigningError, /803/)
  assert.equal(e.ready, false)
})

test('compararVersion', () => {
  assert.ok(m.compararVersion('1.2.0', '1.1.9') > 0)
  assert.ok(m.compararVersion('1.2.0', '1.10.0') < 0)
  assert.equal(m.compararVersion('1.2.0', '1.2.0'), 0)
})
