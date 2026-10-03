/**
 * CORSA Carwash — Estación fiscal
 *
 * La estación fiscal es la PC donde corre el firmador de Hacienda. El CORSA
 * Gateway instalado en esa PC informa su estado en http://127.0.0.1:5055/station.
 *
 * CÓMO LLEGA CHROME (HTTPS) AL GATEWAY (HTTP LOCAL)
 *   · 127.0.0.1 es un origen «potencialmente confiable»: pedirlo desde una
 *     página HTTPS no es contenido mixto.
 *   · Chrome pide permiso de «red local» la primera vez; el usuario acepta.
 *   · El gateway escucha sólo en 127.0.0.1: no se abre a la LAN ni a Internet.
 *   · El gateway sólo le da CORS a los orígenes de la app, y rechaza cualquier
 *     Host que no sea loopback (DNS rebinding).
 *   · /station no lleva credenciales ni devuelve secretos.
 *
 * La URL es una constante. No se arma con nada que venga de la base, de la URL
 * de la página ni del usuario.
 *
 * DESCARGA
 * El instalador sale del bucket privado `software` (registro vigente de
 * `software_releases`, producto `plc-gateway`) con una URL firmada de 5 minutos,
 * igual que en la pantalla Software. Nunca de una URL externa.
 */

import { supabase } from '../lib/supabase'
import { downloadRelease, type SoftwareRelease } from './software.service'

export {
  GATEWAY_STATION_URL, probarEstacion, interpretarEstacion, compararVersion,
  type StationResponse, type ResultadoEstacion,
} from './estacion-local'

export const GATEWAY_PRODUCT = 'plc-gateway'

/** Versión vigente del Gateway publicada en `software_releases`. */
export async function gatewayVigente(): Promise<SoftwareRelease | null> {
  const { data, error } = await (supabase as any)
    .from('software_releases')
    .select('*')
    .eq('product', GATEWAY_PRODUCT)
    .eq('is_current', true)
    .order('published_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return ((data ?? [])[0] as SoftwareRelease | undefined) ?? null
}

export function descargarGateway(release: SoftwareRelease): Promise<void> {
  if (release.product !== GATEWAY_PRODUCT) return Promise.reject(new Error('El registro no es el CORSA Gateway'))
  return downloadRelease(release)
}
