/**
 * CORSA — grupos empresariales (0054).
 *
 * Clientes hermanos que en el POS comparten placas y se facturan entre sí, con
 * precios negociados por servicio. Los precios usan el mismo modelo y el mismo
 * editor que las flotillas (lib/flotillas/precios): sólo cambia la tabla.
 */

import { supabase } from '../supabase'
import {
  SERVICIOS_FLOTILLA, type AcuerdoFlotilla, type CodigoServicio, type LineasEditables, type PreciosPorTamano,
} from '../flotillas/precios'

export interface GrupoEmpresarial {
  id: string
  name: string
  notes: string | null
  active: boolean
  /** Cuántos clientes tiene. */
  miembros: number
}

/** Un miembro del grupo con sus carros, para el POS y para Clientes. */
export interface MiembroGrupo {
  id: string
  customer_type: string
  first_name?: string | null
  last_name?: string | null
  trade_name?: string | null
  legal_name?: string | null
  nit?: string | null
  dui?: string | null
  vehiculos: { id: string; plate: string; brand?: string | null; model?: string | null; color?: string | null; vehicle_type_id?: string | null }[]
}

export function nombreMiembro(c: Pick<MiembroGrupo, 'customer_type' | 'first_name' | 'last_name' | 'trade_name' | 'legal_name'>): string {
  if (c.customer_type === 'individual') return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Cliente'
  return c.trade_name || c.legal_name || 'Cliente'
}

const db = () => supabase as any

export async function listarGrupos(): Promise<GrupoEmpresarial[]> {
  const { data, error } = await db()
    .from('business_groups')
    .select('id, name, notes, active, customers(count)')
    .eq('active', true)
    .order('name')
  if (error) throw error
  return (data ?? []).map((g: any) => ({
    id: g.id, name: g.name, notes: g.notes, active: g.active,
    miembros: Number(g.customers?.[0]?.count ?? 0),
  }))
}

export async function crearGrupo(organizationId: string, nombre: string): Promise<GrupoEmpresarial> {
  const { data, error } = await db()
    .from('business_groups')
    .insert({ organization_id: organizationId, name: nombre.trim() })
    .select('id, name, notes, active')
    .single()
  if (error) {
    if (error.code === '23505') throw new Error(`Ya existe un grupo llamado «${nombre.trim()}»`)
    throw error
  }
  return { ...data, miembros: 0 }
}

export async function renombrarGrupo(id: string, nombre: string): Promise<void> {
  const { error } = await db().from('business_groups').update({ name: nombre.trim() }).eq('id', id)
  if (error) {
    if (error.code === '23505') throw new Error(`Ya existe un grupo llamado «${nombre.trim()}»`)
    throw error
  }
}

/** Unir un cliente a un grupo, o sacarlo (null). */
export async function asignarGrupo(customerId: string, groupId: string | null): Promise<void> {
  const { error } = await db().from('customers').update({ business_group_id: groupId }).eq('id', customerId)
  if (error) throw error
}

/** Los clientes del grupo con sus carros activos. */
export async function cargarMiembros(groupId: string): Promise<MiembroGrupo[]> {
  const { data, error } = await db()
    .from('customers')
    .select('id, customer_type, first_name, last_name, trade_name, legal_name, nit, dui, ' +
            'vehicles(id, plate, brand, model, color, vehicle_type_id, active)')
    .eq('business_group_id', groupId)
    .eq('active', true)
  if (error) throw error
  return (data ?? [])
    .map((c: any) => ({ ...c, vehiculos: (c.vehicles ?? []).filter((v: any) => v.active !== false) }))
    .sort((a: MiembroGrupo, b: MiembroGrupo) => nombreMiembro(a).localeCompare(nombreMiembro(b)))
}

function deFila(r: { per_size: boolean; price: number | null; price_s: number | null; price_m: number | null; price_l: number | null }): PreciosPorTamano {
  return r.per_size
    ? { S: Number(r.price_s), M: Number(r.price_m), L: Number(r.price_l) }
    : { S: Number(r.price), M: Number(r.price), L: Number(r.price) }
}

/** El acuerdo del grupo, con la misma forma que el de una flotilla. */
export async function cargarAcuerdoGrupo(groupId: string): Promise<AcuerdoFlotilla> {
  const acuerdo: AcuerdoFlotilla = { servicios: {}, porTamano: {}, aspirado: { activo: false, precio: null } }
  const [{ data: g, error: e1 }, { data: sp, error: e2 }] = await Promise.all([
    db().from('business_groups').select('aspirado_enabled, aspirado_price').eq('id', groupId).maybeSingle(),
    db().from('business_group_prices').select('service_code, per_size, price, price_s, price_m, price_l').eq('group_id', groupId),
  ])
  if (e1) throw e1
  if (e2) throw e2
  if (g) acuerdo.aspirado = { activo: Boolean(g.aspirado_enabled), precio: g.aspirado_price != null ? Number(g.aspirado_price) : null }
  for (const r of sp ?? []) {
    const codigo = r.service_code as CodigoServicio
    acuerdo.servicios[codigo] = deFila(r)
    acuerdo.porTamano[codigo] = Boolean(r.per_size)
  }
  return acuerdo
}

const importe = (v: string) => {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

/**
 * Guarda el acuerdo del grupo. A diferencia de una flotilla, un grupo puede
 * quedar sin servicios negociados: entonces todo se cobra a tarifa de lista.
 */
export async function guardarAcuerdoGrupo(
  groupId: string, lineas: LineasEditables, aspirado: { activo: boolean; precio: string },
): Promise<void> {
  const activas = SERVICIOS_FLOTILLA.filter(s => lineas[s.codigo].activo).map(s => s.codigo)
  const inactivas = SERVICIOS_FLOTILLA.filter(s => !lineas[s.codigo].activo).map(s => s.codigo)

  if (activas.length > 0) {
    const filas = activas.map(codigo => {
      const l = lineas[codigo]
      return {
        group_id: groupId, service_code: codigo, per_size: l.porTamano,
        price: l.porTamano ? null : importe(l.unico),
        price_s: l.porTamano ? importe(l.S) : null,
        price_m: l.porTamano ? importe(l.M) : null,
        price_l: l.porTamano ? importe(l.L) : null,
        updated_at: new Date().toISOString(),
      }
    })
    const { error } = await db().from('business_group_prices').upsert(filas, { onConflict: 'group_id,service_code' })
    if (error) throw error
  }
  if (inactivas.length > 0) {
    const { error } = await db().from('business_group_prices').delete().eq('group_id', groupId).in('service_code', inactivas)
    if (error) throw error
  }
  const { error } = await db().from('business_groups').update({
    aspirado_enabled: aspirado.activo,
    aspirado_price: aspirado.activo ? importe(aspirado.precio) : null,
  }).eq('id', groupId)
  if (error) throw error
}

/** Como problemaDeLineas de flotillas, pero sin exigir un servicio: el grupo puede no negociar ninguno. */
export function problemaDeLineasGrupo(lineas: LineasEditables, aspirado: { activo: boolean; precio: string }): string | null {
  for (const s of SERVICIOS_FLOTILLA.filter(x => lineas[x.codigo].activo)) {
    const l = lineas[s.codigo]
    const precios = l.porTamano ? [l.S, l.M, l.L] : [l.unico]
    if (precios.some(p => importe(p) === null)) {
      return l.porTamano ? `Completá los tres precios por tamaño de ${s.nombre}` : `Ingresá el precio de ${s.nombre}`
    }
  }
  if (aspirado.activo && importe(aspirado.precio) === null) return 'Ingresá el precio del aspirado'
  return null
}
