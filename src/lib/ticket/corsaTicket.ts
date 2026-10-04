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
import { formatearFechaHora } from '../../utils/fecha'
import { qrSvg } from '../fiscal/qr'
import { LOGO_PATH, LOGO_VIEWBOX } from '../../brand/logoCompleto'

// ─── Tipos ───────────────────────────────────────────────────

export interface TicketEmisor {
  nombreComercial: string
  razonSocial?: string
  nit?: string
  nrc?: string
  direccion?: string
  telefono?: string
  correo?: string
  /** Actividad económica inscrita (CAT-019). */
  codActividad?: string
  descActividad?: string
  /** CAT-008: 'Casa matriz', 'Sucursal'… */
  tipoEstablecimiento?: string
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
  /** URL de consulta pública del MH; el ticket la dibuja como QR. */
  qrUrl?: string
  fhProcesamiento?: string
  /** Estado en fiscal_documents. Sólo cambia el papel si es INVALIDATED. */
  estado?: string
}

/**
 * Receptor del documento. Para un CCF el MH exige nombre, NIT, NRC, actividad
 * económica, dirección, teléfono y correo (fe-ccf-v3.json); la representación
 * impresa tiene que mostrarlos, no sólo el nombre.
 */
export interface TicketCliente {
  nombre?: string
  tipoDocumento?: string
  numeroDocumento?: string
  nrc?: string
  actividad?: string
  direccion?: string
  telefono?: string
  correo?: string
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

/**
 * Canje de cupón. Cuando viene, el ticket reemplaza todo el bloque fiscal
 * —documento, totales, IVA y QR— por un resumen del canje: el cupón ya se
 * facturó el día que se vendió, y volver a imprimir importes acá haría parecer
 * que hubo un segundo cobro.
 */
export interface TicketRedencion {
  codigoCupon: string
  clienteNombre: string
  valor: number
  fecha: string
}

/**
 * Seguro de lluvia comprado con esta venta.
 *
 * Lo que va impreso es lo que el cliente va a mostrar cuando vuelva, así que
 * tiene que bastarse solo: hasta cuándo vale, con hora, y sobre qué placa. Un
 * «válido 48 horas» sin fecha obliga a reconstruir mentalmente desde cuándo
 * corre, y ahí es donde empiezan las discusiones en el mostrador.
 */
export interface TicketSeguroLluvia {
  placa: string
  /** ISO del momento de la compra. */
  desde: string
  /** ISO del vencimiento — 48 horas después. */
  hasta: string
  /** Regalado por la caja (0053): se imprime rotulado como cortesía. */
  cortesia?: boolean
}

/**
 * Seguro de cortesía SIN venta. Cuando viene, el ticket es sólo el seguro: ni
 * cabecera de lavado, ni bloque fiscal, ni importes —no hubo cobro, y un
 * ticket con totales en cero parecería una venta mal hecha—.
 */
export interface TicketCortesia {
  clienteNombre: string
  fecha: string
  /**
   * Seguro PAGADO con una venta. El ticket aparte del seguro sale con el mismo
   * formato, pero dice de qué orden es y que el cobro va en el de facturación.
   */
  pagado?: { orden: string; precio: number }
}

/**
 * Orden de lavado de UN carro de una venta con varios (0057). Sale la
 * cabecera operativa —programa, aspirado, placa— y nada fiscal: la factura de
 * todos los carros va en el ticket de cobro.
 */
export interface TicketOrdenDeLavado {
  orden: string
  indice: number
  total: number
  cliente?: string
}

export interface TicketArgs {
  emisor: TicketEmisor
  venta: TicketVenta
  operacion: TicketOperacion
  dte?: TicketDte
  cliente?: TicketCliente
  atendio?: string
  redencion?: TicketRedencion
  seguroLluvia?: TicketSeguroLluvia
  cortesia?: TicketCortesia
  ordenDeLavado?: TicketOrdenDeLavado
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
 * El logo completo, en negro. Es el mismo trazo de la pantalla de ingreso: un
 * «CORSA» escrito con la fuente del ticket sería otra marca.
 */
const LOGO_SVG = `<svg class="brand-logo" viewBox="0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}" role="img" aria-label="CORSA Carwash">`
  + `<path d="${LOGO_PATH}" fill="#000" fill-rule="evenodd"/></svg>`

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
  const { emisor: e, venta: v, operacion: op, dte: d = {}, cliente: cli, atendio, redencion, seguroLluvia, cortesia, ordenDeLavado } = args

  const programa = resolveServiceProgram(op.servicio)
  const tipoLabel = (d.tipoDte && DTE_LABELS[d.tipoDte])
    ?? (d.numeroControl ? 'DTE' : 'TICKET DE VENTA')

  const fechaEmision = d.fhProcesamiento
    ?? (v.fecha ? formatearFechaHora(v.fecha, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }) : '')


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
         <div class="kv-label-row">Receptor</div>
         <div class="kv-row"><span class="k">Nombre</span><span class="v">${esc(cli.nombre)}</span></div>
         ${cli.numeroDocumento ? `<div class="kv-row"><span class="k">${esc(cli.tipoDocumento || 'Doc')}</span><span class="v mono">${esc(cli.numeroDocumento)}</span></div>` : ''}
         ${cli.nrc ? `<div class="kv-row"><span class="k">NRC</span><span class="v mono">${esc(cli.nrc)}</span></div>` : ''}
         ${cli.actividad ? `<div class="kv-row"><span class="k">Actividad</span><span class="v">${esc(cli.actividad)}</span></div>` : ''}
         ${cli.direccion ? `<div class="kv-row"><span class="k">Dirección</span><span class="v">${esc(cli.direccion)}</span></div>` : ''}
         ${cli.telefono ? `<div class="kv-row"><span class="k">Teléfono</span><span class="v">${esc(cli.telefono)}</span></div>` : ''}
         ${cli.correo ? `<div class="kv-row"><span class="k">Correo</span><span class="v wrap">${esc(cli.correo)}</span></div>` : ''}
       </div>`
    : `<div class="kv-block"><div class="kv-row"><span class="k">Cliente</span><span class="v">Consumidor Final</span></div></div>`

  /**
   * El seguro, impreso con marco grueso.
   *
   * No es un dato más de la venta: es el comprobante de un derecho que vence.
   * Va con borde doble y las horas completas —no «48 h»— porque el papel se
   * guarda en la guantera y se lee dos días después, cuando ya nadie se
   * acuerda a qué hora se compró.
   */
  const seguroBlock = seguroLluvia ? `
    <div class="seguro-block">
      <div class="seguro-title">SEGURO DE LLUVIA</div>
      ${seguroLluvia.cortesia ? `<div class="seguro-cortesia">CORTESÍA</div>` : ''}
      <div class="seguro-sub">Un lavado PRO sin costo si llueve</div>
      <div class="seguro-plate">${esc(seguroLluvia.placa)}</div>
      <div class="seguro-rows">
        <div class="seguro-row"><span>Desde</span><span>${esc(formatearFechaHora(seguroLluvia.desde, {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }))}</span></div>
        <div class="seguro-row"><span>Válido hasta</span><span class="strong">${esc(formatearFechaHora(seguroLluvia.hasta, {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }))}</span></div>
      </div>
      <div class="seguro-legal">
        Válido únicamente para esta placa y presentando este ticket.
        Vence a la hora indicada.
      </div>
    </div>` : ''

  /**
   * El bloque del DTE tiene un lugar fijo en el ticket, haya documento o no.
   *
   * Con documento van completos el número de control, el código de generación
   * y el sello —sin recortar: son lo que el cliente o su contador teclean para
   * buscarlo, y un sello truncado no sirve para nada—. Sin documento el mismo
   * recuadro dice que está pendiente, en una línea: el ticket se imprime
   * decenas de veces al día y tres campos vacíos son papel tirado.
   */
  const invalidado = d.estado === 'INVALIDATED'
  // Sin DTE y sin NIT el ticket salió con la marca sola porque la
  // configuración fiscal está incompleta: no es ni será un documento
  // tributario, y el papel lo dice en vez de prometer una transmisión.
  const sinValidezFiscal = !d.numeroControl && !e.nit
  const dteBlock = sinValidezFiscal
    ? `<div class="dte-block dte-pending">
         <div class="dte-title">Comprobante interno</div>
         <div class="dte-pending-text">Sin validez fiscal</div>
       </div>`
    : d.numeroControl
    ? `<div class="dte-block">
         <div class="dte-title">Documento tributario electrónico</div>
         ${invalidado ? `<div class="dte-void">DOCUMENTO INVALIDADO</div>` : ''}
         <div class="dte-row">
           <div class="dte-label">Número de control</div>
           <div class="dte-value mono strong wrap">${esc(d.numeroControl)}</div>
         </div>
         <div class="dte-row">
           <div class="dte-label">Código de generación</div>
           <div class="dte-value mono wrap">${esc(d.codigoGeneracion)}</div>
         </div>
         <div class="dte-row">
           <div class="dte-label">Sello de recepción</div>
           <div class="dte-value mono wrap">${d.selloRecibido ? esc(d.selloRecibido) : 'Pendiente'}</div>
         </div>
       </div>`
    : `<div class="dte-block dte-pending">
         <div class="dte-title">Documento tributario electrónico</div>
         <div class="dte-pending-text">Pendiente de transmisión al Ministerio de Hacienda</div>
       </div>`

  const qrBlock = d.qrUrl
    ? `<div class="qr-block">
         <div class="qr-img">${qrSvg(d.qrUrl, { margen: 0 })}</div>
         <div class="qr-caption">Verificá este documento en<br/>admin.factura.gob.sv</div>
       </div>`
    : ''

  const cortesiaBlock = cortesia ? `
    <div class="redencion">
      <div class="redencion-title">${cortesia.pagado ? 'Seguro de lluvia' : 'Cortesía'}</div>
      <div class="kv-block">
        <div class="kv-row"><span class="k">Cliente</span><span class="v">${esc(cortesia.clienteNombre)}</span></div>
        <div class="kv-row"><span class="k">Fecha</span><span class="v">${esc(cortesia.fecha)}</span></div>
        ${cortesia.pagado ? `<div class="kv-row"><span class="k">Orden</span><span class="v">${esc(cortesia.pagado.orden)}</span></div>` : ''}
        ${atendio ? `<div class="kv-row"><span class="k">Atendió</span><span class="v">${esc(atendio)}</span></div>` : ''}
      </div>
      ${seguroBlock}
      <div class="redencion-note">
        ${cortesia.pagado
          ? `Seguro de lluvia pagado (${money(cortesia.pagado.precio)}) con la orden ${esc(cortesia.pagado.orden)}.<br/>
             El cobro va en el ticket de facturación.`
          : 'Seguro de lluvia de cortesía, sin costo.'}<br/>
        Este comprobante no es un documento tributario.
      </div>
    </div>` : ''

  const lavadoBlock = ordenDeLavado ? `
    <div class="redencion">
      <div class="redencion-title">Orden de lavado</div>
      <div class="redencion-code">Carro ${ordenDeLavado.indice} de ${ordenDeLavado.total}</div>
      <div class="kv-block">
        <div class="kv-row"><span class="k">Orden</span><span class="v">${esc(ordenDeLavado.orden)}</span></div>
        ${ordenDeLavado.cliente ? `<div class="kv-row"><span class="k">Cliente</span><span class="v">${esc(ordenDeLavado.cliente)}</span></div>` : ''}
        <div class="kv-row"><span class="k">Servicio</span><span class="v">${esc(op.servicio)}</span></div>
        <div class="kv-row"><span class="k">Aspirado</span><span class="v">${op.aspirado ? 'Incluido' : 'No incluye'}</span></div>
      </div>
      <div class="redencion-note">
        Comprobante interno de piso.<br/>
        El cobro de todos los carros va en el ticket de la orden.
      </div>
    </div>` : ''

  const redencionBlock = redencion ? `
    <div class="redencion">
      <div class="redencion-title">Canje de cupón</div>
      <div class="redencion-code">${esc(redencion.codigoCupon)}</div>
      <div class="kv-block">
        <div class="kv-row"><span class="k">Cliente</span><span class="v">${esc(redencion.clienteNombre)}</span></div>
        <div class="kv-row"><span class="k">Servicio</span><span class="v">${esc(op.servicio)}</span></div>
        <div class="kv-row"><span class="k">Aspirado</span><span class="v">${op.aspirado ? 'Incluido' : 'No incluye'}</span></div>
        <div class="kv-row"><span class="k">Fecha</span><span class="v">${esc(redencion.fecha)}</span></div>
      </div>
      <div class="redencion-note">
        Este comprobante no es un documento tributario.<br/>
        El cupón fue facturado al momento de su compra.
      </div>
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>${ordenDeLavado ? `Orden ${esc(ordenDeLavado.orden)} · carro ${ordenDeLavado.indice}` : cortesia ? (cortesia.pagado ? 'Seguro de lluvia' : 'Cortesía seguro de lluvia') : redencion ? `Canje ${esc(redencion.codigoCupon)}` : `Ticket ${esc(d.numeroControl || v.id || 'CORSA')}`}</title>
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

  /* ── Seguro de lluvia ── */
  .seguro-block {
    border: 3px solid #000; padding: 6px 8px; margin: 6px 0;
    text-align: center;
  }
  .seguro-title { font-size: 14px; font-weight: 900; letter-spacing: 0.1em; }
  .seguro-sub { font-size: 10px; font-weight: 700; margin-top: 2px; }
  .seguro-cortesia {
    display: inline-block; border: 2px solid #000; padding: 0 8px; margin-top: 3px;
    font-size: 12px; font-weight: 900; letter-spacing: 0.14em;
  }
  .seguro-plate {
    border: 2px solid #000; display: inline-block;
    padding: 2px 10px; margin: 5px 0 4px;
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 17px; font-weight: 900; letter-spacing: 0.08em;
  }
  .seguro-rows { font-size: 11px; font-weight: 700; }
  .seguro-row { display: flex; justify-content: space-between; padding: 1px 2px; }
  .seguro-row .strong { font-weight: 900; text-decoration: underline; }
  .seguro-legal { font-size: 9.5px; font-weight: 600; margin-top: 4px; line-height: 1.25; }

  /* ── Branding ── */
  .brand-block { text-align: center; margin-bottom: 4px; }
  .brand-logo { width: 30mm; height: auto; display: block; margin: 2px auto 3px; }
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

  /* Recuadro del DTE: mismo marco que la cabecera operativa, más fino. */
  .dte-block { margin: 5px 0; padding: 4px 6px 3px; border: 2px solid #000; text-align: left; }
  .dte-title {
    font-size: 9px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase;
    text-align: center; border-bottom: 1px solid #000; padding-bottom: 2px; margin-bottom: 3px;
  }
  .dte-void {
    font-size: 12px; font-weight: 900; letter-spacing: 0.08em; text-align: center;
    border: 2px solid #000; padding: 2px 0; margin-bottom: 3px;
  }
  .dte-row { margin-bottom: 3px; }
  .dte-label { font-size: 9px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 1px; }
  .dte-value { font-size: 10.5px; line-height: 1.2; font-weight: 700; }
  .dte-pending-text { font-size: 10px; font-weight: 700; text-align: center; padding: 1px 0 2px; }
  .mono { font-family: 'SF Mono', 'Menlo', 'Consolas', 'Courier New', monospace; }
  .strong { font-weight: 900; }
  .small { font-size: 10px; font-weight: 400; }
  .wrap { word-break: break-all; overflow-wrap: anywhere; }
  .fecha-row { font-size: 10px; font-weight: 700; text-align: right; margin-top: 2px; }

  .kv-block { margin: 3px 0; text-align: left; }
  .kv-label-row {
    font-size: 9px; font-weight: 900; letter-spacing: 0.1em;
    text-transform: uppercase; border-bottom: 1px solid #000;
    padding-bottom: 1px; margin-bottom: 2px;
  }
  .kv-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 700; padding: 1px 0; }
  .kv-row .k { flex-shrink: 0; }
  .kv-row .v { text-align: right; word-break: break-word; font-weight: 400; }

  /* Detalle: una línea por servicio. El operario y el cliente tienen que ver
     el lavado y el aspirado por separado, no un único importe agregado. */
  .items { margin: 2px 0; text-align: left; }
  .items-head {
    display: flex; justify-content: space-between;
    font-size: 9px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase;
    border-bottom: 1px solid #000; padding-bottom: 2px; margin-bottom: 4px;
  }
  .line { margin-bottom: 4px; padding-bottom: 3px; border-bottom: 1px dotted #000; }
  .line:last-child { border-bottom: none; }
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
  .qr-img { width: 38mm; height: 38mm; max-width: 100%; display: inline-block; }
  .qr-img svg { width: 100%; height: 100%; display: block; }
  .qr-caption { font-size: 10px; font-weight: 600; margin-top: 3px; line-height: 1.3; }

  .footer { text-align: center; margin-top: 6px; padding-top: 4px; border-top: 1px solid #000; }
  .footer-thanks { font-size: 12px; font-weight: 900; }
  .footer-meta { font-size: 10px; font-weight: 600; margin-top: 2px; letter-spacing: 0.04em; }

  /* Canje de cupón */
  .redencion { margin: 8px 0 4px; text-align: center; }
  .redencion-title {
    font-size: 12px; font-weight: 900; letter-spacing: 0.12em;
    text-transform: uppercase; border-top: 2px solid #000; border-bottom: 2px solid #000;
    padding: 5px 0;
  }
  .redencion-code {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 30px; font-weight: 900; letter-spacing: 0.06em; margin: 6px 0 2px;
  }
  .redencion-note { font-size: 10px; font-weight: 600; line-height: 1.35; margin-top: 6px; }

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
    ${cortesia ? '' : opBlock}

    <div class="brand-block">
      ${LOGO_SVG}
      ${e.razonSocial ? `<div class="legal-name">${esc(e.razonSocial)}</div>` : ''}
      ${(e.nit || e.nrc) ? `<div class="legal-meta">${e.nit ? `NIT ${esc(e.nit)}` : ''}${(e.nit && e.nrc) ? ' · ' : ''}${e.nrc ? `NRC ${esc(e.nrc)}` : ''}</div>` : ''}
      ${e.direccion ? `<div class="legal-addr">${esc(e.direccion)}</div>` : ''}
      ${e.telefono ? `<div class="legal-meta">Tel: ${esc(e.telefono)}</div>` : ''}
    </div>

    <hr class="sep-solid"/>

    ${cortesia ? cortesiaBlock : ordenDeLavado ? lavadoBlock : redencion ? redencionBlock : `
    <div class="doc-type">
      <div class="doc-type-name">${esc(tipoLabel)}</div>
      ${e.ambiente ? `<div class="doc-type-amb">${esc(e.ambiente)}</div>` : ''}
    </div>

    ${dteBlock}
    ${fechaEmision ? `<div class="fecha-row">Emisión: ${esc(fechaEmision)}</div>` : ''}

    <hr class="sep"/>
    ${clienteBlock}
    ${atendio ? `<div class="kv-block"><div class="kv-row"><span class="k">Atendió</span><span class="v">${esc(atendio)}</span></div></div>` : ''}

    ${seguroBlock}

    <hr class="sep"/>
    <div class="items">
      <div class="items-head"><span>Detalle</span><span>Importe</span></div>
      ${lineasHTML}
    </div>

    <hr class="sep"/>
    <div class="totals">
      <div class="totals-row"><span class="k">Subtotal s/IVA</span><span class="v">${money(subSinIva)}</span></div>
      <div class="totals-row"><span class="k">IVA 13%</span><span class="v">${money(iva)}</span></div>
      ${descuento > 0 ? `<div class="totals-row"><span class="k">Descuento</span><span class="v">−${money(descuento)}</span></div>` : ''}
      <div class="totals-row total"><span class="k">TOTAL</span><span class="v">${money(v.total)}</span></div>
      ${v.metodoPago ? `<div class="pay-row"><span>Pago</span><span>${esc(v.metodoPago)}</span></div>` : ''}
    </div>

    ${qrBlock}`}

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

/**
 * Abre el ticket en una ventana nueva que se auto-imprime.
 *
 * `ventana` es para quien necesita esperar algo —el DTE de la venta— antes de
 * armar el ticket: la ventana se abre en el clic y se llena después, porque
 * pasado un `await` el navegador ya no lo cuenta como respuesta al clic y la
 * bloquea.
 */
export function abrirVentanaTicket(id?: string): Window | null {
  return window.open('', `corsa_ticket_${id ?? Date.now()}`, 'width=420,height=760')
}

/**
 * Un aviso en la ventana del ticket mientras se espera algo —el cobro, el
 * sello de Hacienda—. Sin esto queda una ventana en blanco, y el cajero la
 * cierra creyendo que falló.
 */
export function avisoEnVentanaTicket(w: Window | null, texto: string): void {
  if (!w) return
  w.document.open()
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>CORSA</title></head>
    <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
                 font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;font-weight:700;text-align:center;padding:24px">
      ${esc(texto)}</body></html>`)
  w.document.close()
}

export function printCorsaTicket(args: TicketArgs, ventana?: Window | null): void {
  const html = buildCorsaTicketHTML(args)
  const w = ventana ?? abrirVentanaTicket(args.venta.id)
  if (!w) {
    throw new Error('El navegador bloqueó la ventana de impresión. Permití popups para este sitio.')
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
}

/**
 * Imprime el ticket sin mostrar nada: un iframe invisible con el ticket, y
 * `print()` desde la app.
 *
 * El cajero no ve ninguna ventana. Para que tampoco aparezca el diálogo de
 * impresión, Chrome de la PC de caja tiene que abrirse con `--kiosk-printing`:
 * así manda el trabajo directo a la impresora predeterminada (la 3nstar). Sin
 * ese flag, Chrome muestra su vista previa encima de la misma pantalla.
 *
 * Se espera a que carguen las imágenes (logo, QR del DTE) antes de imprimir:
 * un QR a medio cargar sale en blanco en el papel.
 */
export async function imprimirTicketEnSegundoPlano(args: TicketArgs): Promise<void> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
  document.body.appendChild(iframe)
  const w = iframe.contentWindow
  const d = iframe.contentDocument
  if (!w || !d) { iframe.remove(); throw new Error('No se pudo preparar la impresión del ticket') }

  // Sin el auto-print del ticket: imprime la app, una sola vez.
  d.open()
  d.write(buildCorsaTicketPreviewHTML(args))
  d.close()

  const imagenes = Array.from(d.images).filter(img => !img.complete)
  await Promise.race([
    Promise.all(imagenes.map(img => new Promise<void>(ok => { img.onload = img.onerror = () => ok() }))),
    new Promise<void>(ok => setTimeout(ok, 3000)),
  ])

  const quitar = () => setTimeout(() => iframe.remove(), 1000)
  w.addEventListener('afterprint', quitar, { once: true })
  setTimeout(() => iframe.isConnected && iframe.remove(), 120_000)
  w.focus()
  w.print()
}

/** Misma salida, con el auto-print desactivado — para previsualizar en iframe. */
export function buildCorsaTicketPreviewHTML(args: TicketArgs): string {
  return buildCorsaTicketHTML(args).replace(
    '<head>',
    '<head><script>window._corsaPreview=true</script>'
  )
}
