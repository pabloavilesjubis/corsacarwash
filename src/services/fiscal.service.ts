/**
 * CORSA Carwash — Contabilidad fiscal
 *
 * DOS CAMINOS, A PROPÓSITO
 *   Leer   → Supabase directo, con RLS. El historial, las invalidaciones, los
 *            correlativos y la configuración fiscal se leen como cualquier
 *            otra tabla de la organización.
 *   Emitir → el Worker fiscal (corsa-fiscal-api), con el JWT de la sesión.
 *            Firmar exige la llave privada y hablar con Hacienda exige sus
 *            credenciales; ninguna de las dos puede vivir en el navegador. El
 *            Worker valida el JWT y el permiso contra la base, y saca la
 *            organización de la sesión — no de lo que mande esta pantalla.
 *
 * Sembrar correlativos es la excepción: va por RPC directo a Supabase porque
 * no firma ni transmite nada, y la RPC verifica fiscal.seed por su cuenta.
 */

import { supabase } from '../lib/supabase'

const URL_FISCAL = (import.meta.env.VITE_FISCAL_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

// ─── Tipos ───────────────────────────────────────────────────

export type TipoDte = '01' | '03' | '05' | '14'
export type Ambiente = '00' | '01'

export const NOMBRE_TIPO: Record<string, string> = {
  '01': 'Factura de Consumidor Final',
  '03': 'Comprobante de Crédito Fiscal',
  '05': 'Nota de Crédito',
  '14': 'Sujeto Excluido',
}

export const NOMBRE_CORTO_TIPO: Record<string, string> = {
  '01': 'FCF', '03': 'CCF', '05': 'NC', '14': 'FSEE',
}

export type EstadoFiscal =
  | 'CREATED' | 'VALIDATED' | 'SIGNED' | 'SUBMITTED' | 'ACCEPTED'
  | 'REJECTED' | 'RETRY_PENDING' | 'CONTINGENCY' | 'INVALIDATED'

export const ESTADO_ETIQUETA: Record<string, string> = {
  CREATED: 'Sin transmitir',
  VALIDATED: 'Validado',
  SIGNED: 'Firmado',
  SUBMITTED: 'Enviado',
  ACCEPTED: 'Aceptado',
  REJECTED: 'Rechazado',
  RETRY_PENDING: 'Pendiente',
  CONTINGENCY: 'Contingencia',
  INVALIDATED: 'Invalidado',
}

export const ESTADO_CLASE: Record<string, string> = {
  ACCEPTED: 'badge-success',
  REJECTED: 'badge-danger',
  INVALIDATED: 'badge-neutral',
  RETRY_PENDING: 'badge-warning',
  CREATED: 'badge-warning',
  SIGNED: 'badge-warning',
  SUBMITTED: 'badge-warning',
  CONTINGENCY: 'badge-warning',
}

/** Una fila de v_fiscal_documents. */
export interface DocumentoFiscal {
  id: string
  organization_id: string
  branch_id: string | null
  ambiente: Ambiente
  dte_type: TipoDte
  status: EstadoFiscal
  correlative: number
  numero_control: string
  codigo_generacion: string
  sello_recepcion: string | null
  invoice_id: string | null
  customer_id: string | null
  attempt_count: number
  last_error: string | null
  created_at: string
  accepted_at: string | null
  rejected_at: string | null
  invalidated_at: string | null
  firmado: boolean
  fecha_emision: string | null
  contraparte_nombre: string | null
  contraparte_documento: string | null
  monto_total: number | null
  documentos_relacionados: { tipoDocumento: string; numeroDocumento: string; fechaEmision: string }[] | null
  creado_por: string | null
}

export interface Invalidacion {
  id: string
  fiscal_document_id: string
  replacement_document_id: string | null
  ambiente: Ambiente
  codigo_generacion: string
  tipo_anulacion: 1 | 2 | 3
  motivo: string | null
  status: 'CREATED' | 'SIGNED' | 'ACCEPTED' | 'REJECTED' | 'RETRY_PENDING'
  sello_recepcion: string | null
  attempt_count: number
  last_error: string | null
  created_by: string | null
  created_at: string
  accepted_at: string | null
  json_original: Record<string, any> | null
  documento: Pick<DocumentoFiscal, 'numero_control' | 'dte_type' | 'codigo_generacion'> | null
}

export const TIPO_ANULACION_ETIQUETA: Record<number, string> = {
  1: 'Error en la información',
  2: 'Rescisión de la operación',
  3: 'Otro motivo',
}

export interface Correlativo {
  id: string
  ambiente: Ambiente
  dte_type: TipoDte
  establishment_code: string
  pos_code: string
  seeded: boolean
  seeded_at: string | null
  seeded_by: string | null
  last_minted: number
  updated_at: string
}

export interface ConfigFiscal {
  id: string
  branch_id: string
  nit: string
  nrc: string
  nombre: string
  nombre_comercial: string | null
  telefono: string | null
  correo: string
  cod_estable: string
  cod_punto_venta: string
  activo: boolean
}

// ─── Lecturas ────────────────────────────────────────────────

export async function fetchDocumentos(f: {
  tipos: TipoDte[]
  ambiente: Ambiente
  estados?: EstadoFiscal[]
  buscar?: string
  limite?: number
}): Promise<DocumentoFiscal[]> {
  let q = (supabase as any)
    .from('v_fiscal_documents')
    .select('*')
    .in('dte_type', f.tipos)
    .eq('ambiente', f.ambiente)
    .order('created_at', { ascending: false })
    .limit(f.limite ?? 300)
  if (f.estados?.length) q = q.in('status', f.estados)
  const termino = f.buscar?.trim()
  if (termino) {
    // Coma, paréntesis, comillas y barra rompen la sintaxis de `or` de
    // PostgREST; % _ * actuarían como comodines. Ninguno aparece en un número
    // de control, un código de generación, un NIT ni un nombre que se busque.
    const s = termino.replace(/[,()"\\%_*]/g, ' ').trim()
    q = q.or(`numero_control.ilike.%${s}%,codigo_generacion.ilike.%${s}%,` +
             `contraparte_nombre.ilike.%${s}%,contraparte_documento.ilike.%${s}%`)
  }
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as DocumentoFiscal[]
}

export async function fetchInvalidaciones(ambiente: Ambiente): Promise<Invalidacion[]> {
  const { data, error } = await (supabase as any)
    .from('fiscal_invalidations')
    .select('*, documento:fiscal_documents!fiscal_invalidations_fiscal_document_id_fkey(numero_control, dte_type, codigo_generacion)')
    .eq('ambiente', ambiente)
    .order('created_at', { ascending: false })
    .limit(300)
  if (error) throw error
  return (data ?? []) as Invalidacion[]
}

export async function fetchCorrelativos(): Promise<Correlativo[]> {
  const { data, error } = await (supabase as any)
    .from('fiscal_correlatives')
    .select('*')
    .order('dte_type')
  if (error) throw error
  return (data ?? []) as Correlativo[]
}

export async function fetchConfigFiscal(): Promise<ConfigFiscal[]> {
  const { data, error } = await (supabase as any)
    .from('fiscal_issuer_config')
    .select('id, branch_id, nit, nrc, nombre, nombre_comercial, telefono, correo, cod_estable, cod_punto_venta, activo')
  if (error) throw error
  return (data ?? []) as ConfigFiscal[]
}

/** Sube, nunca baja: la base rechaza un número menor al actual. */
export async function sembrarCorrelativo(args: {
  branchId: string
  ambiente: Ambiente
  tipo: TipoDte
  ultimoEmitido: number
}): Promise<Correlativo> {
  const { data, error } = await (supabase as any).rpc('fiscal_seed_correlative_app', {
    p_branch_id: args.branchId,
    p_ambiente: args.ambiente,
    p_dte_type: args.tipo,
    p_last_issued: args.ultimoEmitido,
  })
  if (error) throw new Error(error.message)
  return data as Correlativo
}

// ─── El Worker fiscal ────────────────────────────────────────

export interface EstadoServicio {
  disponible: boolean
  /** Ambiente al que transmite el Worker. Es el que se muestra y se filtra. */
  ambiente: Ambiente
  mensaje?: string
}

/** Pregunta al Worker contra qué ambiente de Hacienda está emitiendo. */
export async function fetchEstadoServicio(): Promise<EstadoServicio> {
  if (!URL_FISCAL) {
    return { disponible: false, ambiente: '00',
      mensaje: 'Falta VITE_FISCAL_API_URL: la app no sabe dónde está el servicio fiscal.' }
  }
  try {
    const res = await fetch(`${URL_FISCAL}/health`)
    const cuerpo = await res.json()
    return { disponible: res.ok, ambiente: cuerpo.mh === 'production' ? '01' : '00' }
  } catch {
    return { disponible: false, ambiente: '00', mensaje: 'El servicio fiscal no responde.' }
  }
}

/** Lo que devuelve el Worker al emitir, invalidar o reintentar. */
export interface ResultadoFiscal {
  ok: boolean
  estado: string
  mensaje?: string
  reintentable?: boolean
  yaExistia?: boolean
  documentoId?: string
  invalidacionId?: string
  numeroControl?: string | null
  codigoGeneracion?: string | null
  selloRecepcion?: string | null
  /** El documento ya tiene JWS: su contenido quedó fijo. */
  firmado?: boolean
}

export class ErrorFiscal extends Error {
  readonly codigo: string
  readonly problemas: { campo: string; mensaje: string }[]
  constructor(mensaje: string, codigo: string, problemas: { campo: string; mensaje: string }[] = []) {
    super(mensaje)
    this.name = 'ErrorFiscal'
    this.codigo = codigo
    this.problemas = problemas
  }
}

async function llamarWorker(ruta: string, cuerpo: unknown): Promise<ResultadoFiscal> {
  if (!URL_FISCAL) {
    throw new ErrorFiscal('Falta VITE_FISCAL_API_URL en la configuración de la app.', 'SIN_CONFIGURAR')
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new ErrorFiscal('La sesión venció. Volvé a ingresar.', 'SESION_INVALIDA')

  let res: Response
  try {
    res = await fetch(`${URL_FISCAL}${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(cuerpo),
    })
  } catch {
    throw new ErrorFiscal(
      'No se pudo contactar al servicio fiscal. Revisá la conexión y volvé a intentar: ' +
      'el mismo formulario no genera un documento duplicado.', 'SIN_CONEXION')
  }

  const json = await res.json().catch(() => ({}))
  // 200 aceptado, 202 cualquier otro desenlace ya guardado (pendiente,
  // rechazado). Los dos traen `estado`; el resto es un error de la solicitud.
  if (res.status === 200 || res.status === 202) return json as ResultadoFiscal
  throw new ErrorFiscal(json.mensaje ?? `El servicio fiscal respondió ${res.status}`,
    json.error ?? 'ERROR', json.problemas ?? [])
}

export interface Direccion { departamento: string; municipio: string; complemento: string }

export interface SolicitudSujetoExcluido {
  idempotencyKey: string
  branchId: string
  sujetoExcluido: {
    tipoDocumento: string
    numDocumento: string
    nombre: string
    codActividad: string | null
    descActividad: string | null
    direccion: Direccion
    telefono: string | null
    correo: string | null
  }
  lineas: { descripcion: string; cantidad: number; precioUni: number; tipoItem?: 1 | 2 | 3 }[]
  reglasDeRetencion: { tipo: 'renta' | 'iva'; tasa: number }[]
  condicionOperacion: 1 | 2
  observaciones: string | null
}

export const emitirSujetoExcluido = (s: SolicitudSujetoExcluido) => llamarWorker('/v1/app/fsee', s)

export interface SolicitudNotaCredito {
  idempotencyKey: string
  branchId: string
  customerId: string | null
  receptor: {
    nit: string; nrc: string; nombre: string
    codActividad: string; descActividad: string; nombreComercial: string | null
    direccion: Direccion; telefono: string | null; correo: string
  }
  documentosRelacionados: { tipoDocumento: '03' | '07'; tipoGeneracion: 1 | 2; numeroDocumento: string; fechaEmision: string }[]
  lineas: {
    descripcion: string; cantidad: number; precioUni: number; numeroDocumento: string
    tipoVenta: 'gravada' | 'exenta' | 'nosujeta'
  }[]
  condicionOperacion: 1 | 2
}

export const emitirNotaCredito = (s: SolicitudNotaCredito) => llamarWorker('/v1/app/nota-credito', s)

export interface Persona { nombre: string; tipoDocumento: string; numDocumento: string }

export interface SolicitudInvalidacion {
  idempotencyKey: string
  documentoId: string
  tipoAnulacion: 1 | 2 | 3
  motivoAnulacion: string | null
  documentoReemplazoId: string | null
  receptor: (Persona & { telefono?: string | null; correo?: string | null }) | null
  responsable: Persona
  solicitante: Persona
}

export const invalidar = (s: SolicitudInvalidacion) => llamarWorker('/v1/app/invalidacion', s)

export const reintentarDocumento = (documentoId: string) =>
  llamarWorker('/v1/app/reintentar', { documentoId })

export const reintentarInvalidacion = (invalidacionId: string) =>
  llamarWorker('/v1/app/reintentar', { invalidacionId })

// ─── Utilidades de pantalla ──────────────────────────────────

/**
 * ¿El documento identifica a su contraparte? Si no (FCF de mostrador), el
 * formulario de invalidación tiene que pedirla: Hacienda la exige.
 */
export function tieneContraparte(doc: DocumentoFiscal): boolean {
  // El evento de invalidación exige un nombre de al menos 5 caracteres.
  return (doc.contraparte_nombre?.length ?? 0) >= 5 && !!doc.contraparte_documento
}

/**
 * ¿Quedó en duda si el envío llegó? Sin conexión, o el servicio no pudo
 * contestar: puede que el documento se haya emitido igual. Un error de
 * validación (422) no entra: se frenó antes de reservar nada.
 */
export function resultadoIncierto(e: unknown): boolean {
  const codigo = (e as ErrorFiscal)?.codigo
  return codigo === 'SIN_CONEXION' || codigo === 'BASE_NO_DISPONIBLE' ||
         codigo === 'MH_NO_DISPONIBLE' || codigo === 'ERROR_INTERNO' || codigo === 'ERROR'
}

/** El número que tendrá el próximo documento de una secuencia. */
export function proximoNumeroControl(tipo: string, estable: string, pv: string, ultimo: number): string {
  return `DTE-${tipo}-${estable}${pv}-${String(ultimo + 1).padStart(15, '0')}`
}

export function dinero(n: number | null | undefined): string {
  return n == null ? '—' : 'US$' + Number(n).toFixed(2)
}
