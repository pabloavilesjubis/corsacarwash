/**
 * CORSA — lecturas del servidor de correo (service role).
 *
 * Replica, sin el cliente de Supabase del navegador, lo que la app lee para
 * imprimir: el emisor de la sucursal, el DTE vigente de una factura, su JSON
 * y los datos de la cuenta por cobrar. El servidor no confía en el navegador:
 * todo se filtra por la organización del usuario que pidió el envío.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { findDepartamento, findMunicipio } from '../../src/lib/mh-catalogs'
import { urlConsultaMh } from '../../src/lib/fiscal/consultaMh'
import type { TicketEmisor } from '../../src/lib/ticket/corsaTicket'
import type { DteDeVenta, Sale } from '../../src/services/sales.service'
import type { CxcCliente, DocumentoCxc, LavadoCredito, MovimientoCredito } from '../../src/services/credito.service'

export function admin(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el servidor')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** Usuario externo de la Cuponera Digital (0083): lo marca el service role al crearlo. */
function esDeCuponera(user: { app_metadata?: Record<string, unknown> }): boolean {
  return user.app_metadata?.portal === 'cuponera'
}

/**
 * Quién pide el envío y de qué organización. Sin sesión válida, nada. Un
 * usuario de la Cuponera Digital no pasa por acá aunque tuviera profile: no es
 * personal de CORSA.
 */
export async function usuarioDe(db: SupabaseClient, jwt: string): Promise<{ userId: string; orgId: string }> {
  const { data, error } = await db.auth.getUser(jwt)
  if (error || !data.user) throw Object.assign(new Error('La sesión venció. Volvé a ingresar.'), { status: 401 })
  if (esDeCuponera(data.user)) throw Object.assign(new Error('No autorizado'), { status: 403 })
  const { data: perfil } = await db.from('profiles').select('organization_id').eq('id', data.user.id).maybeSingle()
  if (!perfil?.organization_id) throw Object.assign(new Error('El usuario no pertenece a ninguna organización'), { status: 403 })
  return { userId: data.user.id, orgId: perfil.organization_id as string }
}

/** El mismo cálculo que public.has_permission(), con el service role. */
export async function tienePermiso(db: SupabaseClient, userId: string, codigo: string): Promise<boolean> {
  const [{ data: ur }, { data: perm }] = await Promise.all([
    db.from('user_roles').select('role_id').eq('user_id', userId),
    db.from('permissions').select('id').eq('code', codigo).maybeSingle(),
  ])
  const roles = (ur ?? []).map((r: any) => r.role_id as string)
  if (!perm || roles.length === 0) return false
  const { data: activos } = await db.from('roles').select('id').in('id', roles).eq('active', true)
  const ids = (activos ?? []).map((r: any) => r.id as string)
  if (ids.length === 0) return false
  const { count } = await db.from('role_permissions').select('role_id', { count: 'exact', head: true })
    .in('role_id', ids).eq('permission_id', perm.id)
  return (count ?? 0) > 0
}

/**
 * El usuario de la Cuponera Digital que pide algo: activo, con la cuponera de
 * su cliente activa. Devuelve null si el JWT es de otra clase de usuario.
 */
export async function usuarioCuponera(db: SupabaseClient, jwt: string): Promise<
  { userId: string; orgId: string; customerId: string; nombre: string; correo: string } | null
> {
  const { data, error } = await db.auth.getUser(jwt)
  if (error || !data.user) throw Object.assign(new Error('La sesión venció. Volvé a ingresar.'), { status: 401 })
  const { data: u } = await db.from('cuponera_usuarios')
    .select('user_id, organization_id, customer_id, nombre, correo, activo, cuponera_clientes!inner(activa)')
    .eq('user_id', data.user.id).maybeSingle()
  if (!u) {
    if (esDeCuponera(data.user)) throw Object.assign(new Error('Tu usuario no tiene acceso a la Cuponera Digital'), { status: 403 })
    return null
  }
  if (!u.activo || !(u as any).cuponera_clientes?.activa) {
    throw Object.assign(new Error('Tu usuario no tiene acceso a la Cuponera Digital'), { status: 403 })
  }
  return { userId: u.user_id, orgId: u.organization_id, customerId: u.customer_id, nombre: u.nombre, correo: u.correo }
}

const vacio = (v: unknown) => v == null || String(v).trim() === ''
const nit = (n: string) => { const d = n.replace(/\D/g, ''); return d.length === 14 ? `${d.slice(0, 4)}-${d.slice(4, 10)}-${d.slice(10, 13)}-${d.slice(13)}` : n }
const nrc = (n: string) => { const d = n.replace(/\D/g, ''); return d.length >= 2 ? `${d.slice(0, -1)}-${d.slice(-1)}` : n }

/** El emisor de la sucursal, como lo imprime la app (ver lib/fiscal/emisor). */
export async function emisorDeSucursal(db: SupabaseClient, branchId: string | null): Promise<TicketEmisor> {
  const marca: TicketEmisor = { nombreComercial: 'CORSA CARWASH' }
  if (!branchId) return marca
  const { data: f } = await db.from('fiscal_issuer_config')
    .select('nit, nrc, nombre, nombre_comercial, cod_actividad, desc_actividad, departamento, municipio, complemento, telefono, correo')
    .eq('branch_id', branchId).eq('activo', true).maybeSingle()
  if (!f || vacio(f.nit) || vacio(f.nombre)) return marca
  const dep = f.departamento ? findDepartamento(f.departamento) : undefined
  const mun = dep && f.municipio ? findMunicipio(f.departamento, f.municipio) : undefined
  return {
    nombreComercial: f.nombre_comercial || marca.nombreComercial,
    razonSocial: f.nombre,
    nit: nit(f.nit),
    nrc: f.nrc ? nrc(f.nrc) : undefined,
    direccion: [f.complemento, mun?.nombre, dep?.nombre].filter(Boolean).join(', '),
    telefono: f.telefono ?? undefined,
    correo: f.correo ?? undefined,
    codActividad: f.cod_actividad ?? undefined,
    descActividad: f.desc_actividad ?? undefined,
  }
}

export interface DocumentoVigente {
  id: string
  dte: DteDeVenta
  json: Record<string, unknown> | null
}

/** El DTE vigente de una factura (el sellado si hay), con su JSON completo. */
export async function dteDeFactura(db: SupabaseClient, invoiceId: string): Promise<DocumentoVigente | null> {
  const { data } = await db.from('fiscal_documents')
    .select(COLUMNAS_DOCUMENTO)
    .eq('invoice_id', invoiceId).not('numero_control', 'is', null)
    .order('created_at', { ascending: false })
  const filas = (data ?? []) as any[]
  const d = filas.find(f => f.status === 'ACCEPTED') ?? filas.find(f => f.status === 'INVALIDATED') ?? filas[0]
  return d ? documentoDeFila(d) : null
}

/**
 * Columnas de fiscal_documents que necesita documentoDeFila: el DTE para la
 * factura carta y el JSON completo (firmado y con el sello) para el archivo.
 */
export const COLUMNAS_DOCUMENTO = 'id, dte_type, ambiente, status, numero_control, codigo_generacion, sello_recepcion, json_original, signed_jws, created_at'

export function documentoDeFila(d: any): DocumentoVigente {
  const ident = d.json_original?.identificacion ?? {}
  const sellado = Boolean(d.sello_recepcion) && (d.status === 'ACCEPTED' || d.status === 'INVALIDATED')
  return {
    id: d.id,
    dte: {
      tipoDte: d.dte_type, ambiente: d.ambiente, estado: d.status,
      numeroControl: d.numero_control, codigoGeneracion: d.codigo_generacion,
      selloRecepcion: d.sello_recepcion ?? null,
      fechaEmision: ident.fecEmi ?? null, horaEmision: ident.horEmi ?? null,
      qrUrl: sellado && ident.fecEmi
        ? urlConsultaMh({ ambiente: d.ambiente, codigoGeneracion: d.codigo_generacion, fechaEmi: ident.fecEmi })
        : null,
    } as DteDeVenta,
    json: d.json_original && d.signed_jws
      ? { ...d.json_original, firmaElectronica: d.signed_jws, selloRecibido: d.sello_recepcion ?? null }
      : null,
  }
}

/** La fila de Ventas de una orden (v_sales_history), la misma que imprime la factura carta. */
export async function ventaDeOrden(db: SupabaseClient, orderId: string, orgId: string): Promise<Sale | null> {
  const { data } = await db.from('v_sales_history').select('*').eq('order_id', orderId).eq('organization_id', orgId).maybeSingle()
  return (data as Sale) ?? null
}

/**
 * La «venta» de una factura sin orden propia (CCF consolidado de CxC): la
 * factura carta necesita una, y se arma con las líneas del documento.
 */
export async function ventaDeFacturaConsolidada(db: SupabaseClient, inv: {
  id: string; branch_id: string | null; customer_id: string | null; receptor_customer_id: string | null
  invoice_type: string | null; invoice_number: string | null; subtotal: unknown; tax_amount: unknown; total: unknown; created_at: string
}, orgId: string): Promise<{ sale: Sale; cliente: Cliente | null }> {
  const c = await cliente(db, inv.receptor_customer_id ?? inv.customer_id, orgId)
  const { data: venta } = await db.rpc('fiscal_sale_for_emission', { p_invoice_id: inv.id, p_organization_id: orgId })
  const lineas = ((venta as any)?.lineas ?? []) as { descripcion: string; cantidad: number; precioUni: number }[]
  const sale = {
    order_id: inv.id, organization_id: orgId, branch_id: inv.branch_id, order_number: inv.invoice_number,
    created_at: inv.created_at, status: 'delivered', order_kind: 'service',
    subtotal: Number(inv.subtotal), tax_total: Number(inv.tax_amount), total: Number(inv.total),
    items: lineas.map(l => ({ descripcion: l.descripcion, cantidad: l.cantidad, unitario: Number(l.precioUni), total: Number(l.precioUni) * l.cantidad })),
    customer_name: c?.nombre ?? '', customer_type: c?.customer_type ?? 'company', customer_trade_name: c?.trade_name ?? null,
    customer_nit: c?.nit ?? null, customer_nrc: c?.nrc ?? null, customer_dui: c?.dui ?? null,
    customer_cod_actividad: c?.cod_actividad ?? null, customer_desc_actividad: c?.desc_actividad ?? null,
    customer_phone: c?.phone ?? null, customer_email: c?.correo ?? null,
    customer_departamento: c?.departamento ?? null, customer_municipio: c?.municipio ?? null, customer_direccion: c?.direccion ?? null,
    plate: null, payment_method: 'Crédito', invoice_id: inv.id, invoice_type: inv.invoice_type, invoice_number: inv.invoice_number,
  } as unknown as Sale
  return { sale, cliente: c }
}

export interface Cliente {
  id: string
  nombre: string
  correo: string | null
  customer_type: string
  nit: string | null
  nrc: string | null
  dui: string | null
  cod_actividad: string | null
  desc_actividad: string | null
  phone: string | null
  departamento: string | null
  municipio: string | null
  direccion: string | null
  trade_name: string | null
}

export async function cliente(db: SupabaseClient, id: string | null, orgId: string): Promise<Cliente | null> {
  if (!id) return null
  const { data: c } = await db.from('customers')
    .select('id, customer_type, first_name, last_name, trade_name, legal_name, nit, nrc, dui, email, billing_email, phone, cod_actividad, desc_actividad, fiscal_departamento, fiscal_municipio, fiscal_complemento')
    .eq('id', id).eq('organization_id', orgId).maybeSingle()
  if (!c) return null
  const nombre = c.customer_type === 'company'
    ? (c.legal_name || c.trade_name || 'Cliente')
    : (`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Cliente')
  return {
    id: c.id, nombre, customer_type: c.customer_type,
    correo: (c.billing_email || c.email || '').trim() || null,
    nit: c.nit, nrc: c.nrc, dui: c.dui, cod_actividad: c.cod_actividad, desc_actividad: c.desc_actividad,
    phone: c.phone, departamento: c.fiscal_departamento, municipio: c.fiscal_municipio,
    direccion: c.fiscal_complemento, trade_name: c.trade_name,
  }
}

/** Todo lo que el estado de cuenta necesita de un cliente. */
export async function datosCxc(db: SupabaseClient, customerId: string, orgId: string): Promise<{
  cuenta: CxcCliente | null; documentos: DocumentoCxc[]; movimientos: MovimientoCredito[]; lavados: LavadoCredito[]
}> {
  const num = (r: any, ks: string[]) => { for (const k of ks) if (k in r) r[k] = Number(r[k] ?? 0); return r }
  const [{ data: cta }, { data: docs }, { data: movs }, { data: lav }] = await Promise.all([
    db.from('v_cxc_clientes').select('*').eq('customer_id', customerId).eq('organization_id', orgId).maybeSingle(),
    db.from('accounts_receivable')
      .select('id, created_at, due_date, amount, balance, status, work_orders(order_number), invoices(invoice_number)')
      .eq('customer_id', customerId).eq('organization_id', orgId).neq('status', 'void').order('due_date'),
    db.from('corporate_credit_events')
      .select('id, created_at, event_type, amount, credit_limit, balance_after, reason')
      .eq('customer_id', customerId).eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100),
    db.from('v_lavados_credito').select('*').eq('customer_id', customerId).eq('organization_id', orgId)
      .neq('status', 'cancelled').order('created_at', { ascending: false }).limit(200),
  ])
  return {
    cuenta: cta ? num({ ...cta }, ['credit_limit', 'credit_days', 'saldo', 'disponible', 'por_vencer', 'vencido',
      'vencido_1_30', 'vencido_31_60', 'vencido_61_90', 'vencido_90_mas', 'documentos_abiertos']) as CxcCliente : null,
    documentos: (docs ?? []).map((r: any) => ({
      id: r.id, created_at: r.created_at, due_date: r.due_date, amount: Number(r.amount), balance: Number(r.balance),
      status: r.status, orden: r.work_orders?.order_number ?? null, factura: r.invoices?.invoice_number ?? null,
    })),
    movimientos: (movs ?? []).map((m: any) => ({
      ...m, amount: m.amount != null ? Number(m.amount) : null,
      credit_limit: m.credit_limit != null ? Number(m.credit_limit) : null,
      balance_after: m.balance_after != null ? Number(m.balance_after) : null,
    })),
    lavados: (lav ?? []).map((l: any) => ({ ...l, total: Number(l.total) })),
  }
}

export type TipoEnvio =
  'dte' | 'lavado_credito' | 'ccf_consolidado' | 'estado_cuenta' | 'cierre_caja' | 'cupones' | 'cuponera_acceso'

/** Deja constancia del intento: de acá sale la tarjeta verde/roja de la venta. */
export async function registrarEnvio(db: SupabaseClient, fila: {
  organization_id: string
  tipo: TipoEnvio
  work_order_id?: string | null
  cuponera_entrega_id?: string | null
  cash_session_id?: string | null
  invoice_id?: string | null
  fiscal_document_id?: string | null
  customer_id?: string | null
  destinatarios: string[]
  bcc: string[]
  asunto: string
  status: 'sent' | 'failed'
  error?: string | null
  message_id?: string | null
  created_by: string
}): Promise<void> {
  const { error } = await db.from('envios_correo').insert(fila)
  if (error) console.error('[correo] no se pudo registrar el envío', error.message)
}
