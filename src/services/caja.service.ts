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

const diaSV = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' })

/** Si el último cierre fue hoy (hora de El Salvador). */
export function cerradaHoy(estado: EstadoCaja): boolean {
  const c = estado.ultimo_cierre?.cerrada_at
  return !!c && diaSV(new Date(c)) === diaSV(new Date())
}

/**
 * Abre la caja sola si está cerrada y hay un cierre anterior: el efectivo
 * inicial es lo que quedó en ese cierre, no se le pregunta a nadie. Devuelve
 * el estado ya actualizado. Sin cierre anterior (primera apertura) no abre:
 * ahí sí hace falta el monto.
 */
export async function asegurarCajaAbierta(branchId: string): Promise<{ estado: EstadoCaja; abrioAhora: number | null }> {
  const estado = await fetchEstadoCaja(branchId)
  if (estado.sesion || !estado.ultimo_cierre) return { estado, abrioAhora: null }
  // Cerrada HOY: no se reabre sola (las ventas de mañana caerían en un turno
  // con fecha de hoy). Se reabre a mano desde el modal si hace falta.
  if (cerradaHoy(estado)) return { estado, abrioAhora: null }
  const monto = estado.ultimo_cierre.efectivo_final
  await abrirCaja(branchId, monto)
  return { estado: await fetchEstadoCaja(branchId), abrioAhora: monto }
}

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
