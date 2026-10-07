/**
 * CORSA — tarifario especial de un cliente (0071).
 *
 * Precios fijados para UN cliente: PRO, ÉLITE y SIGNATURE (único o por
 * tamaño) más el aspirado, con el mismo modelo y el mismo editor que las
 * flotillas y los grupos (lib/flotillas/precios). Lo que no se carga va a
 * tarifa de lista. El POS lo aplica al elegir al cliente, por encima del
 * precio de su grupo. Lo edita quien negocia precios (corporate.manage).
 *
 * Sin la migración 0071 las tablas no existen: la lectura devuelve null y la
 * caja sigue cobrando como siempre.
 */

import { supabase } from '../supabase'
import {
  SERVICIOS_FLOTILLA, type AcuerdoFlotilla, type CodigoServicio, type LineasEditables,
} from '../flotillas/precios'
import { problemaDeLineasGrupo } from '../grupos/grupos'

const db = () => supabase as any

export interface Tarifario {
  habilitado: boolean
  acuerdo: AcuerdoFlotilla
}

/** El tarifario del cliente, habilitado o no; null si nunca se le cargó uno. */
export async function cargarTarifario(customerId: string): Promise<Tarifario | null> {
  const [{ data: t, error: e1 }, { data: sp, error: e2 }] = await Promise.all([
    db().from('customer_pricing').select('enabled, aspirado_enabled, aspirado_price').eq('customer_id', customerId).maybeSingle(),
    db().from('customer_service_prices').select('service_code, per_size, price, price_s, price_m, price_l').eq('customer_id', customerId),
  ])
  if (e1) throw e1
  if (e2) throw e2
  if (!t) return null
  const acuerdo: AcuerdoFlotilla = {
    servicios: {}, porTamano: {},
    aspirado: { activo: Boolean(t.aspirado_enabled), precio: t.aspirado_price != null ? Number(t.aspirado_price) : null },
  }
  for (const r of sp ?? []) {
    const codigo = r.service_code as CodigoServicio
    acuerdo.servicios[codigo] = r.per_size
      ? { S: Number(r.price_s), M: Number(r.price_m), L: Number(r.price_l) }
      : { S: Number(r.price), M: Number(r.price), L: Number(r.price) }
    acuerdo.porTamano[codigo] = Boolean(r.per_size)
  }
  return { habilitado: Boolean(t.enabled), acuerdo }
}

/** Lo que el POS cobra: el acuerdo si está habilitado. Si falla, tarifa de lista. */
export async function tarifarioVigente(customerId: string): Promise<AcuerdoFlotilla | null> {
  const t = await cargarTarifario(customerId).catch(() => null)
  return t?.habilitado ? t.acuerdo : null
}

const importe = (v: string) => {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

/** El primer problema del editor, o null si se puede guardar. */
export function problemaDeTarifario(lineas: LineasEditables, aspirado: { activo: boolean; precio: string }): string | null {
  if (!SERVICIOS_FLOTILLA.some(s => lineas[s.codigo].activo) && !aspirado.activo) {
    return 'Marcá al menos un servicio o el aspirado'
  }
  return problemaDeLineasGrupo(lineas, aspirado)
}

/** Guarda el tarifario y lo deja habilitado. */
export async function guardarTarifario(
  customerId: string, organizationId: string, lineas: LineasEditables, aspirado: { activo: boolean; precio: string },
): Promise<void> {
  const ahora = new Date().toISOString()
  // Primero la cabecera: los precios cuelgan de ella.
  const { error: e1 } = await db().from('customer_pricing').upsert({
    customer_id: customerId, organization_id: organizationId, enabled: true,
    aspirado_enabled: aspirado.activo,
    aspirado_price: aspirado.activo ? importe(aspirado.precio) : null,
    updated_at: ahora,
  }, { onConflict: 'customer_id' })
  if (e1) throw e1

  const activas = SERVICIOS_FLOTILLA.filter(s => lineas[s.codigo].activo).map(s => s.codigo)
  const inactivas = SERVICIOS_FLOTILLA.filter(s => !lineas[s.codigo].activo).map(s => s.codigo)
  if (activas.length > 0) {
    const filas = activas.map(codigo => {
      const l = lineas[codigo]
      return {
        customer_id: customerId, service_code: codigo, per_size: l.porTamano,
        price: l.porTamano ? null : importe(l.unico),
        price_s: l.porTamano ? importe(l.S) : null,
        price_m: l.porTamano ? importe(l.M) : null,
        price_l: l.porTamano ? importe(l.L) : null,
        updated_at: ahora,
      }
    })
    const { error } = await db().from('customer_service_prices').upsert(filas, { onConflict: 'customer_id,service_code' })
    if (error) throw error
  }
  if (inactivas.length > 0) {
    const { error } = await db().from('customer_service_prices').delete().eq('customer_id', customerId).in('service_code', inactivas)
    if (error) throw error
  }
}

/** Prende o apaga el tarifario sin tocar los precios cargados. */
export async function habilitarTarifario(customerId: string, habilitado: boolean): Promise<void> {
  const { error } = await db().from('customer_pricing')
    .update({ enabled: habilitado, updated_at: new Date().toISOString() })
    .eq('customer_id', customerId)
  if (error) throw error
}
