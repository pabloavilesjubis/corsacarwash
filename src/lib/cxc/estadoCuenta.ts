/**
 * CORSA — estado de cuenta de un cliente con crédito (0058).
 *
 * Un documento tamaño carta con la marca: datos del cliente, resumen del
 * crédito, antigüedad del saldo, documentos pendientes y los movimientos
 * recientes. Se arma como HTML y se imprime o se guarda como PDF desde el
 * diálogo del navegador, igual que la factura carta.
 *
 * `estadoCuentaHTML` devuelve el documento solo, para quien lo quiera enviar
 * por otro medio (correo) sin pasar por la ventana de impresión.
 */
import { LOGO_PATH, LOGO_VIEWBOX } from '../../brand/logoCompleto'
import type { TicketEmisor } from '../ticket/corsaTicket'
import type { CxcCliente, DocumentoCxc, LavadoCredito, MovimientoCredito } from '../../services/credito.service'
import { EVENTO_ETIQUETA } from './eventos'

const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fecha = (iso: string | null | undefined) => iso
  ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('es-SV', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—'

/** Días de atraso respecto de hoy (El Salvador). Negativo = todavía no vence. */
export function diasVencido(due: string): number {
  const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/El_Salvador' }))
  hoy.setHours(12, 0, 0, 0)
  const v = new Date(`${due}T12:00:00`)
  return Math.round((hoy.getTime() - v.getTime()) / 86_400_000)
}

export function estadoCuentaHTML(args: {
  emisor: TicketEmisor
  cliente: CxcCliente
  documentos: DocumentoCxc[]
  movimientos: MovimientoCredito[]
  /** Lavados con facturación consolidada (0060): facturados y pendientes. */
  lavados?: LavadoCredito[]
}): string {
  const { emisor: e, cliente: c, documentos, movimientos } = args
  const lavados = args.lavados ?? []
  const corte = new Date().toLocaleDateString('es-SV', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/El_Salvador' })
  const abiertos = documentos.filter(d => d.balance > 0)
  const logo = `<svg viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" style="width:150px;height:auto" role="img" aria-label="CORSA Carwash"><path d="${LOGO_PATH}" fill="#16191A" fill-rule="evenodd"/></svg>`

  const tramos: [string, number][] = [
    ['Por vencer', c.por_vencer], ['1–30 días', c.vencido_1_30], ['31–60 días', c.vencido_31_60],
    ['61–90 días', c.vencido_61_90], ['Más de 90', c.vencido_90_mas],
  ]

  const filasDocs = abiertos.length === 0
    ? `<tr><td colspan="7" class="vacio">Sin documentos pendientes.</td></tr>`
    : abiertos.map(d => {
        const dias = diasVencido(d.due_date)
        return `<tr>
          <td>${esc(d.factura ?? d.orden ?? '—')}</td>
          <td>${fecha(d.created_at)}</td>
          <td>${fecha(d.due_date)}</td>
          <td class="num">${money(d.amount)}</td>
          <td class="num">${money(d.amount - d.balance)}</td>
          <td class="num fuerte">${money(d.balance)}</td>
          <td class="num ${dias > 0 ? 'rojo' : ''}">${dias > 0 ? `${dias} días` : 'Al día'}</td>
        </tr>`
      }).join('')

  const filasMov = movimientos.filter(m => m.event_type === 'CHARGE' || m.event_type === 'CHARGE_OVERRIDE' || m.event_type === 'PAYMENT')
    .slice(0, 25)
    .map(m => `<tr>
      <td>${fecha(m.created_at)}</td>
      <td>${esc(EVENTO_ETIQUETA[m.event_type] ?? m.event_type)}${m.reason ? ` · ${esc(m.reason)}` : ''}</td>
      <td class="num">${m.event_type === 'PAYMENT' ? '' : money(m.amount ?? 0)}</td>
      <td class="num">${m.event_type === 'PAYMENT' ? money(m.amount ?? 0) : ''}</td>
      <td class="num">${m.balance_after != null ? money(m.balance_after) : ''}</td>
    </tr>`).join('') || `<tr><td colspan="5" class="vacio">Sin movimientos.</td></tr>`

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Estado de cuenta · ${esc(c.customer_name ?? '')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Outfit:wght@700;800&display=swap" rel="stylesheet"/>
<style>
  @page { size: letter; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Inter, Arial, sans-serif; color: #16191A; font-size: 11.5px; margin: 0; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #16191A; padding-bottom: 12px; }
  .emisor { text-align: right; font-size: 10.5px; line-height: 1.45; color: #3D4441; }
  .emisor b { color: #16191A; font-size: 11.5px; }
  h1 { font-family: Outfit, Arial; font-weight: 800; font-size: 26px; margin: 18px 0 2px; letter-spacing: -0.01em; }
  .corte { color: #5E6661; font-size: 11px; }
  .raya { display: inline-block; width: 46px; height: 5px; background: #DFF56B; border-radius: 3px; margin-top: 8px; }
  .bloques { display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; margin-top: 16px; }
  .caja { border: 1px solid #DCE2D6; border-radius: 12px; padding: 12px 14px; }
  .caja h3 { margin: 0 0 8px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #5E6661; }
  .kv { display: flex; justify-content: space-between; padding: 2px 0; }
  .kv span:first-child { color: #5E6661; }
  .resumen { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
  .cifra { background: #F3F5F0; border-radius: 12px; padding: 10px 12px; }
  .cifra small { display: block; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5E6661; font-weight: 700; }
  .cifra b { font-family: Outfit, Arial; font-size: 19px; }
  .cifra.tinta { background: #16191A; color: #fff; } .cifra.tinta small { color: #DFF56B; }
  .cifra.roja b { color: #C2272D; }
  h2 { font-family: Outfit, Arial; font-size: 15px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5E6661; border-bottom: 2px solid #16191A; padding: 6px 6px; }
  td { padding: 6px 6px; border-bottom: 1px solid #E3E8DE; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fuerte { font-weight: 700; } .rojo { color: #C2272D; font-weight: 700; }
  .vacio { text-align: center; color: #7A827D; padding: 14px; }
  .tramos td { text-align: center; } .tramos th { text-align: center; }
  .pie { margin-top: 22px; font-size: 10px; color: #5E6661; border-top: 1px solid #DCE2D6; padding-top: 10px; line-height: 1.5; }
</style></head><body>
  <div class="top">
    ${logo}
    <div class="emisor">
      <b>${esc(e.razonSocial || e.nombreComercial)}</b><br/>
      ${e.nit ? `NIT ${esc(e.nit)}` : ''}${e.nit && e.nrc ? ' · ' : ''}${e.nrc ? `NRC ${esc(e.nrc)}` : ''}<br/>
      ${esc(e.direccion ?? '')}<br/>
      ${e.telefono ? `Tel. ${esc(e.telefono)}` : ''}${e.correo ? ` · ${esc(e.correo)}` : ''}
    </div>
  </div>

  <h1>Estado de cuenta</h1>
  <div class="corte">Fecha de corte: ${esc(corte)}</div>
  <div class="raya"></div>

  <div class="bloques">
    <div class="caja">
      <h3>Cliente</h3>
      <div style="font-weight:700;font-size:13px">${esc(c.legal_name || c.customer_name || '')}</div>
      ${c.legal_name && c.customer_name && c.legal_name !== c.customer_name ? `<div>${esc(c.customer_name)}</div>` : ''}
      ${c.nit ? `<div class="kv"><span>NIT</span><span>${esc(c.nit)}</span></div>` : ''}
      ${c.phone ? `<div class="kv"><span>Teléfono</span><span>${esc(c.phone)}</span></div>` : ''}
      ${c.email ? `<div class="kv"><span>Correo</span><span>${esc(c.email)}</span></div>` : ''}
    </div>
    <div class="caja">
      <h3>Crédito</h3>
      <div class="kv"><span>Límite de crédito</span><b>${money(c.credit_limit)}</b></div>
      <div class="kv"><span>Plazo</span><b>${c.credit_days} días</b></div>
      <div class="kv"><span>Disponible</span><b>${money(c.disponible)}</b></div>
      <div class="kv"><span>Documentos pendientes</span><b>${c.documentos_abiertos}</b></div>
    </div>
  </div>

  <div class="resumen">
    <div class="cifra tinta"><small>Saldo total</small><b>${money(c.saldo)}</b></div>
    <div class="cifra"><small>Por vencer</small><b>${money(c.por_vencer)}</b></div>
    <div class="cifra ${c.vencido > 0 ? 'roja' : ''}"><small>Vencido</small><b>${money(c.vencido)}</b></div>
    <div class="cifra"><small>Disponible</small><b>${money(c.disponible)}</b></div>
  </div>

  <h2>Antigüedad del saldo</h2>
  <table class="tramos"><tr>${tramos.map(([t]) => `<th>${t}</th>`).join('')}</tr>
    <tr>${tramos.map(([, v]) => `<td class="num" style="text-align:center">${money(v)}</td>`).join('')}</tr></table>

  <h2>Documentos pendientes</h2>
  <table>
    <tr><th>Documento</th><th>Fecha</th><th>Vence</th><th class="num">Monto</th><th class="num">Abonado</th><th class="num">Saldo</th><th class="num">Atraso</th></tr>
    ${filasDocs}
  </table>

  ${lavados.length ? `
  <h2>Lavados (${lavados.length}) · ${lavados.filter(l => !l.consolidated_invoice_id).length} pendientes de facturar</h2>
  <table>
    <tr><th>Fecha</th><th>Placa</th><th>Servicio</th><th class="num">Monto</th><th>Factura</th></tr>
    ${lavados.slice(0, 120).map(l => `<tr>
      <td>${fecha(l.created_at)}</td>
      <td style="font-weight:700">${esc(l.placa_principal)}</td>
      <td>${esc(l.detalle ?? '')}</td>
      <td class="num">${money(l.total)}</td>
      <td>${!l.consolidated_invoice_id ? '<span class="rojo">Pendiente de facturar</span>'
            : l.numero_control ? `CCF ${esc(l.numero_control)}` : esc(l.ccf_interno ?? '')}</td>
    </tr>`).join('')}
  </table>` : ''}

  <h2>Movimientos recientes</h2>
  <table>
    <tr><th>Fecha</th><th>Concepto</th><th class="num">Cargo</th><th class="num">Abono</th><th class="num">Saldo</th></tr>
    ${filasMov}
  </table>

  <div class="pie">
    Este estado de cuenta resume las ventas al crédito y los abonos registrados hasta la fecha de corte.
    Si encontrás alguna diferencia, comunicate con nosotros${e.telefono ? ` al ${esc(e.telefono)}` : ''}${e.correo ? ` o a ${esc(e.correo)}` : ''}.
    No es un documento tributario: las facturas de cada venta son los DTE emitidos ante el Ministerio de Hacienda.
  </div>
</body></html>`
}

/** Abre el estado de cuenta en una ventana e imprime (o guarda como PDF). */
export function imprimirEstadoCuenta(html: string): void {
  const w = window.open('', `corsa_estado_cuenta_${Date.now()}`, 'width=900,height=1100')
  if (!w) throw new Error('El navegador bloqueó la ventana. Permití popups para este sitio.')
  w.document.open()
  w.document.write(html)
  w.document.close()
  // Las fuentes tardan un instante; imprimir antes las cambia por Arial.
  setTimeout(() => { w.focus(); w.print() }, 900)
}
