/**
 * CORSA — precios negociados de flotilla por servicio (0050).
 *
 * Una flotilla negocia de uno a tres servicios (PRO, ÉLITE, SIGNATURE), cada
 * uno con precio único o por tamaño, más el aspirado opcional a precio único.
 * Lo leen la pantalla de Flotillas y el POS; lo escribe sólo Flotillas.
 *
 * Mientras 0050 no esté aplicada, fleet_service_prices no existe: la lectura
 * cae al ÉLITE de fleet_pricing (0031) para que el POS siga cobrando igual.
 */

import { supabase } from '../supabase'

export type CodigoServicio = 'PRO' | 'ELITE' | 'SIGNATURE'
export type Tamano = 'S' | 'M' | 'L'
export type PreciosPorTamano = Record<Tamano, number>

export const SERVICIOS_FLOTILLA: { codigo: CodigoServicio; nombre: string }[] = [
  { codigo: 'PRO', nombre: 'PRO' },
  { codigo: 'ELITE', nombre: 'ÉLITE' },
  { codigo: 'SIGNATURE', nombre: 'SIGNATURE' },
]

/** Tarifa de lista. El POS la usa fuera de flotilla; acá, como punto de partida al negociar. */
export const PRECIOS_LISTA: Record<CodigoServicio, PreciosPorTamano> = {
  PRO:       { S: 9,  M: 11, L: 12 },
  ELITE:     { S: 12, M: 14, L: 15 },
  SIGNATURE: { S: 15, M: 17, L: 18 },
}

export interface AcuerdoFlotilla {
  /** Sólo los servicios negociados. */
  servicios: Partial<Record<CodigoServicio, PreciosPorTamano>>
  /** Cuáles se negociaron por tamaño (para mostrar y editar). */
  porTamano: Partial<Record<CodigoServicio, boolean>>
  aspirado: { activo: boolean; precio: number | null }
}

const vacio = (): AcuerdoFlotilla => ({ servicios: {}, porTamano: {}, aspirado: { activo: false, precio: null } })

function deFila(r: { per_size: boolean; price: number | null; price_s: number | null; price_m: number | null; price_l: number | null }): PreciosPorTamano {
  return r.per_size
    ? { S: Number(r.price_s), M: Number(r.price_m), L: Number(r.price_l) }
    : { S: Number(r.price), M: Number(r.price), L: Number(r.price) }
}

/** El acuerdo de varias flotillas a la vez, por fleet_id. */
export async function cargarAcuerdos(fleetIds: string[]): Promise<Map<string, AcuerdoFlotilla>> {
  const acuerdos = new Map<string, AcuerdoFlotilla>(fleetIds.map(id => [id, vacio()]))
  if (fleetIds.length === 0) return acuerdos
  const db = supabase as any

  const { data: fp } = await db
    .from('fleet_pricing')
    .select('fleet_id, elite_per_size, elite_price, elite_price_s, elite_price_m, elite_price_l, aspirado_enabled, aspirado_price')
    .in('fleet_id', fleetIds)
  for (const r of fp ?? []) {
    const a = acuerdos.get(r.fleet_id)!
    a.aspirado = { activo: Boolean(r.aspirado_enabled), precio: r.aspirado_price != null ? Number(r.aspirado_price) : null }
  }

  const { data: sp, error } = await db
    .from('fleet_service_prices')
    .select('fleet_id, service_code, per_size, price, price_s, price_m, price_l')
    .in('fleet_id', fleetIds)

  if (error) {
    // 0050 sin aplicar: el único servicio negociable era ÉLITE.
    for (const r of fp ?? []) {
      const completo = r.elite_per_size
        ? r.elite_price_s != null && r.elite_price_m != null && r.elite_price_l != null
        : r.elite_price != null
      if (!completo) continue
      const a = acuerdos.get(r.fleet_id)!
      a.servicios.ELITE = deFila({ per_size: r.elite_per_size, price: r.elite_price, price_s: r.elite_price_s, price_m: r.elite_price_m, price_l: r.elite_price_l })
      a.porTamano.ELITE = Boolean(r.elite_per_size)
    }
    return acuerdos
  }

  for (const r of sp ?? []) {
    const a = acuerdos.get(r.fleet_id)
    if (!a) continue
    const codigo = r.service_code as CodigoServicio
    a.servicios[codigo] = deFila(r)
    a.porTamano[codigo] = Boolean(r.per_size)
  }
  return acuerdos
}

/** Una línea del editor, con los importes como texto tal como se escriben. */
export interface LineaEditable {
  activo: boolean
  porTamano: boolean
  unico: string
  S: string
  M: string
  L: string
}

export type LineasEditables = Record<CodigoServicio, LineaEditable>

/** Las tres líneas del editor a partir de un acuerdo (o de la tarifa de lista si no hay). */
export function lineasDesde(acuerdo: AcuerdoFlotilla | null): LineasEditables {
  const out = {} as LineasEditables
  for (const { codigo } of SERVICIOS_FLOTILLA) {
    const p = acuerdo?.servicios[codigo]
    const base = p ?? PRECIOS_LISTA[codigo]
    out[codigo] = {
      activo: Boolean(p),
      porTamano: Boolean(acuerdo?.porTamano[codigo]),
      unico: base.M.toFixed(2),
      S: base.S.toFixed(2), M: base.M.toFixed(2), L: base.L.toFixed(2),
    }
  }
  return out
}

const importe = (v: string) => {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

/** El primer problema del editor, o null si se puede guardar. */
export function problemaDeLineas(lineas: LineasEditables, aspirado: { activo: boolean; precio: string }): string | null {
  const activas = SERVICIOS_FLOTILLA.filter(s => lineas[s.codigo].activo)
  if (activas.length === 0) return 'Elegí al menos un servicio negociado'
  for (const s of activas) {
    const l = lineas[s.codigo]
    const precios = l.porTamano ? [l.S, l.M, l.L] : [l.unico]
    if (precios.some(p => importe(p) === null)) {
      return l.porTamano ? `Completá los tres precios por tamaño de ${s.nombre}` : `Ingresá el precio de ${s.nombre}`
    }
  }
  if (aspirado.activo && importe(aspirado.precio) === null) return 'Ingresá el precio del aspirado'
  return null
}

const SIN_0050 = 'Para negociar PRO o SIGNATURE falta aplicar la migración 0050 en la base. Por ahora sólo se puede guardar ÉLITE.'

/** ¿Está fleet_service_prices (0050)? Sin ella sólo se puede negociar ÉLITE. */
export async function hayPreciosPorServicio(): Promise<boolean> {
  const { error } = await (supabase as any).from('fleet_service_prices').select('fleet_id').limit(1)
  return !error
}

/** El aviso a mostrar si el editor pide algo que la base todavía no soporta, o null. */
export async function problemaDeBase(lineas: LineasEditables): Promise<string | null> {
  const soloElite = !lineas.PRO.activo && !lineas.SIGNATURE.activo
  if (soloElite) return null
  return (await hayPreciosPorServicio()) ? null : SIN_0050
}

/**
 * Guarda el acuerdo: una fila por servicio activo, borra los que se
 * desactivaron, y deja el aspirado (y el ÉLITE, para el POS anterior) en
 * fleet_pricing.
 */
export async function guardarAcuerdo(
  fleetId: string, lineas: LineasEditables, aspirado: { activo: boolean; precio: string },
): Promise<void> {
  const db = supabase as any
  const activas = SERVICIOS_FLOTILLA.filter(s => lineas[s.codigo].activo).map(s => s.codigo)
  const inactivas = SERVICIOS_FLOTILLA.filter(s => !lineas[s.codigo].activo).map(s => s.codigo)

  const filas = activas.map(codigo => {
    const l = lineas[codigo]
    return {
      fleet_id: fleetId, service_code: codigo, per_size: l.porTamano,
      price: l.porTamano ? null : importe(l.unico),
      price_s: l.porTamano ? importe(l.S) : null,
      price_m: l.porTamano ? importe(l.M) : null,
      price_l: l.porTamano ? importe(l.L) : null,
      updated_at: new Date().toISOString(),
    }
  })
  const { error: upErr } = await db.from('fleet_service_prices').upsert(filas, { onConflict: 'fleet_id,service_code' })
  const sinTabla = Boolean(upErr && /fleet_service_prices/.test(upErr.message ?? ''))
  if (upErr && !sinTabla) throw upErr
  // Sin 0050 el único lugar del precio es fleet_pricing, y sólo cabe ÉLITE.
  if (sinTabla && (lineas.PRO.activo || lineas.SIGNATURE.activo || !lineas.ELITE.activo)) throw new Error(SIN_0050)
  if (!sinTabla && inactivas.length > 0) {
    const { error: delErr } = await db.from('fleet_service_prices').delete().eq('fleet_id', fleetId).in('service_code', inactivas)
    if (delErr) throw delErr
  }

  const elite = lineas.ELITE
  const { error: fpErr } = await db.from('fleet_pricing').upsert({
    fleet_id: fleetId,
    elite_per_size: elite.activo && elite.porTamano,
    elite_price: elite.activo && !elite.porTamano ? importe(elite.unico) : null,
    elite_price_s: elite.activo && elite.porTamano ? importe(elite.S) : null,
    elite_price_m: elite.activo && elite.porTamano ? importe(elite.M) : null,
    elite_price_l: elite.activo && elite.porTamano ? importe(elite.L) : null,
    aspirado_enabled: aspirado.activo,
    aspirado_price: aspirado.activo ? importe(aspirado.precio) : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'fleet_id' })
  if (fpErr) throw fpErr
}
