/**
 * CORSA Carwash — Anular una venta y cambiar su forma de pago (0048)
 *
 * QUIÉN
 * Super Admin y Administrador lo hacen con su propia sesión. Cualquier otro
 * usuario necesita que un SUPER ADMIN escriba su correo y contraseña en ese
 * momento: se abre una sesión APARTE —en memoria, sin tocar la del cajero— y
 * la operación se hace con ESA sesión. Así la base sabe, verificado por
 * Supabase Auth, qué Super Admin autorizó (auth.uid()), y `p_requested_by`
 * dice quién lo pidió. Al terminar, esa sesión se cierra.
 *
 * La contraseña no se guarda, no se registra y no sale hacia otro lado que
 * Supabase Auth, igual que en la pantalla de ingreso.
 *
 * ANULAR CON DTE SELLADO
 * Primero se invalida el DTE ante Hacienda (tipo 2: se rescinde la operación),
 * firmado por la estación fiscal de ESTA PC, y recién con el DTE invalidado se
 * anula la venta. La base lo exige: sale_void rechaza una venta con DTE vigente.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { invalidarConFirmaLocal, ErrorFiscal } from './fiscal.service'

export interface Autorizacion {
  /** El cliente con la que se hace la operación: la sesión propia o la del Super Admin. */
  cliente: SupabaseClient
  /** Token para el Worker fiscal, si no es la sesión propia. */
  token?: string
  /** Quién pidió, si autoriza otro. */
  solicitadoPor: string | null
  /** Cierra la sesión del Super Admin, si se abrió. */
  liberar: () => Promise<void>
}

/** Con la sesión propia (Super Admin o Administrador). */
export function autorizacionPropia(): Autorizacion {
  return { cliente: supabase as unknown as SupabaseClient, solicitadoPor: null, liberar: async () => {} }
}

/**
 * Abre una sesión aparte con las credenciales de un Super Admin. No reemplaza
 * la sesión del usuario: vive sólo en memoria y se cierra con `liberar()`.
 */
export async function autorizarConSuperAdmin(correo: string, contrasena: string): Promise<Autorizacion> {
  const { data: propia } = await supabase.auth.getUser()
  const solicitante = propia.user?.id ?? null

  const aparte = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'corsa-autorizacion' },
  })
  const { data, error } = await aparte.auth.signInWithPassword({ email: correo.trim(), password: contrasena })
  if (error || !data.session) throw new Error('Correo o contraseña de Super Admin incorrectos.')
  if (data.user.id === solicitante) {
    await aparte.auth.signOut({ scope: 'local' })
    throw new Error('Esa es tu propia cuenta: hace falta otro usuario con rol Super Admin.')
  }
  return {
    cliente: aparte,
    token: data.session.access_token,
    solicitadoPor: solicitante,
    liberar: async () => { await aparte.auth.signOut({ scope: 'local' }).catch(() => {}) },
  }
}

export interface FormaDePago { code: string; name: string }

export async function fetchFormasDePago(): Promise<FormaDePago[]> {
  const { data, error } = await (supabase as any)
    .from('payment_methods')
    .select('code, name, sort_order')
    .eq('active', true)
    .order('sort_order')
  if (error) throw error
  return (data ?? []).map((m: any) => ({ code: m.code, name: m.name }))
}

/** Mensaje legible de un error de la base. */
function mensaje(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e)
  return m.replace(/^DTE_(SELLADO|EN_CURSO):\s*/, '')
}

export async function cambiarFormaDePago(
  aut: Autorizacion, orderId: string, codigo: string, motivo: string | null,
): Promise<{ anterior: string; nueva: string }> {
  const { data, error } = await (aut.cliente as any).rpc('sale_change_payment_method', {
    p_work_order_id: orderId, p_payment_method_code: codigo, p_reason: motivo, p_requested_by: aut.solicitadoPor,
  })
  if (error) throw new Error(mensaje(error))
  return data
}

export interface Persona { nombre: string; tipoDocumento: '13' | '36' | '02' | '03' | '37'; numDocumento: string }

/**
 * Anula la venta. Si tiene DTE sellado, primero lo invalida ante Hacienda con
 * firma local. Quién la solicita (y, en una FCF de mostrador, el receptor que
 * exige Hacienda) es el responsable fijo de CORSA: lo pone el Worker.
 */
export async function anularVenta(
  aut: Autorizacion,
  venta: { orderId: string; fiscalDocumentId: string | null; dteStatus: string },
  motivo: string | null,
): Promise<{ invalidado: boolean }> {
  let invalidado = false
  if (venta.dteStatus === 'ACCEPTED') {
    if (!venta.fiscalDocumentId) throw new Error('No se encontró el DTE de la venta.')
    const r = await invalidarConFirmaLocal({
      idempotencyKey: crypto.randomUUID(),
      documentoId: venta.fiscalDocumentId,
      tipoAnulacion: 2,
      motivoAnulacion: motivo,
      documentoReemplazoId: null,
      receptor: null,
      responsable: null,
      solicitante: null,
    }, { token: aut.token })
    if (r.estado !== 'ACCEPTED') {
      throw new ErrorFiscal(`Hacienda no aceptó la invalidación (${r.estado})${r.mensaje ? `: ${r.mensaje}` : ''}. La venta NO se anuló.`, r.estado)
    }
    invalidado = true
  }

  const { error } = await (aut.cliente as any).rpc('sale_void', {
    p_work_order_id: venta.orderId, p_reason: motivo, p_requested_by: aut.solicitadoPor,
  })
  if (error) {
    throw new Error(invalidado
      ? `El DTE quedó invalidado ante Hacienda, pero la venta no se pudo anular: ${mensaje(error)}. Reintentá «Anular»: el DTE ya no se vuelve a invalidar.`
      : mensaje(error))
  }
  return { invalidado }
}
