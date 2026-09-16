/**
 * CORSA Carwash — notificaciones.
 *
 * Igual que plc.service.ts: las consultas viven acá y no dentro de las
 * pantallas, para que la campana del riel y la pantalla de configuración no
 * terminen contando cosas distintas sobre lo mismo.
 *
 * Las lecturas no propagan errores —una campana que no carga no puede voltear
 * la pantalla— pero las escrituras sí: si desactivar un dispositivo falla, el
 * usuario tiene que enterarse, porque va a seguir recibiendo notificaciones.
 */
import { supabase } from '../lib/supabase'

export type TipoNotificacion =
  | 'WASH_COMPLETED' | 'MACHINE_ERROR' | 'DAILY_CLOSE' | 'TEST' | string

export interface Notificacion {
  id: string
  event_type: TipoNotificacion
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
  machine_id: string | null
  service_type: string | null
  title: string
  body: string
  deep_link: string | null
  metadata: Record<string, unknown>
  created_at: string
  leida: boolean
}

export interface Dispositivo {
  id: string
  user_id: string
  usuario: string
  device_name: string
  platform: string | null
  standalone: boolean | null
  enabled: boolean
  wash_notifications: boolean
  machine_error_notifications: boolean
  daily_close_notifications: boolean
  created_at: string
  last_seen_at: string
  last_push_at: string | null
  invalidated_at: string | null
  invalidated_reason: string | null
  endpoint_corto: string
  recibidas: number
}

// ─── Centro de notificaciones ─────────────────────────────────

export async function fetchNotificaciones(limite = 40): Promise<Notificacion[]> {
  const { data, error } = await (supabase.rpc as any)(
    'corsa_notificaciones_recientes', { p_limite: limite })
  if (error) return []
  return (data ?? []) as Notificacion[]
}

/** Sin ids, marca todas. Devuelve cuántas quedaron marcadas recién ahora. */
export async function marcarLeidas(ids?: string[]): Promise<number> {
  const { data, error } = await (supabase.rpc as any)(
    'corsa_marcar_leidas', { p_ids: ids ?? null })
  if (error) return 0
  return Number(data ?? 0)
}

// ─── Dispositivos ─────────────────────────────────────────────

/**
 * Los dispositivos que el usuario puede ver: los suyos siempre, y los de toda
 * la organización si administra usuarios. Quién ve qué lo decide la RLS de
 * push_subscriptions, no esta consulta.
 */
export async function fetchDispositivos(): Promise<Dispositivo[]> {
  const { data, error } = await (supabase as any)
    .from('v_corsa_dispositivos')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) return []
  return (data ?? []) as Dispositivo[]
}

export interface CambioDispositivo {
  enabled?: boolean
  wash?: boolean
  error?: boolean
  cierre?: boolean
  nombre?: string
}

export async function actualizarDispositivo(id: string, cambio: CambioDispositivo): Promise<void> {
  const { error } = await (supabase.rpc as any)('corsa_dispositivo_preferencias', {
    p_id: id,
    p_enabled: cambio.enabled ?? null,
    p_wash: cambio.wash ?? null,
    p_error: cambio.error ?? null,
    p_cierre: cambio.cierre ?? null,
    p_nombre: cambio.nombre ?? null,
  })
  if (error) throw new Error(error.message)
}

export async function eliminarDispositivo(id: string): Promise<void> {
  const { error } = await (supabase as any).from('push_subscriptions').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// ─── Cierre del día ───────────────────────────────────────────

export interface ResumenMaquina {
  machine_id: string
  nombre: string
  lavados: number
  pro: number
  elite: number
  signature: number
  unknown: number
  faulted: number
  interrumpidos: number
  busy_seconds: number
  primer_lavado: string | null
  ultimo_lavado: string | null
}

export interface Resumen {
  fecha: string
  total_lavados: number
  total_pro: number
  total_elite: number
  total_signature: number
  total_busy_seconds: number
  primer_lavado: string | null
  ultimo_lavado: string | null
  maquinas: ResumenMaquina[]
}

export interface CierreDiario {
  fecha: string
  cerrado: boolean
  cerrado_at: string | null
  motivo: string | null
  deteccion: string | null
  generado_por: string | null
  notification_sent_at: string | null
  resumen: Resumen
}

export async function fetchCierreDiario(fecha?: string): Promise<CierreDiario | null> {
  const { data, error } = await (supabase.rpc as any)(
    'corsa_cierre_del_dia', { p_fecha: fecha ?? null })
  if (error) return null
  return data as CierreDiario
}

export interface EstadoMaquina {
  machine_id: string
  nombre: string
  estado: string | null
  apagada_desde: string | null
  minutos_apagada: number | null
}

export interface EstadoOperativo {
  fecha: string
  hora_local: string
  gateway_online: boolean
  gateway_ultimo_latido: string | null
  maquinas: EstadoMaquina[]
  maquinas_totales: number
  maquinas_apagadas: number
  apagadas_desde: string | null
  lavados_hoy: number
  ultimo_lavado: string | null
  cerrado: boolean
}

export async function fetchEstadoOperativo(): Promise<EstadoOperativo | null> {
  const { data, error } = await (supabase.rpc as any)('corsa_estado_operativo_actual')
  if (error) return null
  return data as EstadoOperativo
}

export async function cerrarDiaManual(fecha?: string): Promise<{ ok: boolean; motivo?: string }> {
  const { data, error } = await (supabase.rpc as any)(
    'corsa_cerrar_dia_manual', { p_fecha: fecha ?? null })
  if (error) throw new Error(error.message)
  return data as { ok: boolean; motivo?: string }
}

// ─── Configuración del módulo ─────────────────────────────────

export interface ConfigNotificaciones {
  enabled: boolean
  simulacion_habilitada: boolean
  cierre_ventana_minutos: number
  cierre_hora_minima: string
  cierre_hora_tope: string
  cierre_inactividad_minutos: number
}

export async function fetchConfigNotificaciones(): Promise<ConfigNotificaciones | null> {
  const { data, error } = await (supabase as any)
    .from('corsa_notification_config')
    .select('enabled, simulacion_habilitada, cierre_ventana_minutos, cierre_hora_minima, cierre_hora_tope, cierre_inactividad_minutos')
    .maybeSingle()

  if (error) return null
  return data as ConfigNotificaciones | null
}

// ─── Presentación ─────────────────────────────────────────────

/** El emoji con el que se reconoce un tipo de notificación de un vistazo. */
export function iconoDe(tipo: TipoNotificacion): string {
  switch (tipo) {
    case 'WASH_COMPLETED': return '🚗'
    case 'MACHINE_ERROR':  return '⚠️'
    case 'DAILY_CLOSE':    return '🌙'
    case 'TEST':           return '🔔'
    default:               return '•'
  }
}

/**
 * «hace 5 min», «7:31 PM», «ayer 6:12 PM».
 *
 * En una lista de notificaciones, la hora exacta de algo que pasó hace un
 * minuto no le sirve a nadie, y «hace 14 horas» de algo de ayer tampoco.
 */
export function cuandoFue(iso: string): string {
  const fecha = new Date(iso)
  const minutos = Math.floor((Date.now() - fecha.getTime()) / 60000)

  if (minutos < 1) return 'recién'
  if (minutos < 60) return `hace ${minutos} min`

  const hora = fecha.toLocaleTimeString('es-SV', {
    timeZone: 'America/El_Salvador', hour: 'numeric', minute: '2-digit', hour12: true,
  })

  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' })
  const dia = fecha.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' })
  if (dia === hoy) return hora

  const ayer = new Date(Date.now() - 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' })
  if (dia === ayer) return `ayer ${hora}`

  return `${fecha.toLocaleDateString('es-SV', {
    timeZone: 'America/El_Salvador', day: '2-digit', month: 'short',
  })} ${hora}`
}
