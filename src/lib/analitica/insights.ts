/**
 * CORSA — Oportunidades: reglas sobre los agregados, sin IA.
 *
 * Una regla sólo produce un mensaje si la variación es relevante Y la base
 * alcanza: un «+40%» sobre 5 lavados no es una oportunidad, es ruido. Los
 * umbrales están juntos acá para poder ajustarlos sin buscar en la pantalla.
 *
 *   Crecimiento (lavados, ventas)   |Δ| ≥ 5%   con ≥ 50 lavados en el anterior
 *   Ventas vs lavados divergen      diferencia ≥ 5 puntos entre ambas Δ
 *   Ticket promedio                 |Δ| ≥ 5%   con ≥ 30 órdenes en el anterior
 *   Mix premium                     |Δ| ≥ 3 pp con ≥ 50 lavados en cada período
 *   Concentración de demanda        una franja de 3 h de un día con ≥ 15% de
 *                                   los lavados del período (≥ 100 lavados)
 *   Máquinas: productividad         ≥ 10% de diferencia en lavados por hora de
 *                                   jornada, con ≥ 50 lavados cada una
 *   Máquinas: fallas                una con ≥ 3 fallas y el doble que la otra
 *   Cuadre caja vs máquinas         |diferencia| ≥ 3% del total y ≥ 3 lavados
 *   Proyección                      mes en curso con ≥ 7 días operativos completos
 *   Clientes sin identificar        < 50% de lavados con cliente (≥ 50 lavados)
 */
import type {
  CeldaDemanda, ClientesPeriodo, FilaCuadre, MaquinasPeriodo, MetricasPeriodo, Proyeccion,
} from '../../services/analitica.service'
import { nombreMaquina } from '../../services/plc.service'
import { premiumDe } from './mix'
import { dinero, dividir, entero, porcentaje } from './variacion'

export type TonoInsight = 'positivo' | 'alerta' | 'info'

export interface Insight {
  id: string
  categoria: 'Crecimiento' | 'Ticket' | 'Mix de servicios' | 'Demanda' | 'Máquinas' | 'Cuadre' | 'Proyección' | 'Clientes'
  tono: TonoInsight
  texto: string
  /** Para ordenar: cuanto más alto, más arriba. */
  peso: number
}

export const UMBRALES = {
  crecimiento: 0.05, baseLavados: 50, divergencia: 0.05, ticket: 0.05, baseOrdenes: 30,
  mixPuntos: 3, demandaFranja: 0.15, baseDemanda: 100, maquinas: 0.10, fallasMin: 3,
  cuadre: 0.03, cuadreMin: 3, diasProyeccion: 7, identificados: 0.5,
}

const DIAS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados']
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

export function hora12(h: number): string {
  const hh = ((h + 11) % 12) + 1
  return `${hh}:00 ${h < 12 || h === 24 ? 'a. m.' : 'p. m.'}`
}

const fmtPct = (r: number) => `${(Math.abs(r) * 100).toFixed(1)}%`

/** La franja de 3 horas de un mismo día de la semana con más lavados. */
export function franjaPico(celdas: CeldaDemanda[]): { dia: number; desde: number; lavados: number; total: number } | null {
  const total = celdas.reduce((n, c) => n + c.lavados, 0)
  if (total === 0) return null
  let mejor: { dia: number; desde: number; lavados: number } | null = null
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h <= 21; h++) {
      const n = celdas.filter(c => c.dia_semana === d && c.hora >= h && c.hora < h + 3).reduce((s, c) => s + c.lavados, 0)
      if (!mejor || n > mejor.lavados) mejor = { dia: d, desde: h, lavados: n }
    }
  }
  return mejor ? { ...mejor, total } : null
}

export interface ContextoInsights {
  actual?: MetricasPeriodo | null
  anterior?: MetricasPeriodo | null
  /** Hay base para comparar contra el período anterior. */
  comparable: boolean
  maquinas?: MaquinasPeriodo | null
  demanda?: CeldaDemanda[] | null
  cuadre?: FilaCuadre[] | null
  primeraVenta?: string | null
  proyeccion?: Proyeccion | null
  esMesEnCurso: boolean
  clientes?: ClientesPeriodo | null
}

export function generarInsights(c: ContextoInsights): Insight[] {
  const out: Insight[] = []
  const a = c.actual, b = c.anterior
  const U = UMBRALES

  // ── Crecimiento y divergencia ventas / lavados ──
  if (a && b && c.comparable && b.lavados >= U.baseLavados) {
    const dl = (a.lavados - b.lavados) / b.lavados
    const dv = b.ventas > 0 ? (a.ventas - b.ventas) / b.ventas : null
    if (dv != null && Math.abs(dl - dv) >= U.divergencia && (Math.abs(dl) >= U.crecimiento || Math.abs(dv) >= U.crecimiento)) {
      const ingreso = (dv - dl) / (1 + dl)
      out.push({
        id: 'divergencia', categoria: 'Crecimiento', tono: dv < dl ? 'alerta' : 'positivo', peso: 90,
        texto: `Lavados ${dl >= 0 ? '+' : '−'}${fmtPct(dl)}, pero ventas ${dv >= 0 ? '+' : '−'}${fmtPct(dv)}: el ingreso por lavado ${ingreso < 0 ? 'bajó' : 'subió'} ${fmtPct(ingreso)}.`,
      })
    } else if (Math.abs(dl) >= U.crecimiento) {
      out.push({
        id: 'lavados', categoria: 'Crecimiento', tono: dl > 0 ? 'positivo' : 'alerta', peso: 80,
        texto: `Los lavados ${dl > 0 ? 'aumentaron' : 'cayeron'} ${fmtPct(dl)} frente al período anterior (${entero(b.lavados)} → ${entero(a.lavados)}).`,
      })
    }
  }

  // ── Ticket promedio ──
  if (a && b && c.comparable && b.ordenes_servicio >= U.baseOrdenes && a.ordenes_servicio > 0) {
    const ta = a.ventas_servicio / a.ordenes_servicio, tb = b.ventas_servicio / b.ordenes_servicio
    const dt = tb > 0 ? (ta - tb) / tb : 0
    if (Math.abs(dt) >= U.ticket) {
      const masVehiculos = a.lavados > b.lavados
      out.push({
        id: 'ticket', categoria: 'Ticket', tono: dt < 0 ? 'alerta' : 'positivo', peso: 70,
        texto: dt < 0 && masVehiculos
          ? `El ticket promedio cayó ${fmtPct(dt)} (${dinero(tb)} → ${dinero(ta)}) a pesar de que aumentó el número de vehículos.`
          : `El ticket promedio ${dt > 0 ? 'subió' : 'bajó'} ${fmtPct(dt)}: de ${dinero(tb)} a ${dinero(ta)}.`,
      })
    }
  }

  // ── Mix premium ──
  if (a && b && c.comparable && a.lavados >= U.baseLavados && b.lavados >= U.baseLavados) {
    const pa = premiumDe(a), pb = premiumDe(b)
    if (pa != null && pb != null && Math.abs(pa - pb) * 100 >= U.mixPuntos) {
      out.push({
        id: 'mix', categoria: 'Mix de servicios', tono: pa < pb ? 'alerta' : 'positivo', peso: 75,
        texto: `ÉLITE + SIGNATURE ${pa < pb ? 'bajaron' : 'subieron'} de ${porcentaje(pb, 0)} a ${porcentaje(pa, 0)} del total respecto al período anterior.`,
      })
    }
  }

  // ── Demanda ──
  if (c.demanda) {
    const f = franjaPico(c.demanda)
    if (f && f.total >= U.baseDemanda && f.lavados / f.total >= U.demandaFranja) {
      out.push({
        id: 'demanda', categoria: 'Demanda', tono: 'info', peso: 60,
        texto: `Los ${DIAS[f.dia]} entre ${hora12(f.desde)} y ${hora12(f.desde + 3)} concentran el ${porcentaje(f.lavados / f.total, 0)} de los lavados del período.`,
      })
    }
  }

  // ── Máquinas ──
  const ms = (c.maquinas?.maquinas ?? []).filter(m => m.lavados >= U.baseLavados && m.segundos_jornada > 0)
  if (ms.length === 2) {
    const [x, y] = ms.map(m => ({ m, ph: m.lavados / (m.segundos_jornada / 3600) })).sort((p, q) => q.ph - p.ph)
    const dif = (x.ph - y.ph) / x.ph
    if (dif >= U.maquinas) {
      out.push({
        id: 'maquinas-productividad', categoria: 'Máquinas', tono: 'alerta', peso: 65,
        texto: `${nombreMaquina(y.m.machine_id, y.m.nombre)} realizó ${fmtPct(dif)} menos lavados por hora de jornada que ${nombreMaquina(x.m.machine_id, x.m.nombre)} (${y.ph.toFixed(2)} contra ${x.ph.toFixed(2)}).`,
      })
    }
  }
  const todas = c.maquinas?.maquinas ?? []
  if (todas.length === 2) {
    const [p, q] = [...todas].sort((m, n) => n.fallas - m.fallas)
    if (p.fallas >= U.fallasMin && p.fallas >= 2 * q.fallas) {
      out.push({
        id: 'maquinas-fallas', categoria: 'Máquinas', tono: 'alerta', peso: 68,
        texto: `${nombreMaquina(p.machine_id, p.nombre)} registró ${entero(p.fallas)} fallas en el período, contra ${entero(q.fallas)} de ${nombreMaquina(q.machine_id, q.nombre)}.`,
      })
    }
  }

  // ── Cuadre caja vs máquinas ──
  if (c.cuadre && c.primeraVenta) {
    const v = c.cuadre.filter(f => f.fecha >= c.primeraVenta!)
    const caja = v.reduce((n, f) => n + f.caja, 0), maq = v.reduce((n, f) => n + f.maquinas, 0)
    const d = maq - caja
    if (caja > 0 && Math.abs(d) >= U.cuadreMin && Math.abs(d) / Math.max(caja, maq) >= U.cuadre) {
      out.push({
        id: 'cuadre', categoria: 'Cuadre', tono: 'alerta', peso: 85,
        texto: d > 0
          ? `Las máquinas registraron ${entero(d)} lavados más de los cobrados en caja (${entero(maq)} contra ${entero(caja)}).`
          : `Caja cobró ${entero(-d)} lavados más de los que registraron las máquinas (${entero(caja)} contra ${entero(maq)}).`,
      })
    }
  }

  // ── Proyección ──
  const p = c.proyeccion
  if (c.esMesEnCurso && p && p.dias_completos >= U.diasProyeccion && p.proyeccion_ventas != null && p.proyeccion_lavados != null) {
    const mes = MESES[Number(p.mes.slice(5, 7)) - 1]
    const meta = p.meta_ventas ? ` (${porcentaje(dividir(p.proyeccion_ventas, p.meta_ventas), 0)} de la meta)` : ''
    out.push({
      id: 'proyeccion', categoria: 'Proyección', tono: p.meta_ventas && p.proyeccion_ventas < p.meta_ventas ? 'alerta' : 'info', peso: 55,
      texto: `Al ritmo actual, ${mes} cerraría aproximadamente con ${entero(p.proyeccion_lavados)} lavados y ${dinero(p.proyeccion_ventas, 0)} de facturación${meta}.`,
    })
  }

  // ── Clientes ──
  const cl = c.clientes
  if (cl && cl.lavados >= U.baseLavados) {
    const ident = cl.lavados_identificados / cl.lavados
    if (ident < U.identificados) {
      out.push({
        id: 'clientes-identificados', categoria: 'Clientes', tono: 'info', peso: 40,
        texto: `Sólo el ${porcentaje(ident, 0)} de los lavados tiene un cliente identificado: pedir el nombre o la placa en caja permitiría medir recurrencia y retención.`,
      })
    }
  }

  return out.sort((x, y) => y.peso - x.peso)
}
