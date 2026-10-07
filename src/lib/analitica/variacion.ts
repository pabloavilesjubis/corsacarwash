/**
 * CORSA — cómo se compara un número contra el período anterior.
 *
 * Una variación sólo se calcula si hay base: contra cero o contra un período
 * en que el sistema todavía no registraba ventas, «+100%» no es crecimiento,
 * es el POS empezando a usarse. En esos casos no hay porcentaje, hay un
 * motivo.
 *
 * Que un número suba no siempre es bueno: cada KPI declara su sentido y el
 * color sale de ahí, no de la flecha.
 */

export type Sentido = 'mas_es_mejor' | 'menos_es_mejor' | 'neutro'
export type Tono = 'bueno' | 'malo' | 'neutro'

export interface Variacion {
  /** Variación relativa (0.12 = +12%) o null si no hay base. */
  relativa: number | null
  /** Para KPIs que ya son porcentaje: diferencia en puntos. */
  puntos: number | null
  /** Por qué no hay variación, si no la hay. */
  motivo: string | null
  tono: Tono
}

/** Debajo de esto la variación se muestra en gris: no es una señal. */
export const UMBRAL_VARIACION = 0.02
export const UMBRAL_PUNTOS = 1

const tono = (cambio: number, umbral: number, sentido: Sentido): Tono => {
  if (sentido === 'neutro' || Math.abs(cambio) < umbral) return 'neutro'
  const sube = cambio > 0
  return (sube && sentido === 'mas_es_mejor') || (!sube && sentido === 'menos_es_mejor') ? 'bueno' : 'malo'
}

export function variacion(actual: number | null, anterior: number | null, sentido: Sentido, sinBase?: string | null): Variacion {
  if (sinBase) return { relativa: null, puntos: null, motivo: sinBase, tono: 'neutro' }
  if (actual == null || anterior == null || !Number.isFinite(actual) || !Number.isFinite(anterior)) {
    return { relativa: null, puntos: null, motivo: 'Sin datos para comparar', tono: 'neutro' }
  }
  if (anterior === 0) {
    return { relativa: null, puntos: null, motivo: actual === 0 ? 'Sin movimiento en ambos períodos' : 'Sin base en el período anterior', tono: 'neutro' }
  }
  const r = (actual - anterior) / Math.abs(anterior)
  return { relativa: r, puntos: null, motivo: null, tono: tono(r, UMBRAL_VARIACION, sentido) }
}

/** Para un KPI que es un porcentaje (0–1): la diferencia en puntos porcentuales. */
export function variacionEnPuntos(actual: number | null, anterior: number | null, sentido: Sentido, sinBase?: string | null): Variacion {
  if (sinBase) return { relativa: null, puntos: null, motivo: sinBase, tono: 'neutro' }
  if (actual == null || anterior == null) return { relativa: null, puntos: null, motivo: 'Sin datos para comparar', tono: 'neutro' }
  const p = (actual - anterior) * 100
  return { relativa: null, puntos: p, motivo: null, tono: tono(p, UMBRAL_PUNTOS, sentido) }
}

export const pct = (r: number, decimales = 1) =>
  `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r * 100).toFixed(decimales)}%`

export const pp = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)} pp`

export function textoVariacion(v: Variacion): string {
  if (v.relativa != null) return pct(v.relativa)
  if (v.puntos != null) return pp(v.puntos)
  return v.motivo ?? '—'
}

/** División segura: null en vez de NaN o Infinity. */
export const dividir = (a: number, b: number): number | null => (b > 0 && Number.isFinite(a) ? a / b : null)

export const dinero = (n: number | null | undefined, decimales = 2) =>
  n == null || !Number.isFinite(n) ? '—'
    : 'US$' + n.toLocaleString('en-US', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })

export const entero = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US')

export const porcentaje = (r: number | null | undefined, decimales = 1) =>
  r == null || !Number.isFinite(r) ? '—' : `${(r * 100).toFixed(decimales)}%`
