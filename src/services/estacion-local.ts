/**
 * CORSA Carwash — sonda del CORSA Gateway local (sin dependencias).
 *
 * Separado del servicio para poder probarlo con node --test. Ver
 * estacion-fiscal.service.ts para el porqué de cada decisión de seguridad.
 */

export const GATEWAY_STATION_URL = 'http://127.0.0.1:5055/station'
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

/** Compara versiones x.y.z. Positivo si `a` es más nueva. */
export function compararVersion(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}
