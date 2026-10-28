/**
 * CORSA — productos y servicios del POS administrativo (0081).
 *
 * Un catálogo propio, aparte de los lavados: viven en `services` con
 * admin_catalog = true, así que la venta usa las mismas órdenes, facturas y
 * DTE que todo lo demás. Sólo se ven y se venden en el POS administrativo.
 *
 * El precio es con IVA, como en la caja: el CCF lo desglosa al emitir.
 */

import { supabase } from '../supabase'

const db = () => supabase as any

export type TipoItem = 'producto' | 'servicio'

export interface ItemCatalogo {
  id: string
  code: string
  name: string
  description: string | null
  item_type: TipoItem
  default_price: number | null
  active: boolean
}

const COLUMNAS = 'id, code, name, description, item_type, default_price, active'

export async function listarCatalogo(soloActivos = false): Promise<ItemCatalogo[]> {
  let q = db().from('services').select(COLUMNAS).eq('admin_catalog', true)
  if (soloActivos) q = q.eq('active', true)
  const { data, error } = await q.order('name')
  if (error) throw error
  return (data ?? []).map((r: any) => ({ ...r, default_price: r.default_price != null ? Number(r.default_price) : null }))
}

export interface DatosItem {
  name: string
  description: string
  item_type: TipoItem
  /** Como se escribe: vacío = sin precio sugerido. */
  default_price: string
  active: boolean
}

const precio = (v: string): number | null => {
  const t = v.trim()
  if (!t) return null
  const n = parseFloat(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN
}

/** El primer problema del formulario, o null. */
export function problemaDeItem(d: DatosItem): string | null {
  if (!d.name.trim()) return 'Escribí el nombre'
  if (d.name.trim().length > 120) return 'El nombre es demasiado largo (máximo 120)'
  if (Number.isNaN(precio(d.default_price))) return 'Revisá el precio'
  return null
}

/** Código interno: ADM- y seis caracteres. El usuario no lo ve ni lo elige. */
function nuevoCodigo(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return 'ADM-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => abc[b % abc.length]).join('')
}

export async function guardarItem(organizationId: string, d: DatosItem, id?: string): Promise<void> {
  const fila = {
    name: d.name.trim(),
    description: d.description.trim() || null,
    item_type: d.item_type,
    default_price: precio(d.default_price),
    active: d.active,
  }
  if (id) {
    const { error } = await db().from('services').update(fila).eq('id', id).eq('admin_catalog', true)
    if (error) throw error
    return
  }
  // El código es único por organización; si choca (rarísimo), se prueba otro.
  for (let intento = 0; intento < 3; intento++) {
    const { error } = await db().from('services').insert({
      ...fila, organization_id: organizationId, code: nuevoCodigo(),
      admin_catalog: true, taxable: true, sort_order: 1000,
    })
    if (error?.code === '23505') continue
    if (error) throw error
    return
  }
  throw new Error('No se pudo generar el código del ítem. Intentá de nuevo.')
}

export async function activarItem(id: string, activo: boolean): Promise<void> {
  const { error } = await db().from('services').update({ active: activo }).eq('id', id).eq('admin_catalog', true)
  if (error) throw error
}

// ─── Venta ────────────────────────────────────────────────────

export interface LineaVenta {
  service_id: string
  cantidad: number
  /** Con IVA. */
  precio: number
  /** Lo que sale en la factura; vacío = el nombre del ítem. */
  descripcion?: string
}

export interface VentaAdminResult {
  order_id: string
  order_number: string
  invoice_id: string
  subtotal: number
  tax: number
  total: number
  doc_type: 'ticket' | 'ccf'
}

export async function venderItems(args: {
  branchId: string
  customerId: string
  lineas: LineaVenta[]
  pago: string
  docType: 'ticket' | 'ccf'
}): Promise<VentaAdminResult> {
  const { data, error } = await db().rpc('admin_sell_items', {
    p_branch_id: args.branchId,
    p_customer_id: args.customerId,
    p_items: args.lineas,
    p_payment_method: args.pago,
    p_doc_type: args.docType,
  })
  if (error) throw new Error(error.message)
  return data as VentaAdminResult
}
