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
import type { TicketEmisor } from '../ticket/corsaTicket'
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
function campoDte(label: string, value?: string | null, clase = ''): string {
  return `<div class="id-field ${clase}">
    <div class="label">${esc(label)}</div>
    <div class="id-value ${value ? 'mono' : 'pending'}">${value ? esc(value) : 'Pendiente de transmisión'}</div>
  </div>`
}

/** Dato de la operación: no fiscal, siempre presente. */
function campoOp(label: string, value?: string | null, clase = ''): string {
  return `<div class="id-field ${clase}">
    <div class="label">${esc(label)}</div>
    <div class="id-value">${value ? esc(value) : '—'}</div>
  </div>`
}

/**
 * Una fila de la tarjeta de emisor o receptor.
 *
 * Un dato que el MH exige y no está se imprime como «No registrado», en rojo:
 * dejarlo fuera haría parecer completo un CCF al que le falta algo, y eso se
 * descubre cuando el contador del cliente lo rechaza. Un dato opcional vacío
 * simplemente no se imprime.
 */
function fila(label: string, value: string | null | undefined, opts: { mono?: boolean; requerido?: boolean } = {}): string {
  if (!value && !opts.requerido) return ''
  return `<div class="k">${esc(label)}</div>
    <div class="v${opts.mono && value ? ' mono' : ''}${value ? '' : ' missing'}">${value ? esc(value) : 'No registrado'}</div>`
}

/**
 * `emisor` es el de `fiscal_issuer_config` de la sucursal (lib/fiscal/emisor):
 * el mismo que viaja dentro del DTE.
 */
export function buildFacturaHTML(sale: Sale, emisor: TicketEmisor, dte: DteDeVenta | null = null): string {
  const tipo = (dte && TIPO_DTE_LABEL[dte.tipoDte])
    ?? TIPO_LABEL[sale.invoice_type ?? '']
    ?? 'Documento de venta'
  const esCcf = dte ? dte.tipoDte === '03' : sale.invoice_type === 'credito_fiscal'
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
    ? `${dte.fechaEmision.split('-').reverse().join('/')}${dte.horaEmision ? ` ${dte.horaEmision}` : ''}`
    : formatearFechaHora(sale.created_at, {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })

  // Las líneas vienen de la venta. El fallback es para ventas viejas que se
  // guardaron antes de que la vista las expusiera: mejor una línea agregada
  // que un desglose inventado.
  const lineas = sale.items?.length
    ? sale.items.map(i => ({ desc: i.descripcion, cantidad: i.cantidad, unitario: i.unitario, total: i.total }))
    : [{ desc: sale.service_name ?? 'Servicio de lavado', cantidad: 1, unitario: total, total }]

  const logo = `<svg class="logo" viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" role="img" aria-label="CORSA Carwash">`
    + `<path d="${LOGO_PATH}" fill="#FFFFFF" fill-rule="evenodd"/></svg>`

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

  // El emisor lleva lo mismo en una factura que en un CCF: el MH lo exige
  // completo en los dos.
  const actividadEmisor = emisor.descActividad
    ? `${emisor.descActividad}${emisor.codActividad ? ` (${emisor.codActividad})` : ''}`
    : undefined
  const emisorCard = `
      <div class="party">
        <div class="party-head">Emisor</div>
        <div class="party-name">${esc(emisor.razonSocial ?? emisor.nombreComercial)}</div>
        <div class="kv">
          ${fila('Nombre comercial', emisor.nombreComercial, { requerido: true })}
          ${fila('NIT', emisor.nit, { mono: true, requerido: true })}
          ${fila('NRC', emisor.nrc, { mono: true, requerido: true })}
          ${fila('Actividad económica', actividadEmisor, { requerido: true })}
          ${fila('Dirección', emisor.direccion, { requerido: true })}
          ${fila('Teléfono', emisor.telefono)}
          ${fila('Correo', emisor.correo, { requerido: true })}
        </div>
      </div>`

  // El receptor de un CCF es un contribuyente y el MH pide todos sus datos.
  // En una factura de consumidor final casi todo es opcional: se imprime lo
  // que haya.
  const actividadReceptor = sale.customer_desc_actividad
    ? `${sale.customer_desc_actividad}${sale.customer_cod_actividad ? ` (${sale.customer_cod_actividad})` : ''}`
    : undefined
  const receptorCard = `
      <div class="party">
        <div class="party-head">Receptor</div>
        <div class="party-name">${esc(sale.customer_name || 'Consumidor final')}</div>
        <div class="kv">
          ${sale.customer_trade_name && sale.customer_trade_name !== sale.customer_name
            ? fila('Nombre comercial', sale.customer_trade_name) : ''}
          ${esCcf
            ? fila('NIT', sale.customer_nit, { mono: true, requerido: true })
            : sale.customer_nit
              ? fila('NIT', sale.customer_nit, { mono: true })
              : fila('DUI', sale.customer_dui, { mono: true })}
          ${fila('NRC', sale.customer_nrc, { mono: true, requerido: esCcf })}
          ${fila('Actividad económica', actividadReceptor, { requerido: esCcf })}
          ${fila('Dirección', direccionReceptor, { requerido: esCcf })}
          ${fila('Teléfono', sale.customer_phone)}
          ${fila('Correo', sale.customer_email)}
        </div>
      </div>`

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>${esc(dte?.numeroControl || sale.invoice_number || sale.order_number)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  :root {
    --ink: #16191A;
    --lime: #DFF56B;
    --sage: #EFF2EC;
    --sage-strong: #E9EEE4;
    --border: #DCE2D6;
    --muted: #5F6964;
    --danger: #B03A33;
    --danger-tint: #FBE9E7;
    --warning: #8A6414;
    --warning-tint: #FBF1DC;
  }
  /* Márgenes de 10 mm: lo que casi toda impresora de oficina garantiza sin
     recortar. Más que eso es papel en blanco. */
  @page { size: letter; margin: 10mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; background: #fff; color: var(--ink);
    font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
    font-size: 9.5px; line-height: 1.4;
  }
  .sheet { max-width: 196mm; margin: 0 auto; }
  .mono { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .label {
    font-size: 7px; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 1px;
  }
  section, .party, .grand, tr { break-inside: avoid; page-break-inside: avoid; }

  /* ── Cabecera: sólo marca, razón social y tipo de documento ── */
  .masthead {
    display: flex; justify-content: space-between; align-items: center; gap: 14px;
    background: var(--ink); color: #fff; border-radius: 12px; padding: 10px 16px;
  }
  .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
  .logo { width: 24mm; height: auto; display: block; flex-shrink: 0; }
  .issuer-name {
    font-family: 'Outfit', sans-serif; font-size: 14px; font-weight: 700;
    border-left: 1px solid rgba(255,255,255,0.22); padding-left: 14px;
  }
  .doc-head { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .doc-kicker { font-size: 7px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.62); }
  .doc-type {
    background: var(--lime); color: var(--ink);
    font-family: 'Outfit', sans-serif; font-weight: 700; font-size: 12px;
    padding: 4px 12px; border-radius: 999px; white-space: nowrap;
  }

  .notice { margin-top: 6px; padding: 5px 10px; border-radius: 8px; font-size: 8.5px; }
  .notice strong { margin-right: 4px; }
  .notice-danger { background: var(--danger-tint); color: var(--danger); border: 1px solid var(--danger); }
  .notice-warning { background: var(--warning-tint); color: var(--warning); border: 1px solid var(--warning); }

  /* ── Identificación del DTE y de la operación + QR ── */
  .ident { display: flex; gap: 8px; margin-top: 8px; }
  .id-card {
    flex: 1; background: var(--sage); border-radius: 12px; padding: 9px 12px;
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 14px; align-content: start;
  }
  .id-field { min-width: 0; }
  .id-field.c2 { grid-column: span 2; }
  .id-field.c4 { grid-column: 1 / -1; }
  .id-sep { grid-column: 1 / -1; border-top: 1px solid var(--border); }
  .id-value { font-size: 9.5px; font-weight: 600; word-break: break-all; }
  .id-value.pending { color: var(--danger); font-style: italic; font-weight: 500; }
  .qr-card {
    width: 36mm; flex-shrink: 0; border: 1px solid var(--border); border-radius: 12px;
    padding: 7px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .qr-card svg { width: 27mm; height: 27mm; display: block; }
  .qr-note { font-size: 7px; color: var(--muted); margin-top: 4px; line-height: 1.35; }
  .qr-note strong { color: var(--ink); }
  .qr-placeholder {
    width: 27mm; height: 27mm; border: 1.5px dashed var(--border); border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-size: 7.5px; color: var(--muted); padding: 5px; line-height: 1.35;
  }

  /* ── Emisor y receptor ── */
  .parties { display: flex; gap: 8px; margin-top: 8px; }
  .party { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 12px; padding: 9px 12px; }
  .party-head {
    display: inline-block; font-size: 7px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase;
    background: var(--ink); color: var(--lime); padding: 2px 8px; border-radius: 999px; margin-bottom: 5px;
  }
  .party-name { font-family: 'Outfit', sans-serif; font-size: 12px; font-weight: 700; margin-bottom: 4px; line-height: 1.2; }
  /* Etiqueta y valor en dos columnas: se lee como formulario y entra más
     por centímetro que una línea por dato con la etiqueta delante. */
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 9px; }
  .kv .k { color: var(--muted); white-space: nowrap; }
  .kv .v { font-weight: 500; word-break: break-word; }
  .kv .v.missing { color: var(--danger); font-style: italic; }

  /* ── Detalle ── */
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th {
    font-size: 7px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--muted); text-align: left; padding: 0 8px 5px;
    border-bottom: 1.5px solid var(--ink);
  }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 9.5px; }
  td.desc { font-weight: 500; }

  /* ── Totales ── */
  .summary { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 8px; }
  .summary-note { font-size: 7.5px; color: var(--muted); max-width: 100mm; line-height: 1.45; }
  .totals { width: 72mm; }
  .totals-row { display: flex; justify-content: space-between; padding: 2px 10px; font-size: 9.5px; }
  .totals-row span:first-child { color: var(--muted); }
  .grand {
    display: flex; justify-content: space-between; align-items: center;
    background: var(--ink); color: #fff; border-radius: 10px;
    padding: 6px 12px; margin-top: 4px;
  }
  .grand-label { font-size: 7.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.7); }
  .grand-value { font-family: 'Outfit', sans-serif; font-size: 17px; font-weight: 800; color: var(--lime); font-variant-numeric: tabular-nums; }

  footer {
    margin-top: 12px; padding-top: 6px; border-top: 1px solid var(--border);
    display: flex; justify-content: space-between; gap: 12px;
    font-size: 7.5px; color: var(--muted);
  }

  @media screen {
    body { background: var(--sage-strong); padding: 24px 0; }
    .sheet { background: #fff; padding: 10mm; border-radius: 6px; box-shadow: 0 12px 34px rgba(16,25,18,0.10); }
  }
</style>
</head>
<body>
  <div class="sheet">
    <header class="masthead">
      <div class="brand">
        ${logo}
        <div class="issuer-name">${esc(emisor.razonSocial ?? emisor.nombreComercial)}</div>
      </div>
      <div class="doc-head">
        <div class="doc-kicker">Documento tributario electrónico</div>
        <div class="doc-type">${esc(tipo)}</div>
      </div>
    </header>

    ${aviso}

    <section class="ident">
      <div class="id-card">
        ${campoDte('Número de control', dte?.numeroControl, 'c2')}
        ${campoDte('Código de generación', dte?.codigoGeneracion, 'c2')}
        ${campoDte('Sello de recepción', dte?.selloRecepcion, 'c2')}
        ${campoOp('Fecha y hora de emisión', fecha)}
        ${campoOp('Ambiente', !dte ? null : pruebas ? 'Pruebas (00)' : 'Producción (01)')}
        <div class="id-sep"></div>
        ${campoOp('Orden', sale.order_number)}
        ${campoOp('Sucursal', sale.branch_name)}
        ${campoOp('Vehículo', sale.plate)}
        ${campoOp('Forma de pago', sale.payment_method)}
      </div>
      <div class="qr-card">
        ${dte?.qrUrl
          ? `${qrSvg(dte.qrUrl, { color: '#16191A', margen: 0 })}
             <div class="qr-note">Verificá en<br/><strong>admin.factura.gob.sv</strong></div>`
          : `<div class="qr-placeholder">El QR de verificación aparece cuando el MH sella el documento</div>`}
      </div>
    </section>

    <section class="parties">
      ${emisorCard}
      ${receptorCard}
    </section>

    <table>
      <thead>
        <tr><th style="width:58%">Descripción</th><th class="num">Cant.</th><th class="num">Precio unitario</th><th class="num">Ventas gravadas</th></tr>
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
      <span>${esc(emisor.razonSocial ?? emisor.nombreComercial)} · CORSA Carwash</span>
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
export function printFactura(
  sale: Sale, emisor: TicketEmisor, dte: DteDeVenta | null = null, ventana?: Window | null,
): void {
  const w = ventana ?? window.open('', `corsa_factura_${sale.order_id}`, 'width=900,height=1000')
  if (!w) {
    throw new Error('El navegador bloqueó la ventana. Permití popups para este sitio.')
  }
  w.document.open()
  w.document.write(buildFacturaHTML(sale, emisor, dte))
  w.document.close()
}
