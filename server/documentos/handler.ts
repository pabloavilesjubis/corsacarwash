/**
 * CORSA — /api/documentos
 *
 *   POST { accion: 'lote', ids: uuid[] }   JSON y PDF de hasta 20 DTE (fiscal_documents).
 *
 * Lo usa «Exportar ventas → Documentos» para armar el ZIP de un rango: la app
 * lista los DTE con sales_export_for_accounting y pide los PDF por lotes, para
 * que cada llamada quepa en el tiempo y en el tamaño de respuesta de Vercel.
 *
 * El PDF es la misma factura carta que va en el correo (buildFacturaHTML) y el
 * JSON el mismo adjunto: el DTE con la firma y el sello. Se exige el permiso de
 * Ventas y todo se filtra por la organización del usuario.
 */
import { buildFacturaHTML } from '../../src/lib/fiscal/facturaDocument'
import type { Sale } from '../../src/services/sales.service'
import type { TicketEmisor } from '../../src/lib/ticket/corsaTicket'
import {
  admin, COLUMNAS_DOCUMENTO, documentoDeFila, emisorDeSucursal, tienePermiso, usuarioDe, ventaDeFacturaConsolidada,
} from '../correo/datos'
import { abrirNavegador, htmlAPdf } from '../correo/pdf'

export const MAX_POR_LOTE = 20
/** Pestañas de Chrome a la vez: más no acelera en la CPU de una función. */
const PARALELO = 4

interface Respuesta { status: number; body: Record<string, unknown> }

class ErrorHttp extends Error {
  constructor(public status: number, mensaje: string) { super(mensaje) }
}

interface Archivo { id: string; numero_control: string; json: string | null; pdf: string | null; error?: string }

/** Una venta mínima armada con el propio DTE, para cuando no hay orden ni factura que leer. */
function ventaDesdeDte(json: any, fila: any): Sale {
  const r = json?.receptor ?? {}
  const res = json?.resumen ?? {}
  const items = ((json?.cuerpoDocumento ?? []) as any[]).map(l => {
    const total = Number(l.ventaGravada ?? 0) + Number(l.ventaExenta ?? 0) + Number(l.ventaNoSuj ?? 0)
    return { descripcion: l.descripcion, cantidad: Number(l.cantidad ?? 1), unitario: Number(l.precioUni ?? total), total }
  })
  return {
    order_id: fila.id, order_number: fila.numero_control, created_at: fila.created_at, status: 'delivered', order_kind: 'service',
    subtotal: Number(res.subTotal ?? res.subTotalVentas ?? 0), tax_total: Number(res.totalIva ?? 0),
    total: Number(res.montoTotalOperacion ?? res.totalPagar ?? 0), items,
    customer_name: r.nombre ?? 'Consumidor final', customer_type: r.nrc ? 'company' : 'person',
    customer_nit: r.nit ?? null, customer_nrc: r.nrc ?? null, customer_dui: r.tipoDocumento === '13' ? r.numDocumento : null,
    customer_email: r.correo ?? null, plate: null, payment_method: null,
    invoice_type: fila.dte_type === '03' ? 'credito_fiscal' : 'consumidor_final',
  } as unknown as Sale
}

/** Corre `fn` sobre cada elemento con a lo sumo `n` a la vez. */
async function enParalelo<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]) }
  }))
  return out
}

export async function lote(db: ReturnType<typeof admin>, orgId: string, ids: string[]): Promise<Respuesta> {
  const { data: filas, error } = await db.from('fiscal_documents')
    .select(`${COLUMNAS_DOCUMENTO}, branch_id, invoice_id`)
    .in('id', ids).eq('organization_id', orgId)
    .in('status', ['ACCEPTED', 'INVALIDATED']).not('numero_control', 'is', null)
  if (error) throw new Error(error.message)
  const docs = (filas ?? []) as any[]

  // Las facturas y, de las que tienen orden, la fila de Ventas: de una vez.
  const invIds = [...new Set(docs.map(d => d.invoice_id).filter(Boolean))]
  const { data: invs } = invIds.length
    ? await db.from('invoices')
      .select('id, branch_id, work_order_id, customer_id, receptor_customer_id, invoice_type, invoice_number, subtotal, tax_amount, total, consolidado, created_at')
      .in('id', invIds).eq('organization_id', orgId)
    : { data: [] }
  const facturas = new Map((invs ?? []).map((i: any) => [i.id, i]))
  const ordenIds = (invs ?? []).filter((i: any) => !i.consolidado && i.work_order_id).map((i: any) => i.work_order_id)
  const { data: ventas } = ordenIds.length
    ? await db.from('v_sales_history').select('*').in('order_id', ordenIds).eq('organization_id', orgId)
    : { data: [] }
  const ventaPorOrden = new Map((ventas ?? []).map((v: any) => [v.order_id, v as Sale]))

  const emisores = new Map<string, Promise<TicketEmisor>>()
  const emisor = (branchId: string | null) => {
    const k = branchId ?? ''
    if (!emisores.has(k)) emisores.set(k, emisorDeSucursal(db, branchId))
    return emisores.get(k)!
  }

  const navegador = await abrirNavegador()
  try {
    const archivos = await enParalelo(docs, PARALELO, async (fila): Promise<Archivo> => {
      const doc = documentoDeFila(fila)
      const json = doc.json ? JSON.stringify(doc.json) : null
      try {
        const inv = facturas.get(fila.invoice_id) as any
        let sale: Sale | null = null
        if (inv && !inv.consolidado && inv.work_order_id) sale = ventaPorOrden.get(inv.work_order_id) ?? null
        else if (inv) sale = (await ventaDeFacturaConsolidada(db, inv, orgId)).sale
        if (!sale) sale = ventaDesdeDte(doc.json ?? fila.json_original, fila)
        const pdf = await htmlAPdf(navegador, buildFacturaHTML(sale, await emisor(fila.branch_id), doc.dte))
        return { id: fila.id, numero_control: fila.numero_control, json, pdf: pdf.toString('base64') }
      } catch (e) {
        return { id: fila.id, numero_control: fila.numero_control, json, pdf: null, error: e instanceof Error ? e.message : 'No se pudo generar el PDF' }
      }
    })
    return { status: 200, body: { ok: true, archivos } }
  } finally {
    await navegador.close()
  }
}

export async function manejar(args: { auth: string | undefined; cuerpo: any }): Promise<Respuesta> {
  try {
    const jwt = (args.auth ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!jwt) throw new ErrorHttp(401, 'Falta la sesión')
    const db = admin()
    const { userId, orgId } = await usuarioDe(db, jwt).catch(e => { throw new ErrorHttp(e.status ?? 401, e.message) })
    const [ventas, reportes] = await Promise.all([tienePermiso(db, userId, 'screens.sales'), tienePermiso(db, userId, 'reports.sales')])
    if (!ventas && !reportes) throw new ErrorHttp(403, 'No tenés permiso para descargar documentos de ventas')

    const b = args.cuerpo ?? {}
    const ids = Array.isArray(b.ids) ? b.ids.filter((v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) : []
    if (b.accion !== 'lote' || ids.length === 0 || ids.length !== b.ids.length) throw new ErrorHttp(400, 'Solicitud inválida')
    if (ids.length > MAX_POR_LOTE) throw new ErrorHttp(400, `Máximo ${MAX_POR_LOTE} documentos por lote`)
    return await lote(db, orgId, ids)
  } catch (e) {
    if (e instanceof ErrorHttp) return { status: e.status, body: { ok: false, error: e.message } }
    console.error('[documentos]', e)
    return { status: 500, body: { ok: false, error: e instanceof Error ? e.message : 'Error interno' } }
  }
}
