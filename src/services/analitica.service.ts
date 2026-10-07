/**
 * CORSA — Inteligencia de negocio: lectura de los agregados (0075).
 *
 * Todo se calcula en la base (bi_resumen, bi_serie, bi_proyeccion) y llega
 * agregado: la pantalla no recorre órdenes ni eventos de PLC.
 */
import { supabase } from '../lib/supabase'
import type { Granularidad, Rango } from '../lib/analitica/periodos'

const db = () => supabase as any

export type CodigoLavado = 'PRO' | 'ELITE' | 'SIGNATURE'

export interface MetricasPeriodo {
  ventas: number
  ventas_facturadas: number
  ventas_servicio: number
  ordenes_servicio: number
  lavados: number
  lavados_sin_cobro: number
  mix: Partial<Record<CodigoLavado, { lavados: number; ingresos: number; sin_cobro: number }>>
  dias_con_venta: number
}

export interface Resumen {
  actual: MetricasPeriodo
  anterior: MetricasPeriodo
  /** Primer día con ventas en el sistema (null si nunca hubo). */
  primera_venta: string | null
}

export interface PuntoSerie {
  bucket: string
  ventas: number
  lavados: number
  ordenes_servicio: number
  lavados_pro: number
  lavados_elite: number
  lavados_signature: number
}

export interface Proyeccion {
  mes: string
  hoy: string
  fin_de_mes: string
  ventas_acumuladas: number
  lavados_acumulados: number
  dias_completos: number
  promedio_desde: string | null
  dias_restantes: number
  ventas_por_dia: number | null
  lavados_por_dia: number | null
  proyeccion_ventas: number | null
  proyeccion_lavados: number | null
  meta_ventas: number | null
  meta_lavados: number | null
  calendario_configurado: boolean
}

const num = (v: unknown) => (v == null ? 0 : Number(v))

function normalizarMetricas(m: any): MetricasPeriodo {
  const mix: MetricasPeriodo['mix'] = {}
  for (const [k, v] of Object.entries((m?.mix ?? {}) as Record<string, any>)) {
    mix[k as CodigoLavado] = { lavados: num(v.lavados), ingresos: num(v.ingresos), sin_cobro: num(v.sin_cobro) }
  }
  return {
    ventas: num(m?.ventas), ventas_facturadas: num(m?.ventas_facturadas), ventas_servicio: num(m?.ventas_servicio),
    ordenes_servicio: num(m?.ordenes_servicio), lavados: num(m?.lavados), lavados_sin_cobro: num(m?.lavados_sin_cobro),
    mix, dias_con_venta: num(m?.dias_con_venta),
  }
}

export async function fetchResumen(actual: Rango, anterior: Rango): Promise<Resumen> {
  const { data, error } = await db().rpc('bi_resumen', {
    p_desde: actual.desde, p_hasta: actual.hasta, p_ant_desde: anterior.desde, p_ant_hasta: anterior.hasta,
  })
  if (error) throw error
  return { actual: normalizarMetricas(data?.actual), anterior: normalizarMetricas(data?.anterior), primera_venta: data?.primera_venta ?? null }
}

export async function fetchSerie(r: Rango, g: Granularidad): Promise<PuntoSerie[]> {
  const { data, error } = await db().rpc('bi_serie', { p_desde: r.desde, p_hasta: r.hasta, p_granularidad: g })
  if (error) throw error
  return ((data ?? []) as any[]).map(p => ({
    bucket: String(p.bucket), ventas: num(p.ventas), lavados: num(p.lavados), ordenes_servicio: num(p.ordenes_servicio),
    lavados_pro: num(p.lavados_pro), lavados_elite: num(p.lavados_elite), lavados_signature: num(p.lavados_signature),
  }))
}

export async function fetchProyeccion(): Promise<Proyeccion> {
  const { data, error } = await db().rpc('bi_proyeccion', {})
  if (error) throw error
  const n = (v: unknown) => (v == null ? null : Number(v))
  return {
    mes: data.mes, hoy: data.hoy, fin_de_mes: data.fin_de_mes,
    ventas_acumuladas: num(data.ventas_acumuladas), lavados_acumulados: num(data.lavados_acumulados),
    dias_completos: num(data.dias_completos), promedio_desde: data.promedio_desde ?? null, dias_restantes: num(data.dias_restantes),
    ventas_por_dia: n(data.ventas_por_dia), lavados_por_dia: n(data.lavados_por_dia),
    proyeccion_ventas: n(data.proyeccion_ventas), proyeccion_lavados: n(data.proyeccion_lavados),
    meta_ventas: n(data.meta_ventas), meta_lavados: n(data.meta_lavados),
    calendario_configurado: Boolean(data.calendario_configurado),
  }
}

// ─── Configuración: meta del mes y días operativos ───────────

export async function guardarMeta(organizationId: string, mes: string, metaVentas: number | null, metaLavados: number | null): Promise<void> {
  // El índice único es sobre una expresión (coalesce de la sucursal): upsert
  // no puede apuntarle, así que se busca y se actualiza o se inserta.
  const { data: existente, error: e1 } = await db().from('business_goals')
    .select('id').eq('organization_id', organizationId).is('branch_id', null).eq('month', mes).maybeSingle()
  if (e1) throw e1
  const fila = { sales_goal: metaVentas, washes_goal: metaLavados, updated_at: new Date().toISOString() }
  const { error } = existente
    ? await db().from('business_goals').update(fila).eq('id', existente.id)
    : await db().from('business_goals').insert({ ...fila, organization_id: organizationId, branch_id: null, month: mes })
  if (error) throw error
}

/** Los días que abre (0 domingo … 6 sábado), o null si no se configuró. */
export async function fetchCalendario(): Promise<number[] | null> {
  const { data, error } = await db().from('business_calendar').select('weekday, is_open').is('branch_id', null)
  if (error) throw error
  if (!data || data.length === 0) return null
  return (data as any[]).filter(r => r.is_open).map(r => Number(r.weekday)).sort()
}

export async function guardarCalendario(organizationId: string, abiertos: number[]): Promise<void> {
  const { error: e1 } = await db().from('business_calendar').delete().eq('organization_id', organizationId).is('branch_id', null)
  if (e1) throw e1
  const filas = [0, 1, 2, 3, 4, 5, 6].map(d => ({ organization_id: organizationId, branch_id: null, weekday: d, is_open: abiertos.includes(d) }))
  const { error } = await db().from('business_calendar').insert(filas)
  if (error) throw error
}
