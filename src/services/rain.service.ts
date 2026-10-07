/**
 * CORSA Carwash — Seguros de lluvia
 *
 * Una póliza es una obligación abierta: 48 horas para que el mismo vehículo
 * vuelva por un lavado PRO sin costo. Todo lo que decide algo —si está viva,
 * si se puede canjear— vive en el servidor (0039); acá sólo se lee y se pide.
 *
 * El estado NO se calcula en el frontend a propósito. Si esta pantalla
 * comparara fechas por su cuenta, el reloj del teléfono del cajero decidiría
 * si un cliente tiene derecho a su lavado, y ese reloj puede estar mal.
 */
import { supabase } from '../lib/supabase'

/** Los cuatro estados que usa el negocio, más 'anulada'. */
export type EstadoPoliza = 'activa' | 'por_vencer' | 'vencida' | 'canjeada' | 'anulada'

export interface RainPolicy {
  id: string
  branch_name: string | null
  order_number: string | null
  customer_id: string
  customer_name: string
  customer_phone: string | null
  vehicle_id: string
  plate: string
  vehicle_label: string | null
  price: number
  issued_at: string
  valid_until: string
  status: string
  estado: EstadoPoliza
  horas_restantes: number
  redeemed_at: string | null
  notes: string | null
  /** Regalado desde el POS (0053). */
  courtesy?: boolean
  /**
   * Pide el código de 6 dígitos de su ticket para canjearse (0071). El código
   * en sí no sale de la base: lo compara el servidor. Las pólizas anteriores
   * a 0071 no tienen.
   */
  requiere_codigo?: boolean
}

export interface RainFilters {
  /** 'todas' o uno de los estados. */
  estado?: EstadoPoliza | 'todas'
  /** Placa o nombre del cliente. */
  buscar?: string
  limite?: number
}

export async function fetchPolicies(filtros: RainFilters = {}): Promise<RainPolicy[]> {
  let q = (supabase as any)
    .from('v_rain_policies')
    .select('*')
    // Por vencimiento y no por emisión: lo urgente es lo que está por perderse.
    .order('valid_until', { ascending: false })
    .limit(filtros.limite ?? 300)

  if (filtros.estado && filtros.estado !== 'todas') q = q.eq('estado', filtros.estado)

  const term = filtros.buscar?.trim()
  if (term) q = q.or(`plate.ilike.%${term}%,customer_name.ilike.%${term}%`)

  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as RainPolicy[]
}

/**
 * La póliza viva de un vehículo, si tiene.
 *
 * Es lo que el POS pregunta al elegir un cliente: si el carro tiene seguro
 * vigente, el cajero tiene que enterarse antes de cobrar, no después.
 */
export async function fetchPolizaVigente(vehicleId: string): Promise<RainPolicy | null> {
  const { data, error } = await (supabase as any)
    .from('v_rain_policies')
    .select('*')
    .eq('vehicle_id', vehicleId)
    .in('estado', ['activa', 'por_vencer'])
    .order('valid_until', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return null
  return (data as RainPolicy) ?? null
}

/** Lo que se teclea: sólo los dígitos, como en los cupones. */
export const limpiarCodigoSeguro = (v: string) => v.replace(/\D/g, '').slice(0, 6)

/**
 * Registrar el canje sin pasar por una venta (el lavado ya se hizo). Con
 * `codigo` sólo si la póliza lo pide: así sigue andando contra una base sin 0071.
 */
export async function redimirPoliza(id: string, codigo?: string | null, notas?: string): Promise<void> {
  const { error } = await (supabase as any).rpc('rain_policy_redeem', {
    p_policy_id: id,
    p_notes: notas ?? null,
    ...(codigo ? { p_code: codigo } : {}),
  })
  if (error) throw error
}

/** Cuánto le queda, en palabras. Sólo presentación: el estado lo dio el servidor. */
export function tiempoRestante(horas: number): string {
  if (horas <= 0) return 'vencido'
  if (horas < 1) return `${Math.round(horas * 60)} min`
  if (horas < 24) return `${Math.floor(horas)} h`
  return `${Math.floor(horas / 24)} d ${Math.floor(horas % 24)} h`
}

export const ESTADO_ETIQUETA: Record<EstadoPoliza, string> = {
  activa:     'Activa',
  por_vencer: 'Por vencer',
  vencida:    'Vencida',
  canjeada:   'Canjeada',
  anulada:    'Anulada',
}

export const ESTADO_COLOR: Record<EstadoPoliza, { color: string; tint: string }> = {
  activa:     { color: 'var(--color-success-text)', tint: 'var(--color-success-tint)' },
  por_vencer: { color: 'var(--color-warning-text)', tint: 'var(--color-warning-tint)' },
  vencida:    { color: 'var(--text-secondary)',     tint: 'var(--subtle-bg)' },
  canjeada:   { color: 'var(--corsa-green)',        tint: 'var(--subtle-bg)' },
  anulada:    { color: 'var(--color-danger-text)',  tint: 'var(--color-danger-tint)' },
}

/** Lo que devuelve rain_policy_courtesy (0053). */
export interface PolizaCortesia {
  id: string
  plate: string
  price: number
  courtesy: true
  customer_name: string
  issued_at: string
  valid_until: string
  /** Código para canjearlo, impreso en su ticket (0071). */
  code?: string | null
}

/**
 * Seguro de lluvia de cortesía: 48 horas, precio cero. Con `workOrderId` queda
 * atado a la venta recién cobrada (y repetirlo devuelve el mismo); sin él es
 * una cortesía suelta, desde el modal del POS.
 */
export async function darCortesia(args: {
  branchId: string
  customerId: string
  vehicleId: string
  workOrderId?: string | null
}): Promise<PolizaCortesia> {
  const { data, error } = await (supabase as any).rpc('rain_policy_courtesy', {
    p_branch_id: args.branchId,
    p_customer_id: args.customerId,
    p_vehicle_id: args.vehicleId,
    p_work_order_id: args.workOrderId ?? null,
  })
  if (error) throw error
  return data as PolizaCortesia
}
