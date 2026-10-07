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

// ─── Etapa 2: máquinas, cuadre y clientes (0076) ─────────────

export interface MetricasMaquina {
  machine_id: string
  nombre: string | null
  lavados: number
  pro: number
  elite: number
  signature: number
  sin_clasificar: number
  ciclos_validos: number
  ciclos_fuera_de_rango: number
  segundos_lavando: number
  segundos_jornada: number
  dias_activos: number
  fallas: number
  segundos_en_falla: number
}

export interface MaquinasPeriodo {
  reglas: { min_valid_seconds: number; max_valid_seconds: number }
  maquinas: MetricasMaquina[]
  primer_ciclo: string | null
}

function normalizarMaquinas(d: any): MaquinasPeriodo {
  return {
    reglas: { min_valid_seconds: num(d?.reglas?.min_valid_seconds), max_valid_seconds: num(d?.reglas?.max_valid_seconds) },
    maquinas: ((d?.maquinas ?? []) as any[]).map(m => ({
      machine_id: String(m.machine_id), nombre: m.nombre ?? null,
      lavados: num(m.lavados), pro: num(m.pro), elite: num(m.elite), signature: num(m.signature), sin_clasificar: num(m.sin_clasificar),
      ciclos_validos: num(m.ciclos_validos), ciclos_fuera_de_rango: num(m.ciclos_fuera_de_rango),
      segundos_lavando: num(m.segundos_lavando), segundos_jornada: num(m.segundos_jornada), dias_activos: num(m.dias_activos),
      fallas: num(m.fallas), segundos_en_falla: num(m.segundos_en_falla),
    })),
    primer_ciclo: d?.primer_ciclo ?? null,
  }
}

export async function fetchMaquinasBi(actual: Rango, anterior: Rango): Promise<{ actual: MaquinasPeriodo; anterior: MaquinasPeriodo }> {
  const { data, error } = await db().rpc('bi_maquinas', {
    p_desde: actual.desde, p_hasta: actual.hasta, p_ant_desde: anterior.desde, p_ant_hasta: anterior.hasta,
  })
  if (error) throw error
  return { actual: normalizarMaquinas(data?.actual), anterior: normalizarMaquinas(data?.anterior) }
}

export interface FilaCuadre { fecha: string; servicio: string; caja: number; maquinas: number }

export async function fetchCuadre(r: Rango): Promise<FilaCuadre[]> {
  const { data, error } = await db().rpc('bi_cuadre', { p_desde: r.desde, p_hasta: r.hasta })
  if (error) throw error
  return ((data ?? []) as any[]).map(f => ({ fecha: String(f.fecha), servicio: String(f.servicio), caja: num(f.caja), maquinas: num(f.maquinas) }))
}

export interface ClientesPeriodo {
  lavados: number
  lavados_identificados: number
  clientes_activos: number
  clientes_nuevos: number
  clientes_recurrentes: number
  brechas: number
  dias_entre_lavados: number | null
  vehiculos_activos: number
  vehiculos_que_repiten: number
  ventas_identificadas: number
  retencion: Record<'30' | '60' | '90', { cohorte: number; retenidos: number } | undefined>
}

function normalizarClientes(d: any): ClientesPeriodo {
  const ret = (k: string) => d?.retencion?.[k] ? { cohorte: num(d.retencion[k].cohorte), retenidos: num(d.retencion[k].retenidos) } : undefined
  return {
    lavados: num(d?.lavados), lavados_identificados: num(d?.lavados_identificados),
    clientes_activos: num(d?.clientes_activos), clientes_nuevos: num(d?.clientes_nuevos), clientes_recurrentes: num(d?.clientes_recurrentes),
    brechas: num(d?.brechas), dias_entre_lavados: d?.dias_entre_lavados == null ? null : Number(d.dias_entre_lavados),
    vehiculos_activos: num(d?.vehiculos_activos), vehiculos_que_repiten: num(d?.vehiculos_que_repiten),
    ventas_identificadas: num(d?.ventas_identificadas),
    retencion: { '30': ret('30'), '60': ret('60'), '90': ret('90') },
  }
}

export async function fetchClientesBi(actual: Rango, anterior: Rango): Promise<{ actual: ClientesPeriodo; anterior: ClientesPeriodo }> {
  const { data, error } = await db().rpc('bi_clientes', {
    p_desde: actual.desde, p_hasta: actual.hasta, p_ant_desde: anterior.desde, p_ant_hasta: anterior.hasta,
  })
  if (error) throw error
  return { actual: normalizarClientes(data?.actual), anterior: normalizarClientes(data?.anterior) }
}
