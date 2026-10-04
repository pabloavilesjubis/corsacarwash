/**
 * CORSA — caja del día (0065): apertura, retiros de efectivo, cierre con
 * remesa e historial de cierres. Todo pasa por RPC: las reglas (permisos,
 * quién autoriza, que no se retire más de lo que hay) las pone el servidor.
 */
import { supabase } from '../lib/supabase'
import { normalizarResumen, type ResumenCaja } from '../lib/caja/resumen'

export { normalizarResumen }
export type { MovimientoCaja, ResumenCaja } from '../lib/caja/resumen'

export interface EstadoCaja {
  cash_register_id: string
  caja: string
  sesion: ResumenCaja | null
  ultimo_cierre: { session_id: string; cerrada_at: string | null; efectivo_final: number } | null
}

const rpc = (supabase as any).rpc.bind(supabase)

async function llamar<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export async function fetchEstadoCaja(branchId: string): Promise<EstadoCaja> {
  const e = await llamar<any>('caja_estado', { p_branch_id: branchId })
  return {
    ...e,
    sesion: e.sesion ? normalizarResumen(e.sesion) : null,
    ultimo_cierre: e.ultimo_cierre ? { ...e.ultimo_cierre, efectivo_final: Number(e.ultimo_cierre.efectivo_final) || 0 } : null,
  }
}

export const abrirCaja = (branchId: string, monto: number) =>
  llamar<string>('caja_abrir', { p_branch_id: branchId, p_monto: monto })

export async function retirarEfectivo(sessionId: string, monto: number, motivo: string, autorizadoPor: string): Promise<ResumenCaja> {
  return normalizarResumen(await llamar('caja_retiro', {
    p_session_id: sessionId, p_monto: monto, p_motivo: motivo, p_autorizado_por: autorizadoPor,
  }))
}

export async function cerrarCaja(sessionId: string, remesa: number): Promise<ResumenCaja> {
  return normalizarResumen(await llamar('caja_cerrar', { p_session_id: sessionId, p_remesa: remesa }))
}

export const fetchAutorizadores = () => llamar<{ id: string; nombre: string }[]>('caja_autorizadores', {})

export async function fetchReporteCaja(sessionId: string): Promise<ResumenCaja> {
  return normalizarResumen(await llamar('caja_reporte', { p_session_id: sessionId }))
}

export async function fetchHistorialCaja(desde: string, hasta: string, branchId?: string | null): Promise<ResumenCaja[]> {
  const filas = await llamar<any[]>('caja_historial', { p_desde: desde, p_hasta: hasta, p_branch_id: branchId ?? null })
  return (filas ?? []).map(normalizarResumen)
}
