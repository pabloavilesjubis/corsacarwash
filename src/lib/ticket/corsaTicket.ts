/**
 * CORSA Carwash — Ticket térmico 80 mm
 *
 * Adaptado del generador de BEON Nutrition (src/tienda-pos.jsx). Se mantiene
 * su enfoque —HTML standalone que se imprime en ventana nueva y se previsualiza
 * en un iframe— y su regla de oro para térmica:
 *
 *   Las impresoras térmicas imprimen NEGRO o NADA. No hay grises ni medios
 *   tonos: todo gris sale fantasma o invisible. Por eso TODO el texto es #000
 *   puro y la jerarquía se construye con font-weight, font-size y bordes.
 *
 * Espaciado: comprimido al mínimo sin quitar información — el ticket se
 * imprime decenas de veces por día y cada milímetro es papel. El bloque
 * operativo de arriba queda intacto a propósito: ahí el tamaño ES la función.
 *
 * Diferencia con BEON: la cabecera operativa. El ticket de CORSA además de
 * comprobante fiscal es la orden que lee el equipo en piso, así que arriba de
 * todo van dos cuadrantes grandes — programa de máquina y aspirado — legibles
 * sin desdoblar el papel.
 */

import { resolveServiceProgram } from './servicePrograms'

// ─── Tipos ───────────────────────────────────────────────────

export interface TicketEmisor {
  nombreComercial: string
  razonSocial?: string
  nit?: string
  nrc?: string
  direccion?: string
  telefono?: string
  /** 'PRUEBA' o 'PRODUCCIÓN' — el MH exige distinguir el ambiente. */
  ambiente?: string
}

export interface TicketLinea {
  nombre: string
  cantidad: number
  precioUnitario: number
  subtotal: number
}

export interface TicketVenta {
  id?: string
  fecha?: string
  lineas: TicketLinea[]
  total: number
  iva?: number
  descuento?: number
  metodoPago?: string
}

export interface TicketDte {
  /** '01' = Consumidor Final, '03' = Crédito Fiscal. */
  tipoDte?: string
  numeroControl?: string
  codigoGeneracion?: string
  selloRecibido?: string
  /** URL de consulta pública del MH; se convierte a QR si no es imagen. */
  qrUrl?: string
  fhProcesamiento?: string
}

export interface TicketCliente {
  nombre?: string
  tipoDocumento?: string
  numeroDocumento?: string
  nrc?: string
}

/** Lo que el equipo de piso necesita leer de un vistazo. */
export interface TicketOperacion {
  /** Nombre o código del servicio facturado (ej. "Elite"). */
  servicio: string
  /** Si el servicio incluye aspirado. */
  aspirado: boolean
  placa?: string
  vehiculo?: string
  /** Correlativo visible de la orden de trabajo. */
  ordenNumero?: string
}

export interface TicketArgs {
  emisor: TicketEmisor
  venta: TicketVenta
  operacion: TicketOperacion
  dte?: TicketDte
  cliente?: TicketCliente
  atendio?: string
}

// ─── Helpers ─────────────────────────────────────────────────

const DTE_LABELS: Record<string, string> = {
  '01': 'FACTURA DE CONSUMIDOR FINAL',
  '03': 'COMPROBANTE DE CRÉDITO FISCAL',
  '14': 'FACTURA DE SUJETO EXCLUIDO',
}

/** Escapado defensivo: el ticket inyecta strings que vienen de la base. */
function esc(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function money(n: number): string {
  return `$${(Number(n) || 0).toFixed(2)}`
}

/**
 * Fuente del <img> del QR. Si ya es una imagen se usa directo; si es la URL de
 * consulta del MH (el caso normal) se codifica con un servicio público.
 */
function qrImgSrc(value: string): string {
  if (/\.(png|jpe?g|svg|webp|gif)(\?|$)/i.test(value)) return value
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=4&qzone=2&data=${encodeURIComponent(value)}`
}

/**
 * Check y X como SVG, no como carácter.
 *
 * Un ✓ o ✗ tipográfico depende de que la fuente lo tenga; si falta, la térmica
 * imprime un rectángulo vacío y el operario no sabe si aspirar. El trazo SVG
 * siempre rasteriza igual.
 */
function marcaAspirado(aspirado: boolean): string {
  return aspirado
    ? `<svg viewBox="0 0 100 100" class="mark" aria-label="Sí lleva aspirado">
         <path d="M14 52 L38 78 L86 22" fill="none" stroke="#000"
               stroke-width="18" stroke-linecap="square" stroke-linejoin="miter"/>
       </svg>`
    : `<svg viewBox="0 0 100 100" class="mark" aria-label="No lleva aspirado">
         <path d="M18 18 L82 82 M82 18 L18 82" fill="none" stroke="#000"
               stroke-width="18" stroke-linecap="square"/>
       </svg>`
}

// ─── Generador ───────────────────────────────────────────────

export function buildCorsaTicketHTML(args: TicketArgs): string {
  const { emisor: e, venta: v, operacion: op, dte: d = {}, cliente: cli, atendio } = args

  const programa = resolveServiceProgram(op.servicio)
  const tipoLabel = (d.tipoDte && DTE_LABELS[d.tipoDte])
    ?? (d.numeroControl ? 'DTE' : 'TICKET DE VENTA')

  const fechaEmision = d.fhProcesamiento
    ?? (v.fecha ? new Date(v.fecha).toLocaleString('es-SV') : '')

  const sello = d.selloRecibido
    ? `${d.selloRecibido.slice(0, 40)}${d.selloRecibido.length > 40 ? '…' : ''}`
    : ''

  const iva = v.iva ?? (v.total ? (v.total * 0.13) / 1.13 : 0)
  const subSinIva = (v.total ?? 0) - iva
  const descuento = v.descuento ?? 0

  const lineasHTML = v.lineas.map(l => `
      <div class="line">
        <div class="line-name">${esc(l.nombre)}</div>
        <div class="line-row">
          <span class="line-qty">${l.cantidad} × ${money(l.precioUnitario)}</span>
          <span class="line-total">${money(l.subtotal)}</span>
        </div>
      </div>`).join('')

  // ── Cabecera operativa: los dos cuadrantes ──
  const opBlock = `
    <div class="op-grid">
      <div class="op-cell">
        <div class="op-label">Servicio</div>
        ${programa
          ? `<div class="op-number">${programa.program}</div>
             <div class="op-sub">${esc(programa.label)}</div>`
          // Sin tier reconocido no se inventa un número: mandaría al operario
          // a activar el programa equivocado.
          : `<div class="op-number op-number-unknown">?</div>
             <div class="op-sub">${esc(op.servicio)}</div>`}
      </div>
      <div class="op-cell op-cell-right">
        <div class="op-label">Aspirado</div>
        ${marcaAspirado(op.aspirado)}
      </div>
    </div>
    ${(op.placa || op.vehiculo || op.ordenNumero) ? `
    <div class="op-meta">
      ${op.placa ? `<span class="op-plate">${esc(op.placa)}</span>` : ''}
      ${op.vehiculo ? `<span>${esc(op.vehiculo)}</span>` : ''}
      ${op.ordenNumero ? `<span>Orden ${esc(op.ordenNumero)}</span>` : ''}
    </div>` : ''}`

  const clienteBlock = cli?.nombre && cli.nombre !== 'Consumidor Final'
    ? `<div class="kv-block">
         <div class="kv-row"><span class="k">Cliente</span><span class="v">${esc(cli.nombre)}</span></div>
         ${cli.numeroDocumento ? `<div class="kv-row"><span class="k">${esc(cli.tipoDocumento || 'Doc')}</span><span class="v mono">${esc(cli.numeroDocumento)}</span></div>` : ''}
         ${cli.nrc ? `<div class="kv-row"><span class="k">NRC</span><span class="v mono">${esc(cli.nrc)}</span></div>` : ''}
       </div>`
    : `<div class="kv-block"><div class="kv-row"><span class="k">Cliente</span><span class="v">Consumidor Final</span></div></div>`

  const dteBlock = d.numeroControl
    ? `<div class="dte-block">
         <div class="dte-row">
           <div class="dte-label">N° de control</div>
           <div class="dte-value mono strong">${esc(d.numeroControl)}</div>
         </div>
         <div class="dte-row">
           <div class="dte-label">Código de generación</div>
           <div class="dte-value mono small wrap">${esc(d.codigoGeneracion)}</div>
         </div>
         ${sello ? `<div class="dte-row">
           <div class="dte-label">Sello de recepción</div>
           <div class="dte-value mono small wrap">${esc(sello)}</div>
         </div>` : ''}
       </div>`
    : ''

  const qrBlock = d.qrUrl
    ? `<div class="qr-block">
         <img src="${esc(qrImgSrc(d.qrUrl))}" alt="QR DTE" class="qr-img"/>
         <div class="qr-caption">Escaneá para verificar en<br/>Hacienda · admin.factura.gob.sv</div>
       </div>`
    : ''

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>Ticket ${esc(d.numeroControl || v.id || 'CORSA')}</title>
<style>
  /* ════════════════════════════════════════════════════════
     REGLA DE ORO (heredada del ticket de BEON):
     La térmica imprime NEGRO o NADA. Sin grises, sin medios
     tonos. Todo #000 puro; la jerarquía es peso, tamaño y
     bordes — nunca color.
     ════════════════════════════════════════════════════════ */
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; color: #000 !important; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 12px; line-height: 1.25;
    padding: 3mm 2mm; width: 100%;
    -webkit-font-smoothing: none;   /* anti-aliasing apagado: nitidez térmica */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .ticket { width: 100%; text-align: center; }

  /* ── Cabecera operativa ── */
  .op-grid {
    display: flex; width: 100%;
    border: 3px solid #000; margin-bottom: 6px;
  }
  .op-cell {
    flex: 1 1 50%; padding: 6px 2px 7px;
    display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
  }
  /* Divisoria entre cuadrantes */
  .op-cell-right { border-left: 3px solid #000; }
  .op-label {
    font-size: 10px; font-weight: 900; letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .op-number {
    font-size: 62px; font-weight: 900; line-height: 0.95;
    margin: 2px 0 0; font-variant-numeric: tabular-nums;
  }
  .op-number-unknown { font-size: 48px; }
  .mark { width: 70px; height: 70px; margin: 4px 0 2px; display: block; }
  .op-sub {
    font-size: 11px; font-weight: 900; letter-spacing: 0.08em;
    margin-top: 3px; text-align: center; line-height: 1.15;
  }
  .op-meta {
    display: flex; justify-content: center; gap: 8px; flex-wrap: wrap;
    font-size: 11px; font-weight: 700; margin-bottom: 6px;
  }
  .op-plate {
    border: 2px solid #000; padding: 1px 6px;
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; font-weight: 900;
  }

  /* ── Branding ── */
  .brand-block { text-align: center; margin-bottom: 4px; }
  .brand-name { font-size: 24px; font-weight: 900; letter-spacing: 0.16em; line-height: 1; }
  .brand-tag { font-size: 10px; font-weight: 700; letter-spacing: 0.24em; margin-top: 3px; text-transform: uppercase; }
  .legal-name { font-size: 11px; font-weight: 700; margin-top: 4px; }
  .legal-meta { font-size: 10px; font-weight: 600; margin-top: 2px; }
  .legal-addr { font-size: 10px; font-weight: 400; margin-top: 2px; padding: 0 2px; }

  /* Separadores: siempre negro sólido (los dashed claros desaparecen) */
  .sep       { border: none; border-top: 1px solid #000; margin: 4px 0; }
  .sep-solid { border: none; border-top: 2px solid #000; margin: 4px 0; }

  .doc-type { text-align: center; margin: 5px 0 3px; }
  .doc-type-name { font-size: 13px; font-weight: 900; letter-spacing: 0.06em; }
  .doc-type-amb { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; margin-top: 2px; }

  .dte-block { margin: 5px 0; text-align: left; }
  .dte-row { margin-bottom: 3px; }
  .dte-label { font-size: 9px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 1px; }
  .dte-value { font-size: 11px; line-height: 1.2; font-weight: 700; }
  .mono { font-family: 'SF Mono', 'Menlo', 'Consolas', 'Courier New', monospace; }
  .strong { font-weight: 900; }
  .small { font-size: 10px; font-weight: 400; }
  .wrap { word-break: break-all; overflow-wrap: anywhere; }
  .fecha-row { font-size: 10px; font-weight: 700; text-align: right; margin-top: 2px; }

  .kv-block { margin: 3px 0; text-align: left; }
  .kv-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 700; padding: 1px 0; }
  .kv-row .k { flex-shrink: 0; }
  .kv-row .v { text-align: right; word-break: break-word; font-weight: 400; }

  .items { margin: 2px 0; text-align: left; }
  .line { margin-bottom: 4px; }
  .line-name { font-size: 12px; line-height: 1.2; font-weight: 700; }
  .line-row { display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; margin-top: 1px; }
  .line-qty { font-family: 'SF Mono', monospace; }
  .line-total { font-family: 'SF Mono', monospace; font-weight: 900; }

  .totals { margin: 2px 0; font-size: 12px; text-align: left; }
  .totals-row { display: flex; justify-content: space-between; padding: 1px 0; font-weight: 600; }
  .totals-row.total {
    font-size: 18px; font-weight: 900; padding: 5px 0 4px; margin-top: 4px;
    border-top: 2px solid #000; border-bottom: 2px solid #000;
  }
  .totals-row .v { font-family: 'SF Mono', monospace; }
  .pay-row { display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; margin-top: 4px; padding: 2px 0; }

  .qr-block { text-align: center; margin: 7px 0 4px; }
  .qr-img { width: 40mm; height: 40mm; max-width: 100%; background: #fff; display: inline-block; }
  .qr-caption { font-size: 10px; font-weight: 600; margin-top: 3px; line-height: 1.3; }

  .footer { text-align: center; margin-top: 6px; padding-top: 4px; border-top: 1px solid #000; }
  .footer-thanks { font-size: 12px; font-weight: 900; }
  .footer-meta { font-size: 10px; font-weight: 600; margin-top: 2px; letter-spacing: 0.04em; }

  /* Espacio para que la cuchilla no corte información */
  .bottom-pad { height: 12px; }

  @media print {
    body { padding: 1.5mm 1mm; }
    @page { margin: 0; }
  }
</style>
</head>
<body>
  <div class="ticket">
    ${opBlock}

    <div class="brand-block">
      <div class="brand-name">${esc(e.nombreComercial)}</div>
      ${e.razonSocial ? `<div class="legal-name">${esc(e.razonSocial)}</div>` : ''}
      ${(e.nit || e.nrc) ? `<div class="legal-meta">${e.nit ? `NIT ${esc(e.nit)}` : ''}${(e.nit && e.nrc) ? ' · ' : ''}${e.nrc ? `NRC ${esc(e.nrc)}` : ''}</div>` : ''}
      ${e.direccion ? `<div class="legal-addr">${esc(e.direccion)}</div>` : ''}
      ${e.telefono ? `<div class="legal-meta">Tel: ${esc(e.telefono)}</div>` : ''}
    </div>

    <hr class="sep-solid"/>

    <div class="doc-type">
      <div class="doc-type-name">${esc(tipoLabel)}</div>
      ${e.ambiente ? `<div class="doc-type-amb">${esc(e.ambiente)}</div>` : ''}
    </div>

    ${dteBlock}
    ${fechaEmision ? `<div class="fecha-row">Emisión: ${esc(fechaEmision)}</div>` : ''}

    <hr class="sep"/>
    ${clienteBlock}
    ${atendio ? `<div class="kv-block"><div class="kv-row"><span class="k">Atendió</span><span class="v">${esc(atendio)}</span></div></div>` : ''}

    <hr class="sep"/>
    <div class="items">${lineasHTML}</div>

    <hr class="sep"/>
    <div class="totals">
      <div class="totals-row"><span class="k">Subtotal s/IVA</span><span class="v">${money(subSinIva)}</span></div>
      <div class="totals-row"><span class="k">IVA 13%</span><span class="v">${money(iva)}</span></div>
      ${descuento > 0 ? `<div class="totals-row"><span class="k">Descuento</span><span class="v">−${money(descuento)}</span></div>` : ''}
      <div class="totals-row total"><span class="k">TOTAL</span><span class="v">${money(v.total)}</span></div>
      ${v.metodoPago ? `<div class="pay-row"><span>Pago</span><span>${esc(v.metodoPago)}</span></div>` : ''}
    </div>

    ${qrBlock}

    <div class="footer">
      <div class="footer-thanks">¡Gracias por su preferencia!</div>
      <div class="footer-meta">CORSA Carwash · ${new Date().toLocaleDateString('es-SV')}</div>
    </div>

    <div class="bottom-pad"></div>
  </div>
  <script>
    // Auto-print al cargar. El preview inyecta window._corsaPreview para evitarlo.
    if (!window._corsaPreview && !new URLSearchParams(location.search).get('noprint')) {
      window.addEventListener('load', function () {
        setTimeout(function () { window.focus(); window.print(); }, 150);
      });
    }
  </script>
</body>
</html>`
}

/** Abre el ticket en una ventana nueva que se auto-imprime. */
export function printCorsaTicket(args: TicketArgs): void {
  const html = buildCorsaTicketHTML(args)
  const w = window.open('', `corsa_ticket_${args.venta.id ?? Date.now()}`, 'width=420,height=760')
  if (!w) {
    throw new Error('El navegador bloqueó la ventana de impresión. Permití popups para este sitio.')
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
}

/** Misma salida, con el auto-print desactivado — para previsualizar en iframe. */
export function buildCorsaTicketPreviewHTML(args: TicketArgs): string {
  return buildCorsaTicketHTML(args).replace(
    '<head>',
    '<head><script>window._corsaPreview=true</script>'
  )
}
