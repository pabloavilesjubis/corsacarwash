/**
 * CORSA — Cuponera Digital (0083).
 *
 * Dos lados:
 *   · el PORTAL del cliente (/cuponera): sólo las RPC cuponera_portal_*, con
 *     su propio cliente de Supabase. El servidor toma el cliente de la sesión;
 *     ninguna llamada lleva un id de cliente.
 *   · la ADMINISTRACIÓN interna (pantalla Cuponera digital): RPC
 *     cuponera_admin_* y /api/cuponera para los usuarios.
 */
import { supabase } from '../lib/supabase'
import { supabaseCuponera } from '../lib/supabaseCuponera'
import type { ResultadoCorreo } from './correo.service'

// ─── Tipos compartidos ────────────────────────────────────────

export type EstadoCupon = 'pendiente' | 'entregado' | 'redimido' | 'anulado'

export interface CuponPortal {
  id: string
  code: string
  sequence_number: number
  validation_token: string
  status: 'active' | 'redeemed' | 'void'
  estado: EstadoCupon
  service_code: string
  service_name: string
  size: string | null
  includes_aspirado: boolean
  is_gift: boolean
  unit_value: number
  created_at: string
  redeemed_at: string | null
  batch_id: string
  batch_quantity: number
  customer_name: string
  entrega_id: string | null
  entregado_a: string | null
  entregado_correo: string | null
  entregado_at: string | null
  /** Arte propio del titular (0085); null = genérico. */
  fondo_cupon?: string | null
}

export interface Totales {
  comprados: number
  entregados: number
  pendientes: number
  redimidos: number
  anulados: number
}

export interface TipoCupon {
  service_code: string
  service_name: string
  size: string | null
  includes_aspirado: boolean
  comprados: number
  pendientes: number
}

export interface ResumenPortal {
  usuario: { nombre: string; correo: string; debe_cambiar_clave: boolean }
  cliente: { nombre: string }
  totales: Totales
  tipos: TipoCupon[]
}

export interface EntregaCuponera {
  id: string
  destinatario_nombre: string
  destinatario_correo: string | null
  nota: string | null
  cantidad: number
  created_at: string
  entregado_por: string
  codigos: string[]
  servicios: string | null
  redimidos: number
  correo_estado: 'sent' | 'failed' | null
  correo_at: string | null
  correo_error: string | null
  correos_enviados: number
}

export interface EntregarInput {
  nombre: string
  correo: string | null
  cantidad: number
  tipo: Pick<TipoCupon, 'service_code' | 'size' | 'includes_aspirado'>
  nota?: string | null
}

export interface ResultadoEntrega { entrega_id: string; cupones: CuponPortal[] }

/** Lo que el portal necesita. La implementación real y la de demostración la cumplen igual. */
export interface PortalApi {
  haySesion(): Promise<boolean>
  ingresar(correo: string, clave: string): Promise<string | null>
  salir(): Promise<void>
  resumen(): Promise<ResumenPortal>
  cupones(estado: EstadoCupon | null, buscar?: string): Promise<CuponPortal[]>
  cuponesDeEntrega(entregaId: string): Promise<CuponPortal[]>
  entregas(): Promise<EntregaCuponera[]>
  entregar(input: EntregarInput): Promise<ResultadoEntrega>
  enviarCorreo(entregaId: string): Promise<ResultadoCorreo>
  cambiarClave(nueva: string): Promise<string | null>
}

/** El texto de un error de Postgres, sin el ruido técnico. */
function mensaje(error: { message?: string } | null, porDefecto: string): string {
  const m = error?.message?.trim()
  return m && !/JWT|fetch|network/i.test(m) ? m : porDefecto
}

export function nombreTipo(t: Pick<TipoCupon, 'service_name' | 'size' | 'includes_aspirado'>): string {
  return [t.service_name, t.size].filter(Boolean).join(' ') + (t.includes_aspirado ? ' + aspirado' : '')
}

// ─── Portal (usuario externo) ─────────────────────────────────

const rpcPortal = async <T,>(fn: string, args: Record<string, unknown> = {}, porDefecto = 'No se pudo completar la operación'): Promise<T> => {
  const { data, error } = await (supabaseCuponera.rpc as any)(fn, args)
  if (error) throw new Error(mensaje(error, porDefecto))
  return data as T
}

export const portalApi: PortalApi = {
  async haySesion() {
    const { data } = await supabaseCuponera.auth.getSession()
    return Boolean(data.session)
  },

  async ingresar(correo, clave) {
    const { error } = await supabaseCuponera.auth.signInWithPassword({ email: correo.trim().toLowerCase(), password: clave })
    if (error) return /banned/i.test(error.message) ? 'Tu acceso está suspendido. Comunícate con CORSA Carwash.' : 'Correo o contraseña incorrectos'
    // Una cuenta que no es de la cuponera (personal de CORSA) no entra acá.
    try {
      await rpcPortal('cuponera_portal_resumen')
      return null
    } catch (e) {
      await supabaseCuponera.auth.signOut()
      return e instanceof Error ? e.message : 'Tu usuario no tiene acceso a la Cuponera Digital'
    }
  },

  async salir() { await supabaseCuponera.auth.signOut() },

  resumen: () => rpcPortal<ResumenPortal>('cuponera_portal_resumen', {}, 'No se pudo cargar tu cuponera'),

  cupones: (estado, buscar) => rpcPortal<CuponPortal[]>('cuponera_portal_cupones',
    { p_estado: estado, p_buscar: buscar?.trim() || null }, 'No se pudieron cargar los cupones'),

  cuponesDeEntrega: entregaId => rpcPortal<CuponPortal[]>('cuponera_portal_cupones_entrega',
    { p_entrega_id: entregaId }, 'No se pudieron cargar los cupones de la entrega'),

  entregas: () => rpcPortal<EntregaCuponera[]>('cuponera_portal_entregas', { p_limite: 500 }, 'No se pudieron cargar las entregas'),

  entregar: i => rpcPortal<ResultadoEntrega>('cuponera_portal_entregar', {
    p_destinatario_nombre: i.nombre,
    p_destinatario_correo: i.correo,
    p_cantidad: i.cantidad,
    p_service_code: i.tipo.service_code,
    p_size: i.tipo.size,
    p_includes_aspirado: i.tipo.includes_aspirado,
    p_nota: i.nota ?? null,
  }, 'No se pudieron entregar los cupones'),

  async enviarCorreo(entregaId) {
    const token = (await supabaseCuponera.auth.getSession()).data.session?.access_token
    return pedirCorreo(token, entregaId)
  },

  async cambiarClave(nueva) {
    const { error } = await supabaseCuponera.auth.updateUser({ password: nueva })
    if (error) {
      return /different|same/i.test(error.message)
        ? 'La contraseña nueva tiene que ser distinta de la temporal'
        : /weak|short|least/i.test(error.message) ? 'La contraseña es muy débil: usa al menos 8 caracteres' : 'No se pudo cambiar la contraseña'
    }
    try { await rpcPortal('cuponera_portal_clave_cambiada') } catch { /* el cambio ya se hizo */ }
    return null
  },
}

async function pedirCorreo(token: string | undefined, entregaId: string): Promise<ResultadoCorreo> {
  if (!token) return { ok: false, error: 'La sesión venció. Vuelve a ingresar.' }
  try {
    const res = await fetch('/api/correo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ accion: 'cupones', entregaId }),
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok && json.ok === true, estado: json.estado, error: json.error, destinatarios: json.destinatarios }
  } catch {
    return { ok: false, error: 'No se pudo contactar al servidor de correo.' }
  }
}

// ─── Administración interna ───────────────────────────────────

export interface ClienteCuponera {
  customer_id: string
  nombre: string
  nit: string | null
  correo: string | null
  activa: boolean
  created_at: string
  usuarios: number
  usuarios_activos: number
  totales: Totales
}

export interface UsuarioCuponera {
  user_id: string
  customer_id: string
  nombre: string
  correo: string
  activo: boolean
  debe_cambiar_clave: boolean
  ultimo_ingreso: string | null
  created_at: string
}

export interface LoteCuponera {
  batch_id: string
  created_at: string
  quantity: number
  service_name: string
  size: string | null
  includes_aspirado: boolean
  unit_total: number
  total: number
  cuponera: boolean
  order_number: string | null
  /** Quién pagó el lote, si no es el titular de la cuponera (0084). */
  facturado_a?: string | null
  anulado: boolean
  activos: number
  redimidos: number
  entregados: number
}

const rpcAdmin = async <T,>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
  const { data, error } = await (supabase.rpc as any)(fn, args)
  if (error) throw new Error(mensaje(error, 'No se pudo completar la operación'))
  return data as T
}

export const clientesCuponera = () => rpcAdmin<ClienteCuponera[]>('cuponera_admin_clientes')
export const habilitarCuponera = (customerId: string, activa: boolean) =>
  rpcAdmin<void>('cuponera_admin_habilitar', { p_customer_id: customerId, p_activa: activa })
export const lotesCuponera = (customerId: string) => rpcAdmin<LoteCuponera[]>('cuponera_admin_lotes', { p_customer_id: customerId })
export const cargarLoteCuponera = (batchId: string, enCuponera = true) =>
  rpcAdmin<void>('cuponera_cargar_lote', { p_batch_id: batchId, p_cuponera: enCuponera })
export const entregasCuponera = (customerId: string) =>
  rpcAdmin<EntregaCuponera[]>('cuponera_admin_entregas', { p_customer_id: customerId, p_limite: 200 })

export async function usuariosCuponera(customerId: string): Promise<UsuarioCuponera[]> {
  const { data, error } = await (supabase as any).from('cuponera_usuarios')
    .select('user_id, customer_id, nombre, correo, activo, debe_cambiar_clave, ultimo_ingreso, created_at')
    .eq('customer_id', customerId).order('created_at')
  if (error) throw new Error('No se pudieron cargar los usuarios')
  return (data ?? []) as UsuarioCuponera[]
}

/** Si el cliente tiene cuponera (para el POS Administrativo). */
export async function estadoCuponera(customerId: string): Promise<{ activa: boolean } | null> {
  const { data } = await (supabase as any).from('cuponera_clientes').select('activa').eq('customer_id', customerId).maybeSingle()
  return (data ?? null) as { activa: boolean } | null
}

export interface RespuestaUsuario {
  ok: boolean
  error?: string
  userId?: string
  correo?: string
  clave?: string
  correoEnviado?: { enviado: boolean; error?: string } | null
}

async function pedirAdmin(cuerpo: Record<string, unknown>): Promise<RespuestaUsuario> {
  const token = (await supabase.auth.getSession()).data.session?.access_token
  if (!token) return { ok: false, error: 'La sesión venció. Volvé a ingresar.' }
  try {
    const res = await fetch('/api/cuponera', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(cuerpo),
    })
    const json = await res.json().catch(() => ({}))
    return { ...json, ok: res.ok && json.ok === true }
  } catch {
    return { ok: false, error: 'No se pudo contactar al servidor.' }
  }
}

export const crearUsuarioCuponera = (customerId: string, nombre: string, correo: string, enviarCorreo: boolean) =>
  pedirAdmin({ accion: 'crear_usuario', customerId, nombre, correo, enviarCorreo })
export const restablecerClaveCuponera = (userId: string, enviarCorreo: boolean) =>
  pedirAdmin({ accion: 'restablecer_clave', userId, enviarCorreo })
export const accesoCuponera = (userId: string, activo: boolean) => pedirAdmin({ accion: 'acceso', userId, activo })

/** CORSA también puede reenviar el correo de una entrega del cliente. */
export async function reenviarCorreoEntrega(entregaId: string): Promise<ResultadoCorreo> {
  const token = (await supabase.auth.getSession()).data.session?.access_token
  return pedirCorreo(token, entregaId)
}

/** El enlace que se le pasa al cliente. */
export const urlPortal = () => `${window.location.origin}/cuponera`
