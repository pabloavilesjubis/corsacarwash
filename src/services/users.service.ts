/**
 * CORSA Carwash — Gestión de usuarios y roles
 *
 * SEGURIDAD:
 * - Listar/editar pasa por RPC security-definer que validan users.manage.
 * - Crear usuarios pasa por la Edge Function `admin-create-user`, porque
 *   requiere la service_role key, que nunca puede vivir en el browser.
 */

import { supabase } from '../lib/supabase'
import type { UUID } from '../types'

export interface AdminUser {
  id: UUID
  email: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
  phone: string | null
  active: boolean
  last_login_at: string | null
  created_at: string
  role_ids: UUID[]
  role_names: string[]
}

export interface AdminRole {
  id: UUID
  name: string
  description: string | null
  is_system: boolean
  permission_count: number
}

export async function listUsers(): Promise<AdminUser[]> {
  const { data, error } = await (supabase.rpc as any)('admin_list_users')
  if (error) throw error
  return (data ?? []) as AdminUser[]
}

export async function listRoles(): Promise<AdminRole[]> {
  const { data, error } = await (supabase.rpc as any)('admin_list_roles')
  if (error) throw error
  return (data ?? []) as AdminRole[]
}

export async function setUserRoles(userId: UUID, roleIds: UUID[]): Promise<void> {
  const { error } = await (supabase.rpc as any)('admin_set_user_roles', {
    p_user_id: userId,
    p_role_ids: roleIds,
  })
  if (error) throw new Error(error.message)
}

export async function setUserActive(userId: UUID, active: boolean): Promise<void> {
  const { error } = await (supabase.rpc as any)('admin_set_user_active', {
    p_user_id: userId,
    p_active: active,
  })
  if (error) throw new Error(error.message)
}

export interface CreateUserInput {
  email: string
  password: string
  first_name: string
  last_name?: string
  phone?: string
  role_ids: UUID[]
}

export async function createUser(input: CreateUserInput): Promise<{ id: UUID; email: string }> {
  const { data, error } = await supabase.functions.invoke('admin-create-user', {
    body: input,
  })

  if (error) {
    // La Edge Function devuelve { error } con mensaje accionable;
    // supabase-js lo envuelve en FunctionsHttpError.
    let message = 'No se pudo crear el usuario'
    const ctx = (error as any).context
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = await ctx.json()
        if (body?.error) message = body.error
      } catch { /* se mantiene el mensaje genérico */ }
    }
    throw new Error(message)
  }

  if (data?.error) throw new Error(data.error)
  return data as { id: UUID; email: string }
}

/** Contraseña temporal legible para alta presencial. */
export function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = new Uint32Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}
