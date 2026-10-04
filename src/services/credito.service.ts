/**
 * CORSA — crédito de clientes y cuentas por cobrar (0045, 0058).
 *
 * Todo lo que mueve el crédito pasa por las funciones de la base, que
 * verifican el permiso y bloquean la cuenta: habilitar, cambiar el límite,
 * deshabilitar, cobrar (lo hace la venta) y registrar abonos.
 */
import { supabase } from '../lib/supabase'

const db = () => supabase as any

/** Lo que devuelve credito_disponible: sin permisos, lo usa la caja. */
export interface CreditoDisponible {
  habilitado: boolean
  motivo?: string
  limite?: number
  saldo?: number
  disponible?: number
  dias?: number
}

export async function creditoDisponible(customerId: string): Promise<CreditoDisponible> {
  const { data, error } = await db().rpc('credito_disponible', { p_customer_id: customerId })
  if (error) throw error
  const d = (data ?? {}) as Record<string, unknown>
  return {
    habilitado: d.habilitado === true,
    motivo: typeof d.motivo === 'string' ? d.motivo : undefined,
    limite: d.limite != null ? Number(d.limite) : undefined,
    saldo: d.saldo != null ? Number(d.saldo) : undefined,
    disponible: d.disponible != null ? Number(d.disponible) : undefined,
    dias: d.dias != null ? Number(d.dias) : undefined,
  }
}

export async function habilitarCredito(customerId: string, limite: number, dias: number): Promise<void> {
  const { error } = await db().rpc('credito_habilitar', { p_customer_id: customerId, p_credit_limit: limite, p_credit_days: dias })
  if (error) throw error
}

export async function cambiarLimite(customerId: string, limite: number, motivo?: string): Promise<void> {
  const { error } = await db().rpc('credito_cambiar_limite', { p_customer_id: customerId, p_credit_limit: limite, p_reason: motivo ?? null })
  if (error) throw error
}

export async function deshabilitarCredito(customerId: string, motivo: string): Promise<void> {
  const { error } = await db().rpc('credito_deshabilitar', { p_customer_id: customerId, p_reason: motivo })
  if (error) throw error
}

export async function registrarAbono(customerId: string, monto: number, motivo?: string): Promise<void> {
  const { error } = await db().rpc('credito_registrar_pago', { p_customer_id: customerId, p_amount: monto, p_reason: motivo ?? null })
  if (error) throw error
}

/** Una fila de v_cxc_clientes (0058). */
export interface CxcCliente {
  customer_id: string
  customer_name: string | null
  legal_name: string | null
  nit: string | null
  phone: string | null
  email: string | null
  credit_enabled: boolean
  credit_limit: number
  credit_days: number
  saldo: number
  disponible: number
  blocked: boolean
  por_vencer: number
  vencido: number
  vencido_1_30: number
  vencido_31_60: number
  vencido_61_90: number
  vencido_90_mas: number
  documentos_abiertos: number
  vencimiento_mas_antiguo: string | null
}

const NUMEROS: (keyof CxcCliente)[] = [
  'credit_limit', 'credit_days', 'saldo', 'disponible', 'por_vencer', 'vencido',
  'vencido_1_30', 'vencido_31_60', 'vencido_61_90', 'vencido_90_mas', 'documentos_abiertos',
]

function aNumeros<T extends Record<string, any>>(r: T): T {
  const out: Record<string, any> = { ...r }
  for (const k of NUMEROS) if (k in out) out[k as string] = Number(out[k as string] ?? 0)
  return out as T
}

export async function fetchCxcClientes(): Promise<CxcCliente[]> {
  const { data, error } = await db().from('v_cxc_clientes').select('*').order('saldo', { ascending: false })
  if (error) throw error
  return (data ?? []).map(aNumeros)
}

export async function fetchCxcCliente(customerId: string): Promise<CxcCliente | null> {
  const { data, error } = await db().from('v_cxc_clientes').select('*').eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  return data ? aNumeros(data) : null
}

/** Un documento por cobrar (una venta al crédito). */
export interface DocumentoCxc {
  id: string
  created_at: string
  due_date: string
  amount: number
  balance: number
  status: string
  orden: string | null
  factura: string | null
}

export async function fetchDocumentosCxc(customerId: string, soloAbiertos = false): Promise<DocumentoCxc[]> {
  let q = db().from('accounts_receivable')
    .select('id, created_at, due_date, amount, balance, status, work_orders(order_number), invoices(invoice_number)')
    .eq('customer_id', customerId)
    .neq('status', 'void')
    .order('due_date', { ascending: true })
  if (soloAbiertos) q = q.gt('balance', 0)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    id: r.id, created_at: r.created_at, due_date: r.due_date,
    amount: Number(r.amount), balance: Number(r.balance), status: r.status,
    orden: r.work_orders?.order_number ?? null, factura: r.invoices?.invoice_number ?? null,
  }))
}

/** Movimientos del crédito: cargos, abonos, cambios de límite. */
export interface MovimientoCredito {
  id: string
  created_at: string
  event_type: string
  amount: number | null
  credit_limit: number | null
  balance_after: number | null
  reason: string | null
}

export async function fetchMovimientosCredito(customerId: string, limite = 100): Promise<MovimientoCredito[]> {
  const { data, error } = await db().from('corporate_credit_events')
    .select('id, created_at, event_type, amount, credit_limit, balance_after, reason')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limite)
  if (error) throw error
  return (data ?? []).map((m: any) => ({
    ...m,
    amount: m.amount != null ? Number(m.amount) : null,
    credit_limit: m.credit_limit != null ? Number(m.credit_limit) : null,
    balance_after: m.balance_after != null ? Number(m.balance_after) : null,
  }))
}

export const EVENTO_ETIQUETA: Record<string, string> = {
  CREDIT_ENABLED: 'Crédito habilitado',
  CREDIT_DISABLED: 'Crédito deshabilitado',
  LIMIT_CHANGED: 'Cambio de límite',
  CHARGE: 'Venta al crédito',
  CHARGE_OVERRIDE: 'Venta al crédito (sobre el límite)',
  PAYMENT: 'Abono',
  BLOCKED: 'Cuenta bloqueada',
  UNBLOCKED: 'Cuenta desbloqueada',
}

/** La cuenta de crédito de un cliente, para su ficha (requiere corporate.read). */
export interface CuentaCredito {
  credit_enabled: boolean
  credit_limit: number
  credit_days: number
  current_balance: number
  blocked: boolean
}

export async function fetchCuentaCredito(customerId: string): Promise<CuentaCredito | null> {
  const { data, error } = await db().from('corporate_accounts')
    .select('credit_enabled, credit_limit, credit_days, current_balance, blocked')
    .eq('customer_id', customerId).maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    credit_enabled: Boolean(data.credit_enabled),
    credit_limit: Number(data.credit_limit ?? 0),
    credit_days: Number(data.credit_days ?? 30),
    current_balance: Number(data.current_balance ?? 0),
    blocked: Boolean(data.blocked),
  }
}
