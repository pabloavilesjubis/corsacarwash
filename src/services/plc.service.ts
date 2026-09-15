/**
 * CORSA Carwash — lectura de las máquinas (PLC)
 *
 * Las consultas viven acá y no dentro de una pantalla porque el tablero de
 * escritorio y el de teléfono muestran los mismos números: si cada uno los
 * pidiera a su manera, el día que cambie una vista quedarían diciendo cosas
 * distintas sobre lo mismo.
 *
 * Ningún error se propaga hacia arriba. Una tarjeta de máquina que no carga no
 * puede llevarse puesto el resumen del día: devuelve vacío y la pantalla
 * muestra su estado sin datos.
 */
import { supabase } from '../lib/supabase'
import { hoyLocal } from '../utils/fecha'

export interface MaquinaPlc {
  machine_id: string
  name: string
  status: string | null
  washes_today: number
  pro_today: number
  elite_today: number
  signature_today: number
  unknown_today: number
  avg_seconds_today: number | null
  interrupted_today: number
  washes_in_progress: number
  reporting: boolean
  current_service: string | null
}

export interface ServicioDelDia {
  tipo: string
  washes: number
  avg_seconds: number
}

export async function fetchMaquinas(): Promise<MaquinaPlc[]> {
  const { data, error } = await (supabase as any)
    .from('v_plc_machines')
    .select('machine_id, name, status, washes_today, pro_today, elite_today, signature_today, ' +
            'unknown_today, avg_seconds_today, interrupted_today, washes_in_progress, ' +
            'reporting, current_service, active')
    .eq('active', true)
    .order('machine_id')

  if (error) return []
  return (data ?? []) as MaquinaPlc[]
}

/** Lavados por servicio de hoy, sumando las máquinas. */
export async function fetchServiciosHoy(): Promise<ServicioDelDia[]> {
  const { data, error } = await (supabase as any)
    .from('v_plc_servicios_diarios')
    .select('service_type, washes, avg_seconds')
    .eq('day', hoyLocal())

  if (error) return []

  const acum = new Map<string, { washes: number; segundos: number }>()
  for (const s of (data ?? []) as any[]) {
    const prev = acum.get(s.service_type) ?? { washes: 0, segundos: 0 }
    prev.washes += Number(s.washes ?? 0)
    // Promedio ponderado: cada máquina pesa por los lavados que hizo.
    prev.segundos += Number(s.avg_seconds ?? 0) * Number(s.washes ?? 0)
    acum.set(s.service_type, prev)
  }

  return [...acum.entries()].map(([tipo, v]) => ({
    tipo,
    washes: v.washes,
    avg_seconds: v.washes > 0 ? Math.round(v.segundos / v.washes) : 0,
  }))
}

/** Totales de caja del día, ya separados por naturaleza en v_daily_totals (0032). */
export async function fetchTotalesDelDia(branchId: string) {
  const { data } = await (supabase as any)
    .from('v_daily_totals')
    .select('*')
    .eq('branch_id', branchId)
    .eq('sale_date', hoyLocal())
    .maybeSingle()

  return {
    ingresos: Number(data?.gross_revenue ?? 0),
    servicios: Number(data?.services_delivered ?? 0),
    ticket: Number(data?.avg_ticket ?? 0),
  }
}

/** 341 s se lee peor que 5:41 cuando lo que importa es comparar ciclos. */
export function duracionCorta(segundos: number | null | undefined): string {
  if (!segundos) return '—'
  return `${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, '0')}`
}
