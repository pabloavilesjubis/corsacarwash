/**
 * CORSA Carwash — Representación gráfica del DTE (tamaño carta)
 *
 * Es el documento que se adjunta al correo del cliente, distinto del ticket
 * térmico de 80 mm: aquel es comprobante y orden de trabajo a la vez; éste es
 * el respaldo formal que la gente archiva o presenta a su contador.
 *
 * Mientras no se transmita al MH faltan el número de control, el código de
 * generación, el sello y el QR. En vez de dejar huecos en blanco —que parecen
 * un error de impresión— el documento los marca explícitamente como pendientes
 * y se rotula como no transmitido. Cuando el DTE exista, esos campos se llenan
 * y el rótulo desaparece.
 */

import type { Sale } from '../../services/sales.service'
import { EMISOR } from '../ticket/fromSale'
import { findDepartamento, findMunicipio } from '../mh-catalogs'

export interface FacturaDte {
  numeroControl?: string
  codigoGeneracion?: string
  selloRecibido?: string
  qrUrl?: string
  fhProcesamiento?: string
}

const TIPO_LABEL: Record<string, string> = {
  consumidor_final: 'FACTURA DE CONSUMIDOR FINAL',
  credito_fiscal: 'COMPROBANTE DE CRÉDITO FISCAL',
  nota_credito: 'NOTA DE CRÉDITO',
  nota_debito: 'NOTA DE DÉBITO',
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

/** Campo del encabezado fiscal; sin valor se muestra como pendiente. */
function campoDte(label: string, value?: string): string {
  return `<div class="dte-field">
    <div class="dte-label">${esc(label)}</div>
    <div class="dte-value ${value ? 'mono' : 'pending'}">${value ? esc(value) : 'Pendiente de transmisión'}</div>
  </div>`
}

export function buildFacturaHTML(sale: Sale, dte: FacturaDte = {}): string {
  const tipo = TIPO_LABEL[sale.invoice_type ?? ''] ?? 'DOCUMENTO DE VENTA'
  const emitido = Boolean(dte.numeroControl)
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

  const fecha = new Date(sale.created_at).toLocaleString('es-SV', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  // Las líneas vienen de la venta. El fallback es para ventas viejas que se
  // guardaron antes de que la vista las expusiera: mejor una línea agregada
  // que un desglose inventado.
  const lineas = sale.items?.length
    ? sale.items.map(i => ({ desc: i.descripcion, cantidad: i.cantidad, unitario: i.unitario, total: i.total }))
    : [{ desc: sale.service_name ?? 'Servicio de lavado', cantidad: 1, unitario: total, total }]

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>${esc(sale.invoice_number || sale.order_number)}</title>
<style>
  @page { size: letter; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 11px; color: #111; line-height: 1.45;
  }
  .sheet { max-width: 190mm; margin: 0 auto; }

  /* Aviso de no transmitido: franja evidente para que nadie lo confunda con
     un documento válido ante el MH. */
  .draft-banner {
    border: 2px solid #B23232; color: #B23232; background: #FBE7E7;
    padding: 8px 12px; border-radius: 4px; margin-bottom: 14px;
    font-size: 11.5px; font-weight: 700; text-align: center;
  }

  header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
  .brand-name { font-size: 26px; font-weight: 900; letter-spacing: 0.14em; }
  .emisor { font-size: 10.5px; margin-top: 6px; line-height: 1.5; }
  .emisor strong { display: block; font-size: 11.5px; }

  .doc-box { border: 2px solid #111; border-radius: 4px; padding: 10px 14px; min-width: 74mm; }
  .doc-type { font-size: 12px; font-weight: 900; text-align: center; letter-spacing: 0.04em; margin-bottom: 8px; }
  .dte-field { margin-bottom: 6px; }
  .dte-label { font-size: 8.5px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; color: #555; }
  .dte-value { font-size: 10.5px; font-weight: 700; word-break: break-all; }
  .dte-value.pending { color: #B23232; font-weight: 600; font-style: italic; }
  .mono { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; }

  .parties { display: flex; gap: 14px; margin: 18px 0 14px; }
  .party { flex: 1; border: 1px solid #ccc; border-radius: 4px; padding: 10px 12px; }
  .party-title { font-size: 8.5px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; color: #555; margin-bottom: 5px; }
  .party-row { font-size: 10.5px; line-height: 1.5; }
  .party .mono { font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; }

  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { background: #f1f1ef; font-size: 9px; text-transform: uppercase; letter-spacing: 0.07em;
       text-align: left; padding: 7px 9px; border-bottom: 1.5px solid #111; }
  td { padding: 8px 9px; border-bottom: 1px solid #e3e3e0; font-size: 11px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  .totals { margin-top: 12px; margin-left: auto; width: 78mm; }
  .totals-row { display: flex; justify-content: space-between; padding: 4px 9px; font-size: 11px; }
  .totals-row.grand {
    font-size: 14px; font-weight: 900; border-top: 2px solid #111; border-bottom: 2px solid #111;
    padding: 8px 9px; margin-top: 4px;
  }

  .qr-area { display: flex; gap: 16px; align-items: center; margin-top: 20px;
             border-top: 1px solid #ccc; padding-top: 14px; }
  .qr-area img { width: 32mm; height: 32mm; }
  .qr-note { font-size: 10px; color: #444; line-height: 1.5; }

  footer { margin-top: 18px; border-top: 1px solid #ccc; padding-top: 10px;
           font-size: 9.5px; color: #555; text-align: center; }

  @media print { .draft-banner { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
  <div class="sheet">
    ${emitido ? '' : `<div class="draft-banner">
      DOCUMENTO NO TRANSMITIDO AL MINISTERIO DE HACIENDA · Sin validez fiscal hasta obtener el sello de recepción
    </div>`}

    <header>
      <div>
        <div class="brand-name">${esc(EMISOR.nombreComercial)}</div>
        <div class="emisor">
          <strong>${esc(EMISOR.razonSocial)}</strong>
          NIT ${esc(EMISOR.nit)} · NRC ${esc(EMISOR.nrc)}<br/>
          ${esc(EMISOR.direccion)}<br/>
          Tel. ${esc(EMISOR.telefono)}
        </div>
      </div>
      <div class="doc-box">
        <div class="doc-type">${esc(tipo)}</div>
        ${campoDte('Número de control', dte.numeroControl)}
        ${campoDte('Código de generación', dte.codigoGeneracion)}
        ${campoDte('Sello de recepción', dte.selloRecibido)}
        <div class="dte-field">
          <div class="dte-label">Fecha y hora de emisión</div>
          <div class="dte-value">${esc(fecha)}</div>
        </div>
      </div>
    </header>

    <div class="parties">
      <div class="party">
        <div class="party-title">Receptor</div>
        <div class="party-row"><strong>${esc(sale.customer_name)}</strong></div>
        ${sale.customer_trade_name && sale.customer_trade_name !== sale.customer_name
          ? `<div class="party-row">Nombre comercial: ${esc(sale.customer_trade_name)}</div>` : ''}
        ${sale.customer_nit ? `<div class="party-row">NIT: <span class="mono">${esc(sale.customer_nit)}</span></div>` : ''}
        ${sale.customer_dui && !sale.customer_nit ? `<div class="party-row">DUI: <span class="mono">${esc(sale.customer_dui)}</span></div>` : ''}
        ${sale.customer_nrc ? `<div class="party-row">NRC: <span class="mono">${esc(sale.customer_nrc)}</span></div>` : ''}
        ${sale.customer_desc_actividad
          ? `<div class="party-row">Actividad: ${esc(sale.customer_desc_actividad)}${sale.customer_cod_actividad ? ` (${esc(sale.customer_cod_actividad)})` : ''}</div>` : ''}
        ${direccionReceptor ? `<div class="party-row">Dirección: ${esc(direccionReceptor)}</div>` : ''}
        ${sale.customer_phone ? `<div class="party-row">Tel.: ${esc(sale.customer_phone)}</div>` : ''}
        ${sale.customer_email ? `<div class="party-row">Correo: ${esc(sale.customer_email)}</div>` : ''}
        ${sale.plate ? `<div class="party-row">Vehículo: ${esc(sale.plate)}</div>` : ''}
      </div>
      <div class="party">
        <div class="party-title">Datos de la operación</div>
        <div class="party-row">Orden: <strong>${esc(sale.order_number)}</strong></div>
        <div class="party-row">Sucursal: ${esc(sale.branch_name)}</div>
        <div class="party-row">Forma de pago: ${esc(sale.payment_method ?? '—')}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr><th style="width:60%">Descripción</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Total</th></tr>
      </thead>
      <tbody>
        ${lineas.map(l => `<tr>
          <td>${esc(l.desc)}</td>
          <td class="num">${esc(l.cantidad)}</td>
          <td class="num">${money(l.unitario)}</td>
          <td class="num">${money(l.total)}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <div class="totals">
      <div class="totals-row"><span>Subtotal sin IVA</span><span class="num">${money(subtotal)}</span></div>
      <div class="totals-row"><span>IVA 13%</span><span class="num">${money(iva)}</span></div>
      <div class="totals-row grand"><span>TOTAL A PAGAR</span><span class="num">${money(total)}</span></div>
    </div>

    <div class="qr-area">
      ${dte.qrUrl
        ? `<img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=2&data=${encodeURIComponent(dte.qrUrl)}" alt="QR del DTE"/>
           <div class="qr-note">Escaneá el código para verificar este documento en<br/>
             <strong>admin.factura.gob.sv</strong></div>`
        : `<div class="qr-note">
             El código QR de verificación se genera cuando el documento se transmite
             al Ministerio de Hacienda y se recibe el sello correspondiente.
           </div>`}
    </div>

    <footer>
      ${esc(EMISOR.razonSocial)} · Documento generado el ${new Date().toLocaleDateString('es-SV')}
    </footer>
  </div>
  <script>
    if (!new URLSearchParams(location.search).get('noprint')) {
      window.addEventListener('load', function () {
        setTimeout(function () { window.focus(); window.print(); }, 200);
      });
    }
  </script>
</body>
</html>`
}

/** Abre la factura en una ventana nueva lista para imprimir o guardar en PDF. */
export function printFactura(sale: Sale, dte: FacturaDte = {}): void {
  const w = window.open('', `corsa_factura_${sale.order_id}`, 'width=900,height=1000')
  if (!w) {
    throw new Error('El navegador bloqueó la ventana. Permití popups para este sitio.')
  }
  w.document.open()
  w.document.write(buildFacturaHTML(sale, dte))
  w.document.close()
}
