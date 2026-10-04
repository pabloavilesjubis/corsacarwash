/**
 * CORSA — /api/correo
 *
 *   POST { accion: 'venta', workOrderId }      DTE de una venta, o el agradecimiento
 *                                              del lavado si es al crédito.
 *   POST { accion: 'factura', invoiceId }      DTE de una factura (CCF consolidado).
 *   POST { accion: 'estado_cuenta', customerId }
 *   POST { accion: 'cierre_caja', sessionId }    Reporte de cierre de caja en PDF (0065).
 *
 * Con la sesión del usuario (Authorization: Bearer <JWT de Supabase>); las
 * lecturas van con el service role, filtradas por su organización.
 *
 * DESTINATARIOS (regla de CORSA):
 *   · el cliente tiene correo de facturación → a él, con copia oculta a CORSA;
 *   · no tiene (o es ticket genérico)        → a CORSA;
 *   · siempre, copia oculta a COPIA_TEMPORAL mientras siga en la lista.
 *
 * Cada intento, salga o no, queda en envios_correo (0061).
 */
import nodemailer from 'nodemailer'
import { buildFacturaHTML } from '../../src/lib/fiscal/facturaDocument'
import { estadoCuentaHTML } from '../../src/lib/cxc/estadoCuenta'
import { diaDelTurno, reporteCierreHTML } from '../../src/lib/caja/reporteCierre'
import { normalizarResumen } from '../../src/lib/caja/resumen'
import type { Sale } from '../../src/services/sales.service'
import {
  admin, cliente, datosCxc, dteDeFactura, emisorDeSucursal, registrarEnvio, usuarioDe, ventaDeOrden, type Cliente,
} from './datos'
import { abrirNavegador, htmlAPdf } from './pdf'
import { aviso, boton, esc, fechaSV, fila, layout, money, parrafo, tarjeta } from './plantillas'

/** El buzón de CORSA: recibe lo que no tiene a quién ir, y copia de todo. */
const CORREO_CORSA = 'corsacarwash@gmail.com'
/**
 * Copia oculta en TODO correo saliente, por ahora. Pablo avisa cuándo
 * quitarla: se borra de esta lista.
 */
const COPIA_TEMPORAL = ['pabloavilesjubis@gmail.com']
/**
 * A quién va el reporte de cierre de caja. La copia oculta es COPIA_TEMPORAL:
 * al quitar a alguien de esa lista deja de recibir también los cierres.
 */
const DESTINOS_CIERRE_CAJA = ['jubismauricio@gmail.com']

type Adjunto = { filename: string; content: Buffer | string; contentType: string }

interface Respuesta { status: number; body: Record<string, unknown> }

class ErrorHttp extends Error {
  constructor(public status: number, mensaje: string) { super(mensaje) }
}

function destinos(correoCliente: string | null): { to: string[]; bcc: string[] } {
  const to = correoCliente ? [correoCliente] : [CORREO_CORSA]
  const bcc = [...(correoCliente ? [CORREO_CORSA] : []), ...COPIA_TEMPORAL]
  const vistos = new Set(to.map(t => t.toLowerCase()))
  return { to, bcc: bcc.filter(b => { const k = b.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true }) }
}

function transporte() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) throw new ErrorHttp(500, 'El correo no está configurado en el servidor (SMTP).')
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: String(SMTP_SECURE ?? 'true').toLowerCase() !== 'false',
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  })
}

function remitente(): string {
  const correo = process.env.SMTP_FROM || process.env.SMTP_USER || CORREO_CORSA
  return `"${(process.env.SMTP_FROM_NAME || 'CORSA Carwash').replace(/"/g, '')}" <${correo}>`
}

const TIPO_DTE: Record<string, string> = {
  '01': 'Factura electrónica', '03': 'Comprobante de crédito fiscal', '05': 'Nota de crédito', '14': 'Factura de sujeto excluido',
}

function saludo(c: Cliente | null): string {
  if (!c) return 'Hola'
  const nombre = c.customer_type === 'company' ? (c.trade_name || c.nombre) : c.nombre.split(' ')[0]
  return `Hola, ${esc(nombre)}`
}

function serviciosDe(sale: Sale | null): string[] {
  return (sale?.items ?? []).map(i => String(i.descripcion).replace(/^Aspirado de interiores/, 'Aspirado'))
}

/** Envía y deja constancia. Devuelve el resultado para la pantalla. */
async function enviarYRegistrar(args: {
  db: ReturnType<typeof admin>
  orgId: string
  userId: string
  tipo: 'dte' | 'lavado_credito' | 'ccf_consolidado' | 'estado_cuenta' | 'cierre_caja'
  correoCliente: string | null
  /** Destinatarios fijos en lugar de la regla del cliente (cierre de caja). */
  destinos?: { to: string[]; bcc: string[] }
  asunto: string
  html: string
  adjuntos: Adjunto[]
  workOrderId?: string | null
  invoiceId?: string | null
  fiscalDocumentId?: string | null
  customerId?: string | null
  cashSessionId?: string | null
}): Promise<Respuesta> {
  const { to, bcc } = args.destinos ?? destinos(args.correoCliente)
  try {
    const info = await transporte().sendMail({
      from: remitente(), to, bcc, subject: args.asunto, html: args.html,
      attachments: args.adjuntos.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    })
    await registrarEnvio(args.db, {
      organization_id: args.orgId, tipo: args.tipo, work_order_id: args.workOrderId ?? null, invoice_id: args.invoiceId ?? null,
      fiscal_document_id: args.fiscalDocumentId ?? null, customer_id: args.customerId ?? null, cash_session_id: args.cashSessionId ?? null,
      destinatarios: to, bcc, asunto: args.asunto, status: 'sent', message_id: info.messageId ?? null, created_by: args.userId,
    })
    return { status: 200, body: { ok: true, estado: 'sent', destinatarios: to } }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await registrarEnvio(args.db, {
      organization_id: args.orgId, tipo: args.tipo, work_order_id: args.workOrderId ?? null, invoice_id: args.invoiceId ?? null,
      fiscal_document_id: args.fiscalDocumentId ?? null, customer_id: args.customerId ?? null, cash_session_id: args.cashSessionId ?? null,
      destinatarios: to, bcc, asunto: args.asunto, status: 'failed', error: error.slice(0, 500), created_by: args.userId,
    })
    return { status: 502, body: { ok: false, estado: 'failed', error: `No se pudo enviar el correo: ${error}` } }
  }
}

// ─── Acciones ────────────────────────────────────────────────

async function correoDeVenta(db: ReturnType<typeof admin>, orgId: string, userId: string, appUrl: string, workOrderId: string): Promise<Respuesta> {
  const { data: wo } = await db.from('work_orders')
    .select('id, organization_id, branch_id, customer_id, status, facturacion_diferida, created_at, order_number')
    .eq('id', workOrderId).eq('organization_id', orgId).maybeSingle()
  if (!wo) throw new ErrorHttp(404, 'No existe esa venta')
  if (wo.status === 'cancelled') throw new ErrorHttp(409, 'La venta está anulada')

  const sale = await ventaDeOrden(db, workOrderId, orgId)
  const { data: inv } = await db.from('invoices').select('id, receptor_customer_id, customer_id, status')
    .eq('work_order_id', workOrderId).neq('status', 'voided').maybeSingle()
  const doc = inv ? await dteDeFactura(db, inv.id) : null
  const sellado = doc?.dte.estado === 'ACCEPTED'
  const { count: deudas } = await db.from('accounts_receivable').select('id', { count: 'exact', head: true }).eq('work_order_id', workOrderId)
  const alCredito = Boolean(wo.facturacion_diferida) || (deudas ?? 0) > 0

  if (!alCredito && !sellado) {
    throw new ErrorHttp(409, 'La venta todavía no tiene su DTE sellado por Hacienda: el correo sale cuando se sella.')
  }

  const emisor = await emisorDeSucursal(db, wo.branch_id)
  const navegador = await abrirNavegador()
  try {
    const adjuntos: Adjunto[] = []
    if (sellado && sale && doc) {
      const nombre = doc.dte.numeroControl ?? `dte-${wo.order_number}`
      adjuntos.push({ filename: `${nombre}.pdf`, content: await htmlAPdf(navegador, buildFacturaHTML(sale, emisor, doc.dte)), contentType: 'application/pdf' })
      if (doc.json) adjuntos.push({ filename: `${nombre}.json`, content: JSON.stringify(doc.json, null, 2), contentType: 'application/json' })
    }

    const placa = sale?.plate ?? ''
    const servicios = serviciosDe(sale)

    if (alCredito) {
      // El dueño de la cuenta: a él se le agradece y se le manda su historial.
      const c = await cliente(db, wo.customer_id, orgId)
      const cxc = await datosCxc(db, wo.customer_id, orgId)
      if (cxc.cuenta) {
        adjuntos.push({
          filename: `estado-de-cuenta-${new Date().toISOString().slice(0, 10)}.pdf`,
          content: await htmlAPdf(navegador, estadoCuentaHTML({ emisor, cliente: cxc.cuenta, documentos: cxc.documentos, movimientos: cxc.movimientos, lavados: cxc.lavados })),
          contentType: 'application/pdf',
        })
      }
      const facturado = sellado && doc
        ? aviso(`<strong>Facturado.</strong> Este servicio va en tu ${esc(TIPO_DTE[doc.dte.tipoDte] ?? 'DTE')} <strong>${esc(doc.dte.numeroControl)}</strong>, adjunto en PDF y JSON.`)
        : aviso('<strong>Pendiente de facturar.</strong> Este lavado quedó cargado a tu cuenta y se incluye en tu próximo CCF consolidado.', 'ambar')
      const html = layout({
        appUrl, emisor,
        preheader: `Gracias por lavar tu carro ${placa} en CORSA.`,
        titulo: '¡Gracias por tu visita!',
        cuerpo: parrafo(`${saludo(c)}: gracias por confiar en CORSA Carwash. Hoy dejamos listo tu carro${placa ? ` placa <strong>${esc(placa)}</strong>` : ''}.`)
          + tarjeta('Tu lavado', [
            fila('Fecha', esc(fechaSV(wo.created_at, true))),
            ...(placa ? [fila('Placa', `<strong>${esc(placa)}</strong>`)] : []),
            fila('Servicio', esc(servicios.join(' + ') || 'Lavado')),
            fila('Total del servicio', money(Number(sale?.total ?? 0)), true),
          ].join(''))
          + facturado
          + (cxc.cuenta ? tarjeta('Tu cuenta a la fecha', [
            fila('Saldo acumulado', money(cxc.cuenta.saldo), true),
            fila('Por vencer', money(cxc.cuenta.por_vencer)),
            ...(cxc.cuenta.vencido > 0 ? [fila('Vencido', `<span style="color:#C2272D;font-weight:700">${money(cxc.cuenta.vencido)}</span>`)] : []),
            fila('Crédito disponible', money(cxc.cuenta.disponible)),
            ...(cxc.lavados.some(l => !l.consolidated_invoice_id)
              ? [fila('Lavados pendientes de facturar', String(cxc.lavados.filter(l => !l.consolidated_invoice_id).length))] : []),
          ].join('')) : '')
          + parrafo('Adjuntamos tu estado de cuenta con el historial de servicios. ¡Te esperamos pronto!'),
      })
      return enviarYRegistrar({
        db, orgId, userId, tipo: 'lavado_credito', correoCliente: c?.correo ?? null,
        asunto: `Gracias por tu visita a CORSA${placa ? ` · ${placa}` : ''}`, html, adjuntos,
        workOrderId, invoiceId: inv?.id ?? null, fiscalDocumentId: doc?.id ?? null, customerId: wo.customer_id,
      })
    }

    // Contado con DTE: el comprobante, a quien se le emitió (o a CORSA si fue genérico).
    const receptor = await cliente(db, inv?.receptor_customer_id ?? null, orgId)
    const tipo = TIPO_DTE[doc!.dte.tipoDte] ?? 'Documento tributario electrónico'
    const html = layout({
      appUrl, emisor,
      preheader: `${tipo} ${doc!.dte.numeroControl} · ${money(Number(sale?.total ?? 0))}`,
      titulo: `Tu ${tipo.toLowerCase()}`,
      cuerpo: parrafo(`${saludo(receptor)}: gracias por tu visita a CORSA Carwash. Adjuntamos tu documento tributario electrónico en PDF y su archivo JSON.`)
        + tarjeta('Documento', [
          fila('Tipo', esc(tipo)),
          fila('Número de control', `<span style="font-family:monospace">${esc(doc!.dte.numeroControl)}</span>`),
          fila('Código de generación', `<span style="font-family:monospace;font-size:11.5px">${esc(doc!.dte.codigoGeneracion)}</span>`),
          fila('Fecha', esc(fechaSV(wo.created_at, true))),
          ...(placa ? [fila('Placa', `<strong>${esc(placa)}</strong>`)] : []),
          fila('Servicio', esc(servicios.join(' + ') || 'Lavado')),
          fila('Total', money(Number(sale?.total ?? 0)), true),
        ].join(''))
        + (doc!.dte.qrUrl ? parrafo(boton('Verificar en Hacienda', doc!.dte.qrUrl)) : ''),
    })
    return enviarYRegistrar({
      db, orgId, userId, tipo: 'dte', correoCliente: receptor?.correo ?? null,
      asunto: `${tipo} CORSA Carwash · ${doc!.dte.numeroControl}`, html, adjuntos,
      workOrderId, invoiceId: inv?.id ?? null, fiscalDocumentId: doc?.id ?? null, customerId: receptor?.id ?? null,
    })
  } finally {
    await navegador.close()
  }
}

async function correoDeFactura(db: ReturnType<typeof admin>, orgId: string, userId: string, appUrl: string, invoiceId: string): Promise<Respuesta> {
  const { data: inv } = await db.from('invoices')
    .select('id, organization_id, branch_id, work_order_id, customer_id, receptor_customer_id, invoice_type, invoice_number, subtotal, tax_amount, total, consolidado, created_at, status')
    .eq('id', invoiceId).eq('organization_id', orgId).maybeSingle()
  if (!inv) throw new ErrorHttp(404, 'No existe esa factura')
  if (!inv.consolidado && inv.work_order_id) return correoDeVenta(db, orgId, userId, appUrl, inv.work_order_id)

  const doc = await dteDeFactura(db, invoiceId)
  if (doc?.dte.estado !== 'ACCEPTED') throw new ErrorHttp(409, 'El CCF todavía no está sellado por Hacienda')

  const c = await cliente(db, inv.receptor_customer_id ?? inv.customer_id, orgId)
  const { data: venta } = await db.rpc('fiscal_sale_for_emission', { p_invoice_id: invoiceId, p_organization_id: orgId })
  const lineas = ((venta as any)?.lineas ?? []) as { descripcion: string; cantidad: number; precioUni: number }[]
  // La factura carta necesita una «venta»: la consolidada se arma con sus líneas.
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

  const emisor = await emisorDeSucursal(db, inv.branch_id)
  const navegador = await abrirNavegador()
  try {
    const nombre = doc.dte.numeroControl ?? inv.invoice_number
    const adjuntos: Adjunto[] = [
      { filename: `${nombre}.pdf`, content: await htmlAPdf(navegador, buildFacturaHTML(sale, emisor, doc.dte)), contentType: 'application/pdf' },
      ...(doc.json ? [{ filename: `${nombre}.json`, content: JSON.stringify(doc.json, null, 2), contentType: 'application/json' }] : []),
    ]
    const html = layout({
      appUrl, emisor,
      preheader: `CCF consolidado ${doc.dte.numeroControl} · ${lineas.length} lavados · ${money(Number(inv.total))}`,
      titulo: 'Tu comprobante de crédito fiscal',
      cuerpo: parrafo(`${saludo(c)}: adjuntamos el CCF consolidado de tus lavados, con el detalle de cada placa, en PDF y su archivo JSON.`)
        + tarjeta('Documento', [
          fila('Número de control', `<span style="font-family:monospace">${esc(doc.dte.numeroControl)}</span>`),
          fila('Código de generación', `<span style="font-family:monospace;font-size:11.5px">${esc(doc.dte.codigoGeneracion)}</span>`),
          fila('Lavados facturados', String(lineas.length)),
          fila('Total', money(Number(inv.total)), true),
        ].join(''))
        + (doc.dte.qrUrl ? parrafo(boton('Verificar en Hacienda', doc.dte.qrUrl)) : '')
        + parrafo('¡Gracias por seguir confiando en CORSA Carwash!'),
    })
    return enviarYRegistrar({
      db, orgId, userId, tipo: 'ccf_consolidado', correoCliente: c?.correo ?? null,
      asunto: `CCF consolidado CORSA Carwash · ${doc.dte.numeroControl}`, html, adjuntos,
      invoiceId, fiscalDocumentId: doc.id, customerId: c?.id ?? null,
    })
  } finally {
    await navegador.close()
  }
}

async function correoEstadoCuenta(db: ReturnType<typeof admin>, orgId: string, userId: string, appUrl: string, customerId: string): Promise<Respuesta> {
  const c = await cliente(db, customerId, orgId)
  if (!c) throw new ErrorHttp(404, 'No existe ese cliente')
  const cxc = await datosCxc(db, customerId, orgId)
  if (!cxc.cuenta) throw new ErrorHttp(409, 'El cliente no tiene cuenta de crédito')
  const { data: ultimaSucursal } = await db.from('work_orders').select('branch_id').eq('customer_id', customerId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const emisor = await emisorDeSucursal(db, ultimaSucursal?.branch_id ?? null)
  const navegador = await abrirNavegador()
  try {
    const pdf = await htmlAPdf(navegador, estadoCuentaHTML({ emisor, cliente: cxc.cuenta, documentos: cxc.documentos, movimientos: cxc.movimientos, lavados: cxc.lavados }))
    const cta = cxc.cuenta
    const pendientes = cxc.lavados.filter(l => !l.consolidated_invoice_id).length
    const html = layout({
      appUrl, emisor,
      preheader: `Saldo a la fecha ${money(cta.saldo)}`,
      titulo: 'Tu estado de cuenta',
      cuerpo: parrafo(`${saludo(c)}: gracias por ser cliente de CORSA Carwash. Te compartimos tu estado de cuenta al ${esc(fechaSV(new Date()))}.`)
        + tarjeta('Resumen', [
          fila('Saldo total', money(cta.saldo), true),
          fila('Por vencer', money(cta.por_vencer)),
          fila('Vencido', cta.vencido > 0 ? `<span style="color:#C2272D;font-weight:700">${money(cta.vencido)}</span>` : money(0)),
          fila('Crédito disponible', money(cta.disponible)),
          ...(pendientes ? [fila('Lavados pendientes de facturar', String(pendientes))] : []),
        ].join(''))
        + (cta.vencido > 0 ? aviso('Tienes saldo vencido. Si ya realizaste el pago, por favor compártenos el comprobante.', 'ambar') : '')
        + parrafo('El detalle de documentos, lavados y abonos va en el PDF adjunto.'),
    })
    return enviarYRegistrar({
      db, orgId, userId, tipo: 'estado_cuenta', correoCliente: c.correo,
      asunto: `Estado de cuenta CORSA Carwash · ${fechaSV(new Date())}`, html,
      adjuntos: [{ filename: `estado-de-cuenta-${new Date().toISOString().slice(0, 10)}.pdf`, content: pdf, contentType: 'application/pdf' }],
      customerId,
    })
  } finally {
    await navegador.close()
  }
}

async function correoCierreCaja(db: ReturnType<typeof admin>, orgId: string, userId: string, appUrl: string, sessionId: string): Promise<Respuesta> {
  const { data, error } = await db.rpc('caja_resumen_datos', { p_session_id: sessionId })
  if (error || !data) throw new ErrorHttp(404, 'No existe ese turno de caja')
  if ((data as any).organization_id !== orgId) throw new ErrorHttp(404, 'No existe ese turno de caja')
  // El cerrado se reporta con su foto del cierre, igual que en la pantalla.
  const { data: s } = await db.from('cash_sessions').select('resumen').eq('id', sessionId).maybeSingle()
  const r = normalizarResumen((s as any)?.resumen ?? data)
  const emisor = await emisorDeSucursal(db, r.branch_id)
  const dia = diaDelTurno(r.abierta_at)
  const navegador = await abrirNavegador()
  try {
    const pdf = await htmlAPdf(navegador, reporteCierreHTML({ emisor, resumen: r }))
    const retiros = r.movimientos.filter(m => m.tipo === 'cash_out')
    const html = layout({
      appUrl, emisor,
      preheader: `${r.sucursal} · ventas ${money(r.ventas.total)} · queda en caja ${money(r.efectivo_final)}`,
      titulo: 'Cierre de caja',
      cuerpo: parrafo(`Cierre de caja de <strong>${esc(r.sucursal)}</strong>, ${esc(dia)}. Cerró ${esc(r.cerro ?? '—')}.`)
        + tarjeta('Ventas', [
          fila('Efectivo', money(r.ventas.efectivo)),
          fila('Tarjeta', money(r.ventas.tarjeta)),
          fila('Transferencia', money(r.ventas.transferencia)),
          ...(r.ventas.otros > 0 ? [fila('Otros', money(r.ventas.otros))] : []),
          fila(`Total (${r.ventas.cantidad} ventas)`, money(r.ventas.total), true),
        ].join(''))
        + tarjeta('Efectivo', [
          fila('Efectivo inicial', money(r.efectivo_inicial)),
          fila('Ingresos en efectivo', money(r.ingresos_efectivo)),
          fila(`Retiros (${retiros.length})`, money(r.egresos_efectivo)),
          fila('Remesa', money(r.remesa)),
          fila('Efectivo final en caja', money(r.efectivo_final), true),
        ].join(''))
        + (retiros.length
          ? tarjeta('Retiros de efectivo', retiros.map(m =>
              fila(`${esc(m.motivo)} · autorizó ${esc(m.autorizo ?? '—')}`, money(m.monto))).join(''))
          : '')
        + parrafo('El reporte completo va en el PDF adjunto.'),
    })
    return enviarYRegistrar({
      db, orgId, userId, tipo: 'cierre_caja', correoCliente: null,
      destinos: { to: DESTINOS_CIERRE_CAJA, bcc: COPIA_TEMPORAL.filter(c => !DESTINOS_CIERRE_CAJA.includes(c)) },
      asunto: `Cierre de caja · ${r.sucursal} · ${dia}`, html,
      adjuntos: [{ filename: `cierre-de-caja-${r.abierta_at.slice(0, 10)}.pdf`, content: pdf, contentType: 'application/pdf' }],
      cashSessionId: sessionId,
    })
  } finally {
    await navegador.close()
  }
}

// ─── Entrada ─────────────────────────────────────────────────

export async function manejar(args: { auth: string | undefined; cuerpo: any; appUrl: string }): Promise<Respuesta> {
  try {
    const jwt = (args.auth ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!jwt) throw new ErrorHttp(401, 'Falta la sesión')
    const db = admin()
    const { userId, orgId } = await usuarioDe(db, jwt).catch(e => { throw new ErrorHttp(e.status ?? 401, e.message) })
    const b = args.cuerpo ?? {}
    const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)
    if (b.accion === 'venta' && uuid(b.workOrderId)) return await correoDeVenta(db, orgId, userId, args.appUrl, b.workOrderId)
    if (b.accion === 'factura' && uuid(b.invoiceId)) return await correoDeFactura(db, orgId, userId, args.appUrl, b.invoiceId)
    if (b.accion === 'estado_cuenta' && uuid(b.customerId)) return await correoEstadoCuenta(db, orgId, userId, args.appUrl, b.customerId)
    if (b.accion === 'cierre_caja' && uuid(b.sessionId)) return await correoCierreCaja(db, orgId, userId, args.appUrl, b.sessionId)
    throw new ErrorHttp(400, 'Solicitud inválida')
  } catch (e) {
    if (e instanceof ErrorHttp) return { status: e.status, body: { ok: false, error: e.message } }
    console.error('[correo]', e)
    return { status: 500, body: { ok: false, error: e instanceof Error ? e.message : 'Error interno' } }
  }
}
