/**
 * CORSA — reporte de cierre de caja (0065).
 *
 * Tamaño carta, con la marca: efectivo inicial, ventas por método, retiros,
 * remesa y el efectivo final que queda en caja. Es la misma pieza para la
 * pantalla (se imprime o se guarda como PDF) y para el correo, donde el
 * servidor la convierte a PDF. No importa nada del navegador: el servidor la
 * empaqueta.
 */
import { LOGO_PATH, LOGO_VIEWBOX } from '../../brand/logoCompleto'
import type { TicketEmisor } from '../ticket/corsaTicket'
import type { ResumenCaja } from './resumen'

const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fechaHora = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString('es-SV', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/El_Salvador' })
  : '—'
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit', timeZone: 'America/El_Salvador' })

/** El día del turno, como título: «sábado, 4 de octubre de 2026». */
export function diaDelTurno(iso: string): string {
  return new Date(iso).toLocaleDateString('es-SV', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/El_Salvador' })
}

export function reporteCierreHTML(args: { emisor: TicketEmisor; resumen: ResumenCaja }): string {
  const { emisor: e, resumen: r } = args
  const logo = `<svg viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" style="width:150px;height:auto" role="img" aria-label="CORSA Carwash"><path d="${LOGO_PATH}" fill="#16191A" fill-rule="evenodd"/></svg>`
  const abierta = r.estado === 'open'
  const retiros = r.movimientos.filter(m => m.tipo === 'cash_out')

  const filasRetiros = retiros.length === 0
    ? `<tr><td colspan="5" class="vacio">Sin retiros de efectivo.</td></tr>`
    : retiros.map(m => `<tr>
        <td>${esc(hora(m.fecha))}</td>
        <td>${esc(m.motivo)}</td>
        <td>${esc(m.registro)}</td>
        <td>${esc(m.autorizo ?? '—')}</td>
        <td class="num fuerte">${money(m.monto)}</td>
      </tr>`).join('')

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Cierre de caja · ${esc(r.sucursal)} · ${esc(diaDelTurno(r.abierta_at))}</title>
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
  .sub { color: #5E6661; font-size: 11px; text-transform: capitalize; }
  .raya { display: inline-block; width: 46px; height: 5px; background: #2F6B4F; border-radius: 3px; margin-top: 8px; }
  .abierta { display: inline-block; margin-left: 8px; font-size: 10px; font-weight: 700; color: #8A6414; background: #FBF1DC; padding: 2px 8px; border-radius: 99px; vertical-align: middle; }
  .bloques { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
  .caja { border: 1px solid #DCE2D6; border-radius: 12px; padding: 12px 14px; }
  .caja h3 { margin: 0 0 8px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: #5E6661; }
  .kv { display: flex; justify-content: space-between; padding: 3px 0; }
  .kv span:first-child { color: #5E6661; }
  .kv.total { border-top: 1px solid #DCE2D6; margin-top: 4px; padding-top: 6px; font-weight: 700; }
  .kv.total span:first-child { color: #16191A; }
  .menos { color: #C2272D; }
  .resumen { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
  .cifra { background: #F3F5F0; border-radius: 12px; padding: 10px 12px; }
  .cifra small { display: block; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5E6661; font-weight: 700; }
  .cifra b { font-family: Outfit, Arial; font-size: 19px; }
  .cifra.tinta { background: #16191A; color: #fff; } .cifra.tinta small { color: #DFF56B; }
  h2 { font-family: Outfit, Arial; font-size: 15px; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #5E6661; border-bottom: 2px solid #16191A; padding: 6px 6px; }
  td { padding: 6px 6px; border-bottom: 1px solid #E3E8DE; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fuerte { font-weight: 700; }
  .vacio { text-align: center; color: #7A827D; padding: 14px; }
  .firmas { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 46px; }
  .firma { border-top: 1px solid #16191A; padding-top: 6px; text-align: center; font-size: 10.5px; color: #3D4441; }
  .pie { margin-top: 22px; font-size: 10px; color: #5E6661; border-top: 1px solid #DCE2D6; padding-top: 10px; line-height: 1.5; }
</style></head><body>
  <div class="top">
    ${logo}
    <div class="emisor">
      <b>${esc(e.razonSocial || e.nombreComercial)}</b><br/>
      ${e.nit ? `NIT ${esc(e.nit)}` : ''}${e.nit && e.nrc ? ' · ' : ''}${e.nrc ? `NRC ${esc(e.nrc)}` : ''}<br/>
      ${esc(r.sucursal)} · ${esc(r.caja)}
    </div>
  </div>

  <h1>Cierre de caja${abierta ? '<span class="abierta">CAJA ABIERTA · PARCIAL</span>' : ''}</h1>
  <div class="sub">${esc(diaDelTurno(r.abierta_at))}</div>
  <div class="raya"></div>

  <div class="resumen">
    <div class="cifra"><small>Efectivo inicial</small><b>${money(r.efectivo_inicial)}</b></div>
    <div class="cifra"><small>Ventas del día</small><b>${money(r.ventas.total)}</b></div>
    <div class="cifra"><small>Remesa</small><b>${money(r.remesa)}</b></div>
    <div class="cifra tinta"><small>${abierta ? 'Efectivo en caja' : 'Efectivo final'}</small><b>${money(abierta ? r.efectivo_disponible : r.efectivo_final)}</b></div>
  </div>

  <div class="bloques">
    <div class="caja">
      <h3>Ventas por forma de pago</h3>
      <div class="kv"><span>Efectivo</span><b>${money(r.ventas.efectivo)}</b></div>
      <div class="kv"><span>Tarjeta</span><b>${money(r.ventas.tarjeta)}</b></div>
      <div class="kv"><span>Transferencia</span><b>${money(r.ventas.transferencia)}</b></div>
      ${r.ventas.otros > 0 ? `<div class="kv"><span>Otros</span><b>${money(r.ventas.otros)}</b></div>` : ''}
      <div class="kv total"><span>Total cobrado (${r.ventas.cantidad} ventas)</span><span>${money(r.ventas.total)}</span></div>
    </div>
    <div class="caja">
      <h3>Movimiento del efectivo</h3>
      <div class="kv"><span>Efectivo inicial</span><b>${money(r.efectivo_inicial)}</b></div>
      <div class="kv"><span>+ Ingresos en efectivo</span><b>${money(r.ingresos_efectivo)}</b></div>
      <div class="kv"><span>− Retiros de efectivo</span><b class="menos">${money(r.egresos_efectivo)}</b></div>
      <div class="kv"><span>= Efectivo antes de remesar</span><b>${money(r.efectivo_disponible)}</b></div>
      <div class="kv"><span>− Remesa</span><b class="menos">${money(r.remesa)}</b></div>
      <div class="kv total"><span>Efectivo final en caja</span><span>${money(r.efectivo_final)}</span></div>
    </div>
  </div>

  <h2>Retiros de efectivo (${retiros.length})</h2>
  <table>
    <tr><th>Hora</th><th>Motivo</th><th>Registró</th><th>Autorizó</th><th class="num">Monto</th></tr>
    ${filasRetiros}
  </table>

  <div class="bloques">
    <div class="caja">
      <h3>Apertura</h3>
      <div class="kv"><span>Fecha y hora</span><span>${esc(fechaHora(r.abierta_at))}</span></div>
      <div class="kv"><span>Abrió</span><span>${esc(r.abrio)}</span></div>
    </div>
    <div class="caja">
      <h3>Cierre</h3>
      <div class="kv"><span>Fecha y hora</span><span>${esc(fechaHora(r.cerrada_at))}</span></div>
      <div class="kv"><span>Cerró</span><span>${esc(r.cerro ?? '—')}</span></div>
    </div>
  </div>

  <div class="firmas">
    <div class="firma">Cajero · ${esc(r.cerro ?? r.abrio)}</div>
    <div class="firma">Recibe la remesa</div>
  </div>

  <div class="pie">
    Las ventas se toman de los cobros registrados en el POS entre la apertura y el cierre de la caja, por forma de pago.
    Las ventas al crédito no entran en caja: van a cuentas por cobrar. Efectivo final = inicial + ingresos − retiros − remesa.
  </div>
</body></html>`
}

/** Abre el reporte en una ventana e imprime (o guarda como PDF). */
export function imprimirReporteCierre(html: string): void {
  const w = window.open('', `corsa_cierre_caja_${Date.now()}`, 'width=900,height=1100')
  if (!w) throw new Error('El navegador bloqueó la ventana. Permití popups para este sitio.')
  w.document.open()
  w.document.write(html)
  w.document.close()
  // Las fuentes tardan un instante; imprimir antes las cambia por Arial.
  setTimeout(() => { w.focus(); w.print() }, 900)
}
