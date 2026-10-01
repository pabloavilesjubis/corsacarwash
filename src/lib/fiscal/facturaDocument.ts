/**
 * CORSA Carwash — Representación gráfica del DTE (tamaño carta)
 *
 * Es el documento que se adjunta al correo del cliente, distinto del ticket
 * térmico de 80 mm: aquel es comprobante y orden de trabajo a la vez; éste es
 * el respaldo formal que la gente archiva o presenta a su contador.
 *
 * Lleva la línea gráfica del sistema —tinta, lima, lienzo salvia; Outfit para
 * títulos e Inter para el resto— y el logo real. Los colores son los mismos
 * valores de src/index.css, copiados acá porque el documento se abre en una
 * ventana aparte que no carga los estilos de la app.
 *
 * Mientras no se transmita al MH faltan el número de control, el código de
 * generación, el sello y el QR. En vez de dejar huecos en blanco —que parecen
 * un error de impresión— el documento los marca explícitamente como pendientes
 * y se rotula como no transmitido. Cuando el DTE exista, esos campos se llenan
 * y el rótulo desaparece.
 */

import type { DteDeVenta, Sale } from '../../services/sales.service'
import { EMISOR } from '../ticket/fromSale'
import { findDepartamento, findMunicipio } from '../mh-catalogs'
import { formatearFechaHora } from '../../utils/fecha'
import { LOGO_PATH, LOGO_VIEWBOX } from '../../brand/logoCompleto'
import { qrSvg } from './qr'

const TIPO_LABEL: Record<string, string> = {
  consumidor_final: 'Factura de Consumidor Final',
  credito_fiscal: 'Comprobante de Crédito Fiscal',
  nota_credito: 'Nota de Crédito',
  nota_debito: 'Nota de Débito',
}

/** Por código de DTE: manda sobre el tipo de la factura cuando hay documento. */
const TIPO_DTE_LABEL: Record<string, string> = {
  '01': 'Factura de Consumidor Final',
  '03': 'Comprobante de Crédito Fiscal',
  '05': 'Nota de Crédito',
  '06': 'Nota de Débito',
  '14': 'Factura de Sujeto Excluido',
}

function esc(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function money(n: number): string {
  return '$' + (Number(n) || 0).toFixed(2)
}

/** Campo de identificación del DTE; sin valor se muestra como pendiente. */
function campoDte(label: string, value?: string | null, ancho = false): string {
  return `<div class="id-field${ancho ? ' wide' : ''}">
    <div class="label">${esc(label)}</div>
    <div class="id-value ${value ? 'mono' : 'pending'}">${value ? esc(value) : 'Pendiente de transmisión'}</div>
  </div>`
}

export function buildFacturaHTML(sale: Sale, dte: DteDeVenta | null = null): string {
  const tipo = (dte && TIPO_DTE_LABEL[dte.tipoDte])
    ?? TIPO_LABEL[sale.invoice_type ?? '']
    ?? 'Documento de venta'
  const emitido = Boolean(dte?.numeroControl)
  const pruebas = dte?.ambiente === '00'
  const invalidado = dte?.estado === 'INVALIDATED'
  const subtotal = Number(sale.subtotal || 0)
  const iva = Number(sale.tax_total || 0)
  const total = Number(sale.total || 0)

  // La dirección del receptor se arma con los nombres de catálogo: el MH la
  // transmite como códigos, pero en el papel tienen que leerse.
  const dep = sale.customer_departamento ? findDepartamento(sale.customer_departamento) : undefined
  const mun = (sale.customer_departamento && sale.customer_municipio)
    ? findMunicipio(sale.customer_departamento, sale.customer_municipio)
    : undefined
  const direccionReceptor = [sale.customer_direccion, mun?.nombre, dep?.nombre]
    .filter(Boolean).join(', ')

  // Con DTE, la fecha es la del documento —la que el MH tiene registrada—. Sin
  // él, la de la venta, en hora de El Salvador: no puede depender del reloj de
  // la computadora que imprime.
  const fecha = dte?.fechaEmision
    ? `${dte.fechaEmision.split('-').reverse().join('/')}${dte.horaEmision ? ` · ${dte.horaEmision}` : ''}`
    : formatearFechaHora(sale.created_at, {
        day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })

  // Las líneas vienen de la venta. El fallback es para ventas viejas que se
  // guardaron antes de que la vista las expusiera: mejor una línea agregada
  // que un desglose inventado.
  const lineas = sale.items?.length
    ? sale.items.map(i => ({ desc: i.descripcion, cantidad: i.cantidad, unitario: i.unitario, total: i.total }))
    : [{ desc: sale.service_name ?? 'Servicio de lavado', cantidad: 1, unitario: total, total }]

  const logo = (color: string) =>
    `<svg class="logo" viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" role="img" aria-label="CORSA Carwash">`
    + `<path d="${LOGO_PATH}" fill="${color}" fill-rule="evenodd"/></svg>`

  const aviso = !emitido
    ? `<div class="notice notice-danger">
         <strong>Documento no transmitido al Ministerio de Hacienda.</strong>
         Sin validez fiscal hasta obtener el sello de recepción.
       </div>`
    : invalidado
      ? `<div class="notice notice-danger"><strong>Documento invalidado ante el Ministerio de Hacienda.</strong>
           Se conserva como constancia; ya no respalda la operación.</div>`
      : pruebas
        ? `<div class="notice notice-warning"><strong>Ambiente de pruebas.</strong>
             Emitido contra el sandbox del MH; no tiene validez fiscal.</div>`
        : ''

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>${esc(dte?.numeroControl || sale.invoice_number || sale.order_number)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  :root {
    --ink: #16191A;
    --lime: #DFF56B;
    --sage: #EFF2EC;
    --sage-strong: #E9EEE4;
    --border: #E3E8DE;
    --muted: #6C7671;
    --danger: #B03A33;
    --danger-tint: #FBE9E7;
    --warning: #8A6414;
    --warning-tint: #FBF1DC;
  }
  @page { size: letter; margin: 12mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; background: #fff; color: var(--ink);
    font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
    font-size: 10.5px; line-height: 1.45;
  }
  .sheet { max-width: 192mm; margin: 0 auto; }
  .mono { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .label {
    font-size: 8px; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 2px;
  }

  /* ── Cabecera: la franja de tinta es el riel lateral de la app ── */
  .masthead {
    display: flex; justify-content: space-between; align-items: stretch; gap: 18px;
    background: var(--ink); color: #fff; border-radius: 16px; padding: 18px 22px;
  }
  .brand { display: flex; align-items: center; gap: 18px; }
  .logo { width: 36mm; height: auto; display: block; flex-shrink: 0; }
  .issuer { border-left: 1px solid rgba(255,255,255,0.18); padding-left: 18px; font-size: 9.5px; line-height: 1.55; color: rgba(255,255,255,0.78); }
  .issuer-name { font-family: 'Outfit', sans-serif; font-size: 13px; font-weight: 700; color: #fff; letter-spacing: 0.01em; margin-bottom: 2px; }
  .doc-head { text-align: right; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 6px; }
  .doc-kicker { font-size: 8px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.6); }
  .doc-type {
    background: var(--lime); color: var(--ink);
    font-family: 'Outfit', sans-serif; font-weight: 700; font-size: 13px;
    padding: 6px 14px; border-radius: 999px; white-space: nowrap;
  }

  .notice { margin-top: 10px; padding: 8px 12px; border-radius: 10px; font-size: 10px; }
  .notice strong { margin-right: 4px; }
  .notice-danger { background: var(--danger-tint); color: var(--danger); border: 1px solid var(--danger); }
  .notice-warning { background: var(--warning-tint); color: var(--warning); border: 1px solid var(--warning); }

  /* ── Identificación del DTE + QR ── */
  .ident { display: flex; gap: 10px; margin-top: 10px; }
  .id-card {
    flex: 1; background: var(--sage); border-radius: 14px; padding: 12px 16px;
    display: grid; grid-template-columns: 1fr 1fr; gap: 9px 18px; align-content: start;
  }
  .id-field.wide { grid-column: 1 / -1; }
  .id-value { font-size: 10.5px; font-weight: 600; word-break: break-all; }
  .id-value.pending { color: var(--danger); font-style: italic; font-weight: 500; }
  .qr-card {
    width: 44mm; flex-shrink: 0; border: 1px solid var(--border); border-radius: 14px;
    padding: 10px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .qr-card svg { width: 33mm; height: 33mm; display: block; }
  .qr-note { font-size: 8.5px; color: var(--muted); margin-top: 6px; line-height: 1.4; }
  .qr-note strong { color: var(--ink); }
  .qr-placeholder {
    width: 33mm; height: 33mm; border: 1.5px dashed var(--border); border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 8.5px; color: var(--muted); padding: 6px; line-height: 1.35;
  }

  /* ── Receptor y operación ── */
  .parties { display: flex; gap: 10px; margin-top: 10px; }
  .party { flex: 1; border: 1px solid var(--border); border-radius: 14px; padding: 12px 16px; }
  .party-name { font-family: 'Outfit', sans-serif; font-size: 13px; font-weight: 700; margin-bottom: 3px; }
  .party-row { font-size: 10px; line-height: 1.6; }
  .party-row span.k { color: var(--muted); }

  /* ── Detalle ── */
  table { width: 100%; border-collapse: separate; border-spacing: 0; margin-top: 14px; }
  th {
    font-size: 8px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--muted); text-align: left; padding: 0 10px 7px;
    border-bottom: 2px solid var(--ink);
  }
  td { padding: 9px 10px; border-bottom: 1px solid var(--border); font-size: 10.5px; }
  td.desc { font-weight: 500; }

  /* ── Totales ── */
  .summary { display: flex; justify-content: space-between; align-items: flex-end; gap: 18px; margin-top: 12px; }
  .summary-note { font-size: 9px; color: var(--muted); max-width: 90mm; line-height: 1.5; }
  .totals { width: 80mm; }
  .totals-row { display: flex; justify-content: space-between; padding: 4px 12px; font-size: 10.5px; }
  .totals-row span:first-child { color: var(--muted); }
  .grand {
    display: flex; justify-content: space-between; align-items: center;
    background: var(--ink); color: #fff; border-radius: 12px;
    padding: 10px 14px; margin-top: 6px;
  }
  .grand-label { font-size: 8.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.7); }
  .grand-value { font-family: 'Outfit', sans-serif; font-size: 20px; font-weight: 800; color: var(--lime); font-variant-numeric: tabular-nums; }

  footer {
    margin-top: 22px; padding-top: 10px; border-top: 1px solid var(--border);
    display: flex; justify-content: space-between; gap: 12px;
    font-size: 8.5px; color: var(--muted);
  }

  @media screen {
    body { background: var(--sage-strong); padding: 24px 0; }
    .sheet { background: #fff; padding: 12mm; border-radius: 6px; box-shadow: 0 12px 34px rgba(16,25,18,0.10); }
  }
</style>
</head>
<body>
  <div class="sheet">
    <header class="masthead">
      <div class="brand">
        ${logo('#FFFFFF')}
        <div class="issuer">
          <div class="issuer-name">${esc(EMISOR.razonSocial)}</div>
          NIT ${esc(EMISOR.nit)} · NRC ${esc(EMISOR.nrc)}<br/>
          ${esc(EMISOR.direccion)}
        </div>
      </div>
      <div class="doc-head">
        <div class="doc-kicker">Documento tributario electrónico</div>
        <div class="doc-type">${esc(tipo)}</div>
      </div>
    </header>

    ${aviso}

    <section class="ident">
      <div class="id-card">
        ${campoDte('Número de control', dte?.numeroControl)}
        ${campoDte('Código de generación', dte?.codigoGeneracion)}
        ${campoDte('Sello de recepción', dte?.selloRecepcion, true)}
        <div class="id-field">
          <div class="label">Fecha y hora de emisión</div>
          <div class="id-value">${esc(fecha)}</div>
        </div>
        <div class="id-field">
          <div class="label">Ambiente</div>
          <div class="id-value">${!dte ? '—' : pruebas ? 'Pruebas (00)' : 'Producción (01)'}</div>
        </div>
      </div>
      <div class="qr-card">
        ${dte?.qrUrl
          ? `${qrSvg(dte.qrUrl, { color: '#16191A', margen: 0 })}
             <div class="qr-note">Verificá este documento en<br/><strong>admin.factura.gob.sv</strong></div>`
          : `<div class="qr-placeholder">El QR de verificación aparece cuando el MH sella el documento</div>`}
      </div>
    </section>

    <section class="parties">
      <div class="party">
        <div class="label">Receptor</div>
        <div class="party-name">${esc(sale.customer_name)}</div>
        ${sale.customer_trade_name && sale.customer_trade_name !== sale.customer_name
          ? `<div class="party-row"><span class="k">Nombre comercial:</span> ${esc(sale.customer_trade_name)}</div>` : ''}
        ${sale.customer_nit ? `<div class="party-row"><span class="k">NIT:</span> <span class="mono">${esc(sale.customer_nit)}</span></div>` : ''}
        ${sale.customer_dui && !sale.customer_nit ? `<div class="party-row"><span class="k">DUI:</span> <span class="mono">${esc(sale.customer_dui)}</span></div>` : ''}
        ${sale.customer_nrc ? `<div class="party-row"><span class="k">NRC:</span> <span class="mono">${esc(sale.customer_nrc)}</span></div>` : ''}
        ${sale.customer_desc_actividad
          ? `<div class="party-row"><span class="k">Actividad:</span> ${esc(sale.customer_desc_actividad)}${sale.customer_cod_actividad ? ` (${esc(sale.customer_cod_actividad)})` : ''}</div>` : ''}
        ${direccionReceptor ? `<div class="party-row"><span class="k">Dirección:</span> ${esc(direccionReceptor)}</div>` : ''}
        ${sale.customer_phone ? `<div class="party-row"><span class="k">Tel.:</span> ${esc(sale.customer_phone)}</div>` : ''}
        ${sale.customer_email ? `<div class="party-row"><span class="k">Correo:</span> ${esc(sale.customer_email)}</div>` : ''}
      </div>
      <div class="party">
        <div class="label">Datos de la operación</div>
        <div class="party-name">Orden ${esc(sale.order_number)}</div>
        <div class="party-row"><span class="k">Sucursal:</span> ${esc(sale.branch_name)}</div>
        ${sale.plate ? `<div class="party-row"><span class="k">Vehículo:</span> <span class="mono">${esc(sale.plate)}</span></div>` : ''}
        <div class="party-row"><span class="k">Forma de pago:</span> ${esc(sale.payment_method ?? '—')}</div>
      </div>
    </section>

    <table>
      <thead>
        <tr><th style="width:58%">Descripción</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Total</th></tr>
      </thead>
      <tbody>
        ${lineas.map(l => `<tr>
          <td class="desc">${esc(l.desc)}</td>
          <td class="num">${esc(l.cantidad)}</td>
          <td class="num">${money(l.unitario)}</td>
          <td class="num">${money(l.total)}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <section class="summary">
      <div class="summary-note">
        Precios en dólares de los Estados Unidos de América (USD).
        ${emitido ? 'Esta es la representación gráfica de un documento tributario electrónico; el documento válido es el registrado en el Ministerio de Hacienda.' : ''}
      </div>
      <div class="totals">
        <div class="totals-row"><span>Subtotal sin IVA</span><span class="num">${money(subtotal)}</span></div>
        <div class="totals-row"><span>IVA 13%</span><span class="num">${money(iva)}</span></div>
        <div class="grand"><span class="grand-label">Total a pagar</span><span class="grand-value">${money(total)}</span></div>
      </div>
    </section>

    <footer>
      <span>${esc(EMISOR.razonSocial)} · CORSA Carwash</span>
      <span>Generado el ${new Date().toLocaleDateString('es-SV')}</span>
    </footer>
  </div>
  <script>
    // Se imprime cuando las fuentes terminaron de cargar: si no, el diálogo
    // agarra la página con la fuente de reserva y el PDF sale con otra letra.
    if (!new URLSearchParams(location.search).get('noprint')) {
      window.addEventListener('load', function () {
        var listo = (document.fonts && document.fonts.ready) || Promise.resolve();
        var tope = new Promise(function (r) { setTimeout(r, 2500); });
        Promise.race([listo, tope]).then(function () {
          setTimeout(function () { window.focus(); window.print(); }, 150);
        });
      });
    }
  </script>
</body>
</html>`
}

/**
 * Abre la factura en una ventana nueva lista para imprimir o guardar en PDF.
 *
 * `ventana` permite abrirla antes de ir a buscar el DTE: el navegador sólo deja
 * abrir ventanas en respuesta directa a un clic, y después de un `await` ya no
 * cuenta como tal.
 */
export function printFactura(sale: Sale, dte: DteDeVenta | null = null, ventana?: Window | null): void {
  const w = ventana ?? window.open('', `corsa_factura_${sale.order_id}`, 'width=900,height=1000')
  if (!w) {
    throw new Error('El navegador bloqueó la ventana. Permití popups para este sitio.')
  }
  w.document.open()
  w.document.write(buildFacturaHTML(sale, dte))
  w.document.close()
}
