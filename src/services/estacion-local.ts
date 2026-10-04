/**
 * CORSA Carwash — sonda del CORSA Gateway local (sin dependencias).
 *
 * Separado del servicio para poder probarlo con node --test. Ver
 * estacion-fiscal.service.ts para el porqué de cada decisión de seguridad.
 */

export const GATEWAY_STATION_URL = 'http://127.0.0.1:5055/station'
export const GATEWAY_HACIENDA_URL = 'http://127.0.0.1:5055/station/hacienda'
export const GATEWAY_SIGN_URL = 'http://127.0.0.1:5055/station/sign'
const TIMEOUT_MS = 4000

export interface StationResponse {
  product: string
  version: string
  gateway: 'available'
  firmador: 'available' | 'unavailable'
  certificate: {
    status: 'detected' | 'not_found' | 'not_configured' | 'unreadable' | 'nit_mismatch'
    nit: string | null
    fingerprint: string | null
  }
  /** `failed`: la firma está configurada pero la firma de prueba aislada no salió. */
  fiscalSigning: 'available' | 'failed' | 'incomplete' | 'not_configured'
  fiscalSigningMissing: string | null
  fiscalSigningError: string | null
  allowProduction: boolean
  ready: boolean
}

export type ResultadoEstacion =
  | { detectado: true; estado: StationResponse }
  | { detectado: false; motivo: 'sin_respuesta' | 'respuesta_invalida' }

/** Valida la forma: lo que no se parece a /station se trata como «no detectado». */
export function interpretarEstacion(body: unknown): StationResponse | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const cert = b.certificate as Record<string, unknown> | undefined
  if (b.product !== 'corsa-gateway' || typeof b.version !== 'string' || !cert || typeof cert.status !== 'string') {
    return null
  }
  return {
    product: b.product,
    version: b.version,
    gateway: 'available',
    firmador: b.firmador === 'available' ? 'available' : 'unavailable',
    certificate: {
      status: cert.status as StationResponse['certificate']['status'],
      nit: typeof cert.nit === 'string' ? cert.nit : null,
      fingerprint: typeof cert.fingerprint === 'string' && /^[0-9a-f]{16}$/.test(cert.fingerprint) ? cert.fingerprint : null,
    },
    fiscalSigning: b.fiscalSigning === 'available' ? 'available'
      : b.fiscalSigning === 'failed' ? 'failed'
      : b.fiscalSigning === 'incomplete' ? 'incomplete' : 'not_configured',
    fiscalSigningMissing: typeof b.fiscalSigningMissing === 'string' ? b.fiscalSigningMissing : null,
    fiscalSigningError: typeof b.fiscalSigningError === 'string' ? b.fiscalSigningError : null,
    allowProduction: b.allowProduction === true,
    ready: b.ready === true,
  }
}

export async function probarEstacion(fetcher: typeof fetch = fetch): Promise<ResultadoEstacion> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const init: RequestInit & { targetAddressSpace?: string } = {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: ctrl.signal,
      // Pista para la política de red local de Chrome; los demás navegadores la ignoran.
      targetAddressSpace: 'loopback',
    }
    const resp = await fetcher(GATEWAY_STATION_URL, init)
    if (!resp.ok) return { detectado: false, motivo: 'respuesta_invalida' }
    const estado = interpretarEstacion(await resp.json())
    return estado ? { detectado: true, estado } : { detectado: false, motivo: 'respuesta_invalida' }
  } catch {
    return { detectado: false, motivo: 'sin_respuesta' }
  } finally {
    clearTimeout(timer)
  }
}

// ── Probar conexión con Hacienda ──
//
// La prueba la hace el Gateway de esta PC, no el navegador: el Gateway hace un
// login a /seguridad/auth de Hacienda y descarta el token. Nunca transmite
// documentos (su HttpClient sólo deja salir el login y el /health del Worker).

export type EstadoPaso = 'ok' | 'failed' | 'warning' | 'skipped'

export interface PasoHacienda {
  id: string
  label: string
  status: EstadoPaso
  detail: string | null
}

export interface ResultadoHacienda {
  ok: boolean
  ambiente: string
  failedStep: string | null
  steps: PasoHacienda[]
  documentsTransmitted: number
  cached: boolean
}

const ESTADOS: EstadoPaso[] = ['ok', 'failed', 'warning', 'skipped']

export function interpretarHacienda(body: unknown): ResultadoHacienda | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.product !== 'corsa-gateway' || !Array.isArray(b.steps) || typeof b.ambiente !== 'string') return null
  const steps: PasoHacienda[] = b.steps.flatMap(x => {
    if (!x || typeof x !== 'object') return []
    const p = x as Record<string, unknown>
    if (typeof p.id !== 'string' || typeof p.label !== 'string') return []
    return [{
      id: p.id,
      label: p.label,
      status: ESTADOS.includes(p.status as EstadoPaso) ? p.status as EstadoPaso : 'failed',
      detail: typeof p.detail === 'string' ? p.detail : null,
    }]
  })
  const failed = typeof b.failedStep === 'string' ? b.failedStep : null
  return {
    // Éxito sólo si el Gateway lo dice Y ningún paso falló.
    ok: b.ok === true && failed === null && steps.length > 0 && steps.every(p => p.status !== 'failed'),
    ambiente: b.ambiente,
    failedStep: failed,
    steps,
    documentsTransmitted: typeof b.documentsTransmitted === 'number' ? b.documentsTransmitted : -1,
    cached: b.cached === true,
  }
}

export async function probarHacienda(fetcher: typeof fetch = fetch): Promise<ResultadoHacienda | null> {
  const ctrl = new AbortController()
  // El Gateway espera hasta 15 s a Hacienda y 15 s al Worker.
  const timer = setTimeout(() => ctrl.abort(), 45_000)
  try {
    const init: RequestInit & { targetAddressSpace?: string } = {
      method: 'POST', cache: 'no-store', credentials: 'omit', signal: ctrl.signal, targetAddressSpace: 'loopback',
    }
    const resp = await fetcher(GATEWAY_HACIENDA_URL, init)
    if (!resp.ok) return null
    return interpretarHacienda(await resp.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── Firma de un DTE en la estación fiscal ──
//
// El DTE lo arma el Worker fiscal; la estación de ESTA PC lo firma con el
// firmador oficial de Hacienda y devuelve el JWS. El Gateway revisa que sea del
// emisor de la estación y que la producción esté habilitada.

export class ErrorDeEstacion extends Error {
  readonly codigo: string
  constructor(mensaje: string, codigo: string) {
    super(mensaje)
    this.name = 'ErrorDeEstacion'
    this.codigo = codigo
  }
}

const MENSAJES_FIRMA: Record<string, string> = {
  production_blocked: 'La estación fiscal no tiene habilitada la firma de producción («Habilitar firma de produccion.bat»).',
  issuer_mismatch: 'El documento no es del emisor configurado en la estación fiscal.',
  codigo_generacion_conflict: 'Ese código de generación ya se firmó con otro contenido.',
  signature_rejected: 'El firmador de Hacienda rechazó el documento.',
  signature_invalid: 'La firma devuelta no corresponde al documento.',
  fiscal_station_unavailable: 'Estación fiscal no disponible.',
  forbidden: 'La estación fiscal no acepta pedidos de este sitio.',
}

export async function firmarEnEstacion(dte: unknown, fetcher: typeof fetch = fetch): Promise<string> {
  const init: RequestInit & { targetAddressSpace?: string } = {
    method: 'POST', cache: 'no-store', credentials: 'omit', targetAddressSpace: 'loopback',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dteJson: dte }),
    signal: AbortSignal.timeout(30_000),
  }
  let resp: Response
  try {
    resp = await fetcher(GATEWAY_SIGN_URL, init)
  } catch {
    throw new ErrorDeEstacion('Estación fiscal no disponible: el Gateway de esta PC no respondió.', 'SIN_ESTACION')
  }
  const body = await resp.json().catch(() => ({})) as Record<string, unknown>
  const jws = typeof body.jws === 'string' ? body.jws : null
  if (resp.ok && body.status === 'signed' && jws && jws.split('.').length === 3) return jws
  const status = typeof body.status === 'string' ? body.status : `HTTP ${resp.status}`
  const detalle = typeof body.error === 'string' ? body.error : null
  throw new ErrorDeEstacion(
    [MENSAJES_FIRMA[status] ?? `La estación fiscal no firmó (${status}).`, detalle].filter(Boolean).join(' '),
    status)
}

/** Compara versiones x.y.z. Positivo si `a` es más nueva. */
export function compararVersion(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}
