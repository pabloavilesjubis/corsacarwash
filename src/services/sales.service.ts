/**
 * CORSA Carwash — Historial de ventas
 *
 * Lee v_sales_history (0030_pos_sales.sql): una fila por venta, ya resuelta
 * con cliente, servicio, placa, método de pago y documento fiscal. La vista
 * hereda las RLS de work_orders, así que el filtrado por organización y
 * sucursal lo hace el servidor.
 */

import { supabase } from '../lib/supabase'

export interface SaleItem {
  descripcion: string
  cantidad: number
  unitario: number
  total: number
}

export interface Sale {
  order_id: string
  branch_id: string
  branch_name: string
  order_number: string
  created_at: string
  sale_date: string
  status: string
  /** 'service' | 'voucher_sale' | 'voucher_redemption' — ver 0032. */
  order_kind: string
  voucher_batch_id: string | null
  voucher_quantity: number | null
  subtotal: number
  tax_total: number
  total: number
  notes: string | null
  service_name: string | null
  with_aspirado: boolean
  /** Líneas tal como se facturaron; null en ventas anteriores a la 0030. */
  items: SaleItem[] | null
  customer_name: string
  plate: string | null
  payment_method: string | null
  invoice_id: string | null
  invoice_type: string | null
  invoice_number: string | null
  /** 'no_emitido' | 'pending' | 'sent' | 'accepted' | 'rejected' | 'error' */
  dte_status: string
  fiscal_document_id: string | null
  has_dte_payload: boolean
}

/**
 * JSON del DTE tal como se envió al MH y lo que respondió.
 * Sólo existe una vez transmitido; antes de eso no hay nada que descargar.
 */
export async function fetchDtePayload(fiscalDocumentId: string): Promise<{
  payload: unknown
  response: unknown
  status: string
}> {
  const { data, error } = await (supabase as any)
    .from('fiscal_documents')
    .select('payload, response, status')
    .eq('id', fiscalDocumentId)
    .single()
  if (error) throw error
  return data
}

export interface SalesFilters {
  /** ISO date (YYYY-MM-DD) inclusive. */
  from?: string
  /** ISO date (YYYY-MM-DD) inclusive. */
  to?: string
  branchId?: string
  /** 'consumidor_final' | 'credito_fiscal' */
  invoiceType?: string
  /** Busca por número de orden, cliente o placa. */
  search?: string
  limit?: number
}

export async function fetchSales(filters: SalesFilters = {}): Promise<Sale[]> {
  let q = (supabase as any)
    .from('v_sales_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 500)

  if (filters.from) q = q.gte('sale_date', filters.from)
  if (filters.to) q = q.lte('sale_date', filters.to)
  if (filters.branchId) q = q.eq('branch_id', filters.branchId)
  if (filters.invoiceType) q = q.eq('invoice_type', filters.invoiceType)

  const term = filters.search?.trim()
  if (term) {
    q = q.or(
      `order_number.ilike.%${term}%,customer_name.ilike.%${term}%,plate.ilike.%${term}%`
    )
  }

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as Sale[]
}

export interface SalesTotals {
  count: number
  gross: number
  tax: number
  net: number
  average: number
  withAspirado: number
  vouchersSold: number
  vouchersRedeemed: number
}

/** Totales del conjunto ya filtrado — se calculan en el cliente sobre las filas visibles. */
export function summarize(sales: Sale[]): SalesTotals {
  const activas = sales.filter(s => s.status !== 'cancelled')
  const gross = activas.reduce((sum, s) => sum + Number(s.total || 0), 0)
  const tax = activas.reduce((sum, s) => sum + Number(s.tax_total || 0), 0)

  // El ticket promedio se calcula sólo sobre servicios cobrados en el momento.
  // Una venta de cupones lo inflaría (un solo cobro de cientos de dólares) y un
  // canje lo hundiría (vale 0). Ver 0032_service_vouchers.sql.
  const servicios = activas.filter(s => s.order_kind === 'service')
  const grossServicios = servicios.reduce((sum, s) => sum + Number(s.total || 0), 0)

  return {
    count: activas.length,
    gross,
    tax,
    net: gross - tax,
    average: servicios.length ? grossServicios / servicios.length : 0,
    withAspirado: activas.filter(s => s.with_aspirado).length,
    vouchersSold: activas.filter(s => s.order_kind === 'voucher_sale').length,
    vouchersRedeemed: activas.filter(s => s.order_kind === 'voucher_redemption').length,
  }
}

/** Rangos de uso frecuente en caja. */
export function dateRange(preset: 'hoy' | 'semana' | 'mes' | 'mes_pasado' | 'anio'): { from: string; to: string } {
  const hoy = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const y = hoy.getFullYear()
  const m = hoy.getMonth()

  switch (preset) {
    case 'hoy':
      return { from: iso(hoy), to: iso(hoy) }
    case 'semana': {
      const desde = new Date(hoy)
      // Semana corrida hacia atrás, no semana calendario: en caja interesa
      // "los últimos 7 días", no "desde el lunes".
      desde.setDate(desde.getDate() - 6)
      return { from: iso(desde), to: iso(hoy) }
    }
    case 'mes':
      return { from: iso(new Date(y, m, 1)), to: iso(hoy) }
    case 'mes_pasado':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
    case 'anio':
      return { from: iso(new Date(y, 0, 1)), to: iso(hoy) }
  }
}
