/**
 * CORSA Carwash — Cupones de servicio (prepago / regalía)
 *
 * Toda la escritura pasa por RPC security-definer: las tablas no tienen policy
 * de insert/update a propósito, para que nadie pueda marcar un cupón como
 * canjeado ni tocar un correlativo por fuera de la validación.
 */

import { supabase } from '../lib/supabase'

export interface VoucherRow {
  id: string
  /** Número de cupón: 6 dígitos al azar. Es lo que se imprime y se teclea. */
  code: string
  /** Correlativo interno del talonario. Control, no validación. */
  sequence_number: number
  validation_token: string
  status: 'active' | 'redeemed' | 'void'
  service_code: string
  service_name: string
  size: string | null
  includes_aspirado: boolean
  /** Regalía: sin cobro, sin factura y a nombre de «Cliente General». */
  is_gift: boolean
  unit_value: number
  created_at: string
  sold_date: string
  redeemed_at: string | null
  redeemed_date: string | null
  batch_id: string
  batch_quantity: number
  customer_id: string | null
  customer_name: string
  redeemed_order_number: string | null
}

export interface VoucherFilters {
  status?: 'active' | 'redeemed' | 'void'
  customerId?: string
  from?: string
  to?: string
  search?: string
  limit?: number
}

export async function fetchVouchers(f: VoucherFilters = {}): Promise<VoucherRow[]> {
  let q = (supabase as any)
    .from('v_vouchers')
    .select('*')
    .order('code', { ascending: false })
    .limit(f.limit ?? 1000)

  if (f.status) q = q.eq('status', f.status)
  if (f.customerId) q = q.eq('customer_id', f.customerId)
  if (f.from) q = q.gte('sold_date', f.from)
  if (f.to) q = q.lte('sold_date', f.to)

  const term = f.search?.trim()
  if (term) q = q.or(`code.ilike.%${term}%,customer_name.ilike.%${term}%`)

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as VoucherRow[]
}

export interface SellVouchersInput {
  branchId: string
  /** Null en una regalía: el cupón no se emite a nombre de nadie. */
  customerId: string | null
  serviceCode: string
  size: string
  quantity: number
  unitPriceService: number
  includesAspirado: boolean
  unitPriceAspirado: number
  paymentMethod: string
  docType: 'ticket' | 'ccf'
  isGift: boolean
}

export interface SoldVoucher {
  id: string
  code: string
  sequence: number
  token: string
}

export interface SellVouchersResult {
  batch_id: string
  order_id: string
  order_number: string
  quantity: number
  service_name: string
  size: string | null
  includes_aspirado: boolean
  unit_total: number
  subtotal: number
  tax: number
  total: number
  doc_type: 'ticket' | 'ccf'
  is_gift: boolean
  vouchers: SoldVoucher[]
  issued_at: string
}

export async function sellVouchers(input: SellVouchersInput): Promise<SellVouchersResult> {
  const { data, error } = await (supabase.rpc as any)('sell_service_vouchers', {
    p_branch_id:           input.branchId,
    p_customer_id:         input.customerId,
    p_service_code:        input.serviceCode,
    p_size:                input.size,
    p_quantity:            input.quantity,
    p_unit_price_service:  input.unitPriceService,
    p_includes_aspirado:   input.includesAspirado,
    p_unit_price_aspirado: input.unitPriceAspirado,
    p_payment_method:      input.paymentMethod,
    p_doc_type:            input.docType,
    p_is_gift:             input.isGift,
  })
  if (error) throw new Error(error.message)
  return data as SellVouchersResult
}

export interface VoucherLookup {
  id: string
  code: string
  sequence_number: number
  status: 'active' | 'redeemed' | 'void'
  service_code: string
  service_name: string
  size: string | null
  includes_aspirado: boolean
  unit_value: number
  redeemed_at: string | null
  customer_name: string
}

/** Consulta sin consumir: el cajero ve qué incluye antes de canjear. */
export async function lookupVoucher(code: string): Promise<VoucherLookup | null> {
  const { data, error } = await (supabase.rpc as any)('lookup_service_voucher', { p_code: code })
  if (error) throw new Error(error.message)
  return (data ?? null) as VoucherLookup | null
}

export interface RedeemResult {
  voucher_id: string
  code: string
  sequence_number: number
  order_id: string
  order_number: string
  service_code: string
  service_name: string
  machine_program: number | null
  size: string | null
  includes_aspirado: boolean
  unit_value: number
  redeemed_at: string
}

export async function redeemVoucher(
  code: string, branchId: string, opts: { vehicleId?: string; plate?: string } = {}
): Promise<RedeemResult> {
  const { data, error } = await (supabase.rpc as any)('redeem_service_voucher', {
    p_code:       code,
    p_branch_id:  branchId,
    p_vehicle_id: opts.vehicleId ?? null,
    p_plate:      opts.plate ?? null,
  })
  if (error) throw new Error(error.message)
  return data as RedeemResult
}

/** Cupones de un lote, para reimprimir el PDF de una venta ya hecha. */
export async function fetchBatchVouchers(batchId: string): Promise<VoucherRow[]> {
  const { data, error } = await (supabase as any)
    .from('v_vouchers')
    .select('*')
    .eq('batch_id', batchId)
    .order('code')
  if (error) throw error
  return (data ?? []) as VoucherRow[]
}
