/**
 * CORSA — períodos de Inteligencia de negocio.
 *
 * Cada preset sabe cuál es su período anterior equivalente:
 *   · 7 / 30 días y personalizado → los N días inmediatamente anteriores;
 *   · este mes (1 → hoy)          → los mismos días del mes anterior;
 *   · mes anterior                → el mes completo de antes;
 *   · este año (1 ene → hoy)      → el mismo tramo del año anterior.
 * Comparar «este mes hasta hoy» contra el mes anterior COMPLETO haría que
 * todo mes en curso pareciera una caída.
 *
 * Todas las fechas son YYYY-MM-DD del calendario de El Salvador.
 */

import { hoyLocal, sumarDias } from '../../utils/fecha'

export type Preset = '7d' | '30d' | 'mes' | 'mes_anterior' | 'anio' | 'custom'
export type Granularidad = 'day' | 'week' | 'month'

export interface Rango { desde: string; hasta: string }

export interface Periodo {
  preset: Preset
  actual: Rango
  anterior: Rango
  /** El período es el mes en curso: tiene sentido proyectar el cierre. */
  esMesEnCurso: boolean
}

export const PRESETS: { id: Preset; label: string }[] = [
  { id: '7d', label: '7 días' },
  { id: '30d', label: '30 días' },
  { id: 'mes', label: 'Este mes' },
  { id: 'mes_anterior', label: 'Mes anterior' },
  { id: 'anio', label: 'Este año' },
  { id: 'custom', label: 'Personalizado' },
]

const partes = (f: string) => f.split('-').map(Number) as [number, number, number]
const iso = (a: number, m: number, d: number) =>
  new Date(Date.UTC(a, m - 1, d)).toISOString().slice(0, 10)
const ultimoDia = (a: number, m: number) => new Date(Date.UTC(a, m, 0)).getUTCDate()

/** Días del rango, contando los dos extremos. */
export function diasDe(r: Rango): number {
  const [a1, m1, d1] = partes(r.desde)
  const [a2, m2, d2] = partes(r.hasta)
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000) + 1
}

/** Los N días inmediatamente anteriores, con N = largo del rango. */
function anteriorInmediato(r: Rango): Rango {
  const n = diasDe(r)
  return { desde: sumarDias(r.desde, -n), hasta: sumarDias(r.desde, -1) }
}

export function calcularPeriodo(preset: Preset, custom?: Rango, hoy: string = hoyLocal()): Periodo {
  const [a, m, d] = partes(hoy)
  switch (preset) {
    case '7d': {
      const actual = { desde: sumarDias(hoy, -6), hasta: hoy }
      return { preset, actual, anterior: anteriorInmediato(actual), esMesEnCurso: false }
    }
    case '30d': {
      const actual = { desde: sumarDias(hoy, -29), hasta: hoy }
      return { preset, actual, anterior: anteriorInmediato(actual), esMesEnCurso: false }
    }
    case 'mes': {
      const pa = m === 1 ? a - 1 : a, pm = m === 1 ? 12 : m - 1
      return {
        preset,
        actual: { desde: iso(a, m, 1), hasta: hoy },
        anterior: { desde: iso(pa, pm, 1), hasta: iso(pa, pm, Math.min(d, ultimoDia(pa, pm))) },
        esMesEnCurso: true,
      }
    }
    case 'mes_anterior': {
      const pa = m === 1 ? a - 1 : a, pm = m === 1 ? 12 : m - 1
      const aa = pm === 1 ? pa - 1 : pa, am = pm === 1 ? 12 : pm - 1
      return {
        preset,
        actual: { desde: iso(pa, pm, 1), hasta: iso(pa, pm, ultimoDia(pa, pm)) },
        anterior: { desde: iso(aa, am, 1), hasta: iso(aa, am, ultimoDia(aa, am)) },
        esMesEnCurso: false,
      }
    }
    case 'anio':
      return {
        preset,
        actual: { desde: iso(a, 1, 1), hasta: hoy },
        // 29 de febrero contra un año sin él: el 28.
        anterior: { desde: iso(a - 1, 1, 1), hasta: iso(a - 1, m, Math.min(d, ultimoDia(a - 1, m))) },
        esMesEnCurso: false,
      }
    case 'custom': {
      const r = custom && custom.desde <= custom.hasta ? custom : { desde: sumarDias(hoy, -6), hasta: hoy }
      const [ca, cm] = partes(r.desde)
      return {
        preset, actual: r, anterior: anteriorInmediato(r),
        esMesEnCurso: r.desde === iso(a, m, 1) && r.hasta === hoy && ca === a && cm === m,
      }
    }
  }
}

/** Las granularidades que tienen sentido para el largo del período. */
export function granularidadesPara(r: Rango): Granularidad[] {
  const n = diasDe(r)
  const g: Granularidad[] = []
  if (n <= 93) g.push('day')
  if (n >= 14) g.push('week')
  if (n >= 60) g.push('month')
  return g.length ? g : ['day']
}

export function granularidadPorDefecto(r: Rango): Granularidad {
  const n = diasDe(r)
  return n <= 31 ? 'day' : n <= 120 ? 'week' : 'month'
}

export const ETIQUETA_GRANULARIDAD: Record<Granularidad, string> = { day: 'Día', week: 'Semana', month: 'Mes' }

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** «7 oct», «3 – 9 oct», «sep 2026». */
export function etiquetaFecha(f: string, g: Granularidad = 'day'): string {
  const [a, m, d] = partes(f)
  if (g === 'month') return `${MESES[m - 1]} ${a}`
  if (g === 'week') return `sem. ${d} ${MESES[m - 1]}`
  return `${d} ${MESES[m - 1]}`
}

export function etiquetaRango(r: Rango): string {
  const [a1, m1, d1] = partes(r.desde)
  const [a2, m2, d2] = partes(r.hasta)
  if (r.desde === r.hasta) return `${d1} ${MESES[m1 - 1]} ${a1}`
  if (a1 === a2 && m1 === m2) return `${d1} – ${d2} ${MESES[m2 - 1]} ${a2}`
  if (a1 === a2) return `${d1} ${MESES[m1 - 1]} – ${d2} ${MESES[m2 - 1]} ${a2}`
  return `${d1} ${MESES[m1 - 1]} ${a1} – ${d2} ${MESES[m2 - 1]} ${a2}`
}
