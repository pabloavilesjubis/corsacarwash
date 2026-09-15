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

/** Registrar el canje sin pasar por una venta (el lavado ya se hizo). */
export async function redimirPoliza(id: string, notas?: string): Promise<void> {
  const { error } = await (supabase as any).rpc('rain_policy_redeem', {
    p_policy_id: id,
    p_notes: notas ?? null,
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
