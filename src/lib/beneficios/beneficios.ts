/**
 * CORSA — beneficios corporativos (0079).
 *
 * Una empresa aliada da a sus empleados una tarifa especial en CORSA. Los
 * precios usan el mismo modelo y el mismo editor que flotillas y grupos
 * (lib/flotillas/precios): PRO, ÉLITE y SIGNATURE, único o por tamaño, más el
 * aspirado. Lo que no se carga va a tarifa de lista.
 *
 * El empleado se registra solo en /beneficio?c=<código> con su carnet y queda
 * activo de inmediato, para todos sus carros. El POS aplica los precios al
 * elegirlo (después del tarifario especial del cliente y antes que su grupo).
 *
 * El uso se cuenta con v_lavados (0074), carro por carro: los lavados de cada
 * miembro desde que se inscribió y mientras siguió activo.
 */

import { supabase } from '../supabase'
import {
  PRECIOS_LISTA, SERVICIOS_FLOTILLA,
  type AcuerdoFlotilla, type CodigoServicio, type LineasEditables, type Tamano,
} from '../flotillas/precios'
import { problemaDeLineasGrupo } from '../grupos/grupos'

const db = () => supabase as any

export interface Beneficio {
  id: string
  name: string
  code: string
  active: boolean
  contact_name: string | null
  contact_email: string | null
  acuerdo: AcuerdoFlotilla
  miembrosActivos: number
}

export interface MiembroBeneficio {
  id: string
  customer_id: string
  nombre: string
  telefono: string | null
  correo: string | null
  carnet: string
  active: boolean
  enrolled_at: string
  deactivated_at: string | null
  placas: string[]
}

/** El enlace que se le da a la empresa para que sus empleados se registren. */
export function enlaceBeneficio(code: string): string {
  return `${window.location.origin}/beneficio?c=${encodeURIComponent(code)}`
}

/** Ocho caracteres sin los que se confunden al dictarlos (0/O, 1/I). */
function nuevoCodigo(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const r = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(r, b => abc[b % abc.length]).join('')
}

type FilaPrecio = { per_size: boolean; price: number | null; price_s: number | null; price_m: number | null; price_l: number | null }

function acuerdoDe(
  cab: { aspirado_enabled: boolean; aspirado_price: number | null },
  filas: (FilaPrecio & { service_code: string })[],
): AcuerdoFlotilla {
  const acuerdo: AcuerdoFlotilla = {
    servicios: {}, porTamano: {},
    aspirado: { activo: Boolean(cab.aspirado_enabled), precio: cab.aspirado_price != null ? Number(cab.aspirado_price) : null },
  }
  for (const r of filas) {
    const codigo = r.service_code as CodigoServicio
    acuerdo.servicios[codigo] = r.per_size
      ? { S: Number(r.price_s), M: Number(r.price_m), L: Number(r.price_l) }
      : { S: Number(r.price), M: Number(r.price), L: Number(r.price) }
    acuerdo.porTamano[codigo] = Boolean(r.per_size)
  }
  return acuerdo
}

const PRECIO_COLS = 'benefit_id, service_code, per_size, price, price_s, price_m, price_l'

export async function listarBeneficios(): Promise<Beneficio[]> {
  const { data: bs, error } = await db().from('corporate_benefits')
    .select('id, name, code, active, contact_name, contact_email, aspirado_enabled, aspirado_price')
    .order('name')
  if (error) throw error
  const ids = (bs ?? []).map((b: any) => b.id as string)
  if (ids.length === 0) return []
  const [{ data: sp, error: e2 }, { data: ms, error: e3 }] = await Promise.all([
    db().from('corporate_benefit_service_prices').select(PRECIO_COLS).in('benefit_id', ids),
    db().from('corporate_benefit_members').select('benefit_id').in('benefit_id', ids).eq('active', true),
  ])
  if (e2) throw e2
  if (e3) throw e3
  const conteo = new Map<string, number>()
  for (const m of ms ?? []) conteo.set(m.benefit_id, (conteo.get(m.benefit_id) ?? 0) + 1)
  return (bs ?? []).map((b: any) => ({
    id: b.id, name: b.name, code: b.code, active: b.active,
    contact_name: b.contact_name, contact_email: b.contact_email,
    acuerdo: acuerdoDe(b, (sp ?? []).filter((r: any) => r.benefit_id === b.id)),
    miembrosActivos: conteo.get(b.id) ?? 0,
  }))
}

const importe = (v: string) => {
  const n = parseFloat(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

/** El primer problema del editor, o null si se puede guardar. */
export function problemaDeBeneficio(lineas: LineasEditables, aspirado: { activo: boolean; precio: string }): string | null {
  if (!SERVICIOS_FLOTILLA.some(s => lineas[s.codigo].activo) && !aspirado.activo) {
    return 'Marcá al menos un servicio o el aspirado'
  }
  return problemaDeLineasGrupo(lineas, aspirado)
}

export interface DatosBeneficio { nombre: string; contacto: string; correo: string }

export async function crearBeneficio(
  organizationId: string, datos: DatosBeneficio, lineas: LineasEditables, aspirado: { activo: boolean; precio: string },
): Promise<string> {
  // El código es único en toda la base; si choca (rarísimo), se prueba otro.
  for (let intento = 0; intento < 3; intento++) {
    const { data, error } = await db().from('corporate_benefits').insert({
      organization_id: organizationId,
      name: datos.nombre.trim(),
      code: nuevoCodigo(),
      contact_name: datos.contacto.trim() || null,
      contact_email: datos.correo.trim().toLowerCase() || null,
    }).select('id').single()
    if (error?.code === '23505') continue
    if (error) throw error
    await guardarPreciosBeneficio(data.id, lineas, aspirado)
    return data.id
  }
  throw new Error('No se pudo generar el código del beneficio. Intentá de nuevo.')
}

export async function actualizarBeneficio(id: string, datos: DatosBeneficio): Promise<void> {
  const { error } = await db().from('corporate_benefits').update({
    name: datos.nombre.trim(),
    contact_name: datos.contacto.trim() || null,
    contact_email: datos.correo.trim().toLowerCase() || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id)
  if (error) throw error
}

/** Apagado: el enlace deja de registrar y la caja deja de aplicar los precios. */
export async function activarBeneficio(id: string, activo: boolean): Promise<void> {
  const { error } = await db().from('corporate_benefits')
    .update({ active: activo, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw error
}

export async function guardarPreciosBeneficio(
  benefitId: string, lineas: LineasEditables, aspirado: { activo: boolean; precio: string },
): Promise<void> {
  const ahora = new Date().toISOString()
  const { error: e1 } = await db().from('corporate_benefits').update({
    aspirado_enabled: aspirado.activo,
    aspirado_price: aspirado.activo ? importe(aspirado.precio) : null,
    updated_at: ahora,
  }).eq('id', benefitId)
  if (e1) throw e1

  const activas = SERVICIOS_FLOTILLA.filter(s => lineas[s.codigo].activo).map(s => s.codigo)
  const inactivas = SERVICIOS_FLOTILLA.filter(s => !lineas[s.codigo].activo).map(s => s.codigo)
  if (activas.length > 0) {
    const filas = activas.map(codigo => {
      const l = lineas[codigo]
      return {
        benefit_id: benefitId, service_code: codigo, per_size: l.porTamano,
        price: l.porTamano ? null : importe(l.unico),
        price_s: l.porTamano ? importe(l.S) : null,
        price_m: l.porTamano ? importe(l.M) : null,
        price_l: l.porTamano ? importe(l.L) : null,
        updated_at: ahora,
      }
    })
    const { error } = await db().from('corporate_benefit_service_prices').upsert(filas, { onConflict: 'benefit_id,service_code' })
    if (error) throw error
  }
  if (inactivas.length > 0) {
    const { error } = await db().from('corporate_benefit_service_prices')
      .delete().eq('benefit_id', benefitId).in('service_code', inactivas)
    if (error) throw error
  }
}

function nombreCliente(c: any): string {
  if (!c) return '(sin nombre)'
  if (c.customer_type === 'company') return c.trade_name || c.legal_name || '(sin nombre)'
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || '(sin nombre)'
}

export async function listarMiembros(benefitId: string): Promise<MiembroBeneficio[]> {
  const { data, error } = await db().from('corporate_benefit_members')
    .select(`id, customer_id, carnet, active, enrolled_at, deactivated_at,
             customers(customer_type, first_name, last_name, trade_name, legal_name, phone, email,
                       vehicles(plate, active))`)
    .eq('benefit_id', benefitId)
    .order('enrolled_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((m: any) => ({
    id: m.id, customer_id: m.customer_id, carnet: m.carnet, active: m.active,
    enrolled_at: m.enrolled_at, deactivated_at: m.deactivated_at,
    nombre: nombreCliente(m.customers),
    telefono: m.customers?.phone ?? null,
    correo: m.customers?.email ?? null,
    placas: (m.customers?.vehicles ?? []).filter((v: any) => v.active !== false).map((v: any) => v.plate),
  }))
}

/** Saca (o vuelve a meter) a un empleado del beneficio. Lo ya lavado no cambia. */
export async function activarMiembro(memberId: string, activo: boolean): Promise<void> {
  const { error } = await db().from('corporate_benefit_members').update({
    active: activo,
    deactivated_at: activo ? null : new Date().toISOString(),
  }).eq('id', memberId)
  if (error?.code === '23505') {
    throw new Error('No se puede reactivar: el carnet o el cliente ya está activo en un beneficio.')
  }
  if (error) throw error
}

/** El beneficio que la caja le aplica al cliente, o null. Si falla, tarifa de lista. */
export async function beneficioVigente(customerId: string): Promise<{ id: string; name: string; carnet: string; acuerdo: AcuerdoFlotilla } | null> {
  try {
    const { data: m } = await db().from('corporate_benefit_members')
      .select('carnet, corporate_benefits(id, name, active, aspirado_enabled, aspirado_price)')
      .eq('customer_id', customerId).eq('active', true).maybeSingle()
    const b = m?.corporate_benefits
    if (!b?.active) return null
    const { data: sp, error } = await db().from('corporate_benefit_service_prices').select(PRECIO_COLS).eq('benefit_id', b.id)
    if (error) return null
    return { id: b.id, name: b.name, carnet: m.carnet, acuerdo: acuerdoDe(b, sp ?? []) }
  } catch {
    return null
  }
}

// ─── Resumen de uso para presentarle a la empresa ─────────────

export interface UsoMiembro {
  miembro: MiembroBeneficio
  lavados: number
  pagado: number
  /** Tarifa de lista menos lo pagado, en los lavados cobrados. */
  ahorro: number
  ultimaVisita: string | null
}

export interface ResumenUso {
  desde: string
  hasta: string
  inscritos: number
  /** Inscritos que lavaron al menos un carro en el período. */
  usaron: number
  nuevos: number
  lavados: number
  pagado: number
  ahorro: number
  porServicio: { servicio: string; lavados: number }[]
  porMiembro: UsoMiembro[]
}

const TAMANO_DE: Record<string, Tamano> = { small: 'S', medium: 'M', large: 'L', xl: 'L' }

/**
 * El uso del beneficio entre dos instantes [desdeISO, hastaISO). Cuenta los
 * carros lavados por cada miembro mientras estuvo inscrito.
 */
export async function resumenUso(benefitId: string, desdeISO: string, hastaISO: string): Promise<ResumenUso> {
  const miembros = await listarMiembros(benefitId)
  const ids = [...new Set(miembros.map(m => m.customer_id))]

  const lineas: any[] = []
  // De a 200 clientes: un .in() con cientos de ids revienta el largo de la URL.
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db().from('v_lavados')
      .select('customer_id, created_at, servicio, lavados, monto, vehicle_id')
      .in('customer_id', ids.slice(i, i + 200))
      .gte('created_at', desdeISO).lt('created_at', hastaISO)
    if (error) throw error
    lineas.push(...(data ?? []))
  }

  // Tamaño de cada carro, para la tarifa de lista con que se calcula el ahorro.
  const vehIds = [...new Set(lineas.map(l => l.vehicle_id).filter(Boolean))]
  const tamano = new Map<string, Tamano>()
  for (let i = 0; i < vehIds.length; i += 200) {
    const { data } = await db().from('vehicles')
      .select('id, vehicle_types(size_category)').in('id', vehIds.slice(i, i + 200))
    for (const v of data ?? []) {
      const t = TAMANO_DE[v.vehicle_types?.size_category ?? '']
      if (t) tamano.set(v.id, t)
    }
  }

  // Postgres y JS escriben los instantes distinto (+00:00 / Z): se comparan como números.
  const t = (iso: string) => new Date(iso).getTime()
  const desde = t(desdeISO), hasta = t(hastaISO)

  const porServicio = new Map<string, number>()
  const porMiembro: UsoMiembro[] = miembros
    // Inscrito antes de que termine el período y no dado de baja antes de que empiece.
    .filter(m => t(m.enrolled_at) < hasta && (!m.deactivated_at || t(m.deactivated_at) >= desde))
    .map(m => {
      const suyas = lineas.filter(l =>
        l.customer_id === m.customer_id
        && t(l.created_at) >= t(m.enrolled_at)
        && (!m.deactivated_at || t(l.created_at) < t(m.deactivated_at)))
      let lavados = 0, pagado = 0, ahorro = 0
      let ultima: string | null = null
      for (const l of suyas) {
        const n = Number(l.lavados) || 1
        const monto = Number(l.monto) || 0
        lavados += n
        pagado += monto
        porServicio.set(l.servicio, (porServicio.get(l.servicio) ?? 0) + n)
        const lista = PRECIOS_LISTA[l.servicio as CodigoServicio]?.[tamano.get(l.vehicle_id) ?? 'M']
        // Un canje ($0) no es ahorro del beneficio: el carro se pagó con otra cosa.
        if (lista != null && monto > 0) ahorro += Math.max(0, lista * n - monto)
        if (!ultima || t(l.created_at) > t(ultima)) ultima = l.created_at
      }
      return { miembro: m, lavados, pagado, ahorro, ultimaVisita: ultima }
    })
  porMiembro.sort((a, b) => b.lavados - a.lavados || a.miembro.nombre.localeCompare(b.miembro.nombre))

  const r2 = (n: number) => Math.round(n * 100) / 100
  return {
    desde: desdeISO, hasta: hastaISO,
    inscritos: porMiembro.length,
    usaron: porMiembro.filter(u => u.lavados > 0).length,
    nuevos: porMiembro.filter(u => t(u.miembro.enrolled_at) >= desde).length,
    lavados: porMiembro.reduce((s, u) => s + u.lavados, 0),
    pagado: r2(porMiembro.reduce((s, u) => s + u.pagado, 0)),
    ahorro: r2(porMiembro.reduce((s, u) => s + u.ahorro, 0)),
    porServicio: SERVICIOS_FLOTILLA
      .map(s => ({ servicio: s.nombre, lavados: porServicio.get(s.codigo) ?? 0 }))
      .filter(s => s.lavados > 0),
    porMiembro,
  }
}

// ─── Inscripción desde caja o Clientes (0080) ─────────────────

/** Lo elegido en el formulario de cliente: empresa vacía = sin beneficio. */
export interface BeneficioElegido { benefitId: string; carnet: string }

/** Qué le falta para poder inscribir, o null. Sin empresa no falta nada: es opcional. */
export function problemaDeBeneficioElegido(b: BeneficioElegido): string | null {
  if (!b.benefitId) return null
  return b.carnet.replace(/[^A-Za-z0-9]/g, '') ? null : 'Escribí el número de carnet de la empresa'
}


/** Las empresas a las que se puede inscribir a alguien hoy. */
export async function listarBeneficiosActivos(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await db().from('corporate_benefits').select('id, name').eq('active', true).order('name')
  if (error) throw error
  return data ?? []
}

/** Inscribe al cliente con su carnet. La base valida carnet repetido y permisos. */
export async function inscribirEnBeneficio(customerId: string, benefitId: string, carnet: string): Promise<void> {
  const { error } = await db().rpc('benefit_enroll', { p_customer_id: customerId, p_benefit_id: benefitId, p_carnet: carnet })
  if (error) throw new Error(error.message || 'No se pudo inscribir en el beneficio')
}

/** El beneficio activo del cliente, para mostrarlo en su ficha; null si no tiene. */
export async function beneficioDelCliente(customerId: string): Promise<{ name: string; carnet: string } | null> {
  const { data } = await db().from('corporate_benefit_members')
    .select('carnet, corporate_benefits(name)')
    .eq('customer_id', customerId).eq('active', true).maybeSingle()
  return data ? { name: data.corporate_benefits?.name ?? '', carnet: data.carnet } : null
}
