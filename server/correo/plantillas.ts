/**
 * Las plantillas de los correos de CORSA.
 *
 * Marca sí, recargado no: una franja en tinta con el logo y la raya lima,
 * una tarjeta blanca con lo importante, y el pie. HTML de tablas y estilos en
 * línea, que es lo único que Gmail, Outlook y el teléfono muestran igual. El
 * logo es un PNG público: Gmail no muestra SVG.
 */

const TINTA = '#16191A'
const LIMA = '#DFF56B'
const FONDO = '#EFF2EC'
const GRIS = '#5E6661'

export const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function fechaSV(iso: string | Date, conHora = false): string {
  return new Date(iso).toLocaleString('es-SV', {
    timeZone: 'America/El_Salvador', day: '2-digit', month: 'long', year: 'numeric',
    ...(conHora ? { hour: '2-digit', minute: '2-digit' } : {}),
  })
}

/** Una fila «etiqueta · valor» de la tarjeta de datos. */
export function fila(etiqueta: string, valor: string, fuerte = false): string {
  return `<tr>
    <td style="padding:7px 0;border-bottom:1px solid #EEF1EA;color:${GRIS};font-size:13px">${esc(etiqueta)}</td>
    <td style="padding:7px 0;border-bottom:1px solid #EEF1EA;text-align:right;font-size:13px;color:${TINTA};${fuerte ? 'font-weight:700' : ''}">${valor}</td>
  </tr>`
}

export function tarjeta(titulo: string, filas: string): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0;border:1px solid #E3E8DE;border-radius:14px">
    <tr><td style="padding:14px 18px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${GRIS};margin-bottom:4px">${esc(titulo)}</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${filas}</table>
    </td></tr>
  </table>`
}

/** Un aviso destacado (lima para lo bueno, ámbar para lo pendiente). */
export function aviso(texto: string, tono: 'lima' | 'ambar' = 'lima'): string {
  const [fondo, borde] = tono === 'lima' ? ['#F6FCDA', LIMA] : ['#FFF6E5', '#F2C46B']
  return `<div style="background:${fondo};border-left:4px solid ${borde};border-radius:10px;padding:12px 14px;font-size:13.5px;color:${TINTA};margin:16px 0">${texto}</div>`
}

export function layout(args: {
  appUrl: string
  preheader: string
  titulo: string
  cuerpo: string
  emisor?: { razonSocial?: string; nombreComercial?: string; telefono?: string; correo?: string; direccion?: string }
}): string {
  const e = args.emisor ?? {}
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(args.titulo)}</title></head>
<body style="margin:0;padding:0;background:${FONDO};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:${TINTA}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(args.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${FONDO}">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #E3E8DE">
      <tr><td style="background:${TINTA};padding:24px 28px 20px" align="left">
        <img src="${esc(args.appUrl)}/marca/corsa-email.png" width="150" alt="CORSA Carwash" style="display:block;width:150px;height:auto;border:0"/>
        <div style="width:44px;height:4px;background:${LIMA};border-radius:2px;margin-top:14px"></div>
      </td></tr>
      <tr><td style="padding:26px 28px 8px">
        <h1 style="margin:0 0 6px;font-size:22px;line-height:1.25;font-weight:800;color:${TINTA}">${esc(args.titulo)}</h1>
        ${args.cuerpo}
      </td></tr>
      <tr><td style="padding:18px 28px 24px;border-top:1px solid #EEF1EA;font-size:11.5px;line-height:1.55;color:${GRIS}">
        <strong style="color:${TINTA}">${esc(e.nombreComercial || 'CORSA Carwash')}</strong>${e.razonSocial ? ` · ${esc(e.razonSocial)}` : ''}<br/>
        ${e.direccion ? `${esc(e.direccion)}<br/>` : ''}
        ${[e.telefono ? `Tel. ${esc(e.telefono)}` : '', e.correo ? esc(e.correo) : ''].filter(Boolean).join(' · ')}
      </td></tr>
    </table>
    <div style="font-size:11px;color:#8A928D;margin-top:12px">Este correo se envió automáticamente desde el sistema de CORSA Carwash.</div>
  </td></tr>
</table>
</body></html>`
}

export function parrafo(html: string): string {
  return `<p style="margin:10px 0;font-size:14.5px;line-height:1.6;color:#2B302E">${html}</p>`
}

export function boton(texto: string, url: string): string {
  return `<a href="${esc(url)}" style="display:inline-block;background:${TINTA};color:${LIMA};text-decoration:none;font-weight:700;font-size:13.5px;padding:11px 18px;border-radius:10px;margin:6px 0 4px">${esc(texto)}</a>`
}
