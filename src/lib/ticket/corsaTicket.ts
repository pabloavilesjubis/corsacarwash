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
 * imprime decenas de veces por día y cada milímetro es papel. Lo que se
 * puede poner lado a lado va lado a lado: el carro junto a los cuadrantes,
 * los datos legales junto al logo, rótulo y valor del DTE en una fila, el QR
 * junto a los totales. Una FCF típica mide ~116 mm (antes ~248 mm). El número
 * del programa sigue siendo lo más grande del papel: ahí el tamaño ES la
 * función.
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
  /** Sólo adicionales (0063): no hay programa que activar en la máquina. */
  sinLavado?: boolean
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
  /**
   * Venta al crédito de un cliente con facturación consolidada (0060): no se
   * emite DTE por esta venta, se factura después en un CCF del período.
   */
  creditoDiferido?: boolean
  /**
   * El ticket del CCF consolidado: sin cabecera de lavado, sólo cuántos
   * lavados y de qué período. El detalle por carro va en el CCF.
   */
  consolidado?: { lavados: number; desde: string; hasta: string }
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
  const { emisor: e, venta: v, operacion: op, dte: d = {}, cliente: cli, atendio, redencion, seguroLluvia, cortesia, ordenDeLavado, creditoDiferido, consolidado } = args

  const programa = resolveServiceProgram(op.servicio)
  const tipoLabel = creditoDiferido ? 'VENTA AL CRÉDITO'
    : (d.tipoDte && DTE_LABELS[d.tipoDte])
    ?? (d.numeroControl ? 'DTE' : 'TICKET DE VENTA')

  const fechaEmision = d.fhProcesamiento
    ?? (v.fecha ? formatearFechaHora(v.fecha, {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }) : '')


  const iva = v.iva ?? (v.total ? (v.total * 0.13) / 1.13 : 0)
  const subSinIva = (v.total ?? 0) - iva
  const descuento = v.descuento ?? 0

  // Una fila por línea: nombre, cantidad × precio e importe lado a lado. En dos
  // filas cada servicio gastaba el doble de papel sin decir nada más.
  const lineasHTML = v.lineas.map(l => `
      <div class="line">
        <span class="line-name">${esc(l.nombre)}</span>
        <span class="line-qty">${l.cantidad} × ${money(l.precioUnitario)}</span>
        <span class="line-total">${money(l.subtotal)}</span>
      </div>`).join('')

  // ── Cabecera operativa: servicio, aspirado y el carro, en una franja ──
  // La placa va en la tercera celda y no en una fila aparte: el operario lee
  // los tres datos de un vistazo y el papel no crece.
  const conCarro = !!(op.placa || op.vehiculo || op.ordenNumero)
  const opBlock = `
    <div class="op-grid">
      <div class="op-cell">
        <div class="op-label">Servicio</div>
        ${op.sinLavado
          ? `<div class="op-number op-number-unknown">—</div>
             <div class="op-sub">Sin lavado</div>`
          : programa
          ? `<div class="op-number">${programa.program}</div>
             <div class="op-sub">${esc(programa.label)}</div>`
          // Sin tier reconocido no se inventa un número: mandaría al operario
          // a activar el programa equivocado.
          : `<div class="op-number op-number-unknown">?</div>
             <div class="op-sub">${esc(op.servicio)}</div>`}
      </div>
      <div class="op-cell op-cell-mid">
        <div class="op-label">Aspirado</div>
        ${marcaAspirado(op.aspirado)}
      </div>
      ${conCarro ? `
      <div class="op-cell op-cell-car">
        ${op.placa ? `<span class="op-plate">${esc(op.placa)}</span>` : ''}
        ${op.vehiculo ? `<span class="op-car">${esc(op.vehiculo)}</span>` : ''}
        ${op.ordenNumero ? `<span class="op-order">Orden ${esc(op.ordenNumero)}</span>` : ''}
      </div>` : ''}
    </div>`

  // Atendió va en la misma fila que el cliente de mostrador; con un receptor
  // identificado los datos del CCF van de a dos por fila.
  const atendioHTML = atendio ? `<span><b>Atendió</b> ${esc(atendio)}</span>` : ''
  const clienteBlock = cli?.nombre && cli.nombre !== 'Consumidor Final'
    ? `<div class="kv-block">
         <div class="kv-label-row"><span>Receptor</span>${atendioHTML}</div>
         <div class="kv-row"><span class="v strong">${esc(cli.nombre)}</span></div>
         ${(cli.numeroDocumento || cli.nrc) ? `<div class="kv-row">
           ${cli.numeroDocumento ? `<span><b>${esc(cli.tipoDocumento || 'Doc')}</b> <span class="mono">${esc(cli.numeroDocumento)}</span></span>` : ''}
           ${cli.nrc ? `<span><b>NRC</b> <span class="mono">${esc(cli.nrc)}</span></span>` : ''}
         </div>` : ''}
         ${cli.actividad ? `<div class="kv-row"><span><b>Actividad</b> ${esc(cli.actividad)}</span></div>` : ''}
         ${cli.direccion ? `<div class="kv-row"><span><b>Dirección</b> ${esc(cli.direccion)}</span></div>` : ''}
         ${(cli.telefono || cli.correo) ? `<div class="kv-row">
           ${cli.telefono ? `<span><b>Tel</b> ${esc(cli.telefono)}</span>` : ''}
           ${cli.correo ? `<span class="wrap"><b>Correo</b> ${esc(cli.correo)}</span>` : ''}
         </div>` : ''}
       </div>`
    : `<div class="kv-block"><div class="kv-row"><span><b>Cliente</b> Consumidor Final</span>${atendioHTML}</div></div>`

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
      <div class="seguro-head">
        <div>
          <div class="seguro-title">SEGURO DE LLUVIA${seguroLluvia.cortesia ? ` <span class="seguro-cortesia">CORTESÍA</span>` : ''}</div>
          <div class="seguro-sub">Un lavado PRO sin costo si llueve</div>
        </div>
        <div class="seguro-plate">${esc(seguroLluvia.placa)}</div>
      </div>
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
  // Con DTE la fecha de emisión es una fila más del recuadro; sin él, va suelta.
  const fechaEnDte = !creditoDiferido && !!d.numeroControl
  const dteBlock = creditoDiferido
    ? `<div class="dte-block dte-pending">
         <div class="dte-title">Venta al crédito</div>
         <div class="dte-pending-text">Cargada a la cuenta del cliente. Se factura en el CCF consolidado del período.</div>
       </div>`
    : sinValidezFiscal
    ? `<div class="dte-block dte-pending">
         <div class="dte-title">Comprobante interno</div>
         <div class="dte-pending-text">Sin validez fiscal</div>
       </div>`
    : d.numeroControl
    // Rótulo y valor en la misma fila: los tres identificadores caben enteros
    // en el ancho del papel con la mono chica, y la emisión cierra el recuadro.
    ? `<div class="dte-block">
         <div class="dte-title">Documento tributario electrónico</div>
         ${invalidado ? `<div class="dte-void">DOCUMENTO INVALIDADO</div>` : ''}
         <div class="dte-row">
           <span class="dte-label">N° control</span>
           <span class="dte-value mono strong wrap">${esc(d.numeroControl)}</span>
         </div>
         <div class="dte-row">
           <span class="dte-label">Cód. gen.</span>
           <span class="dte-value mono wrap">${esc(d.codigoGeneracion)}</span>
         </div>
         <div class="dte-row">
           <span class="dte-label">Sello</span>
           <span class="dte-value mono wrap">${d.selloRecibido ? esc(d.selloRecibido) : 'Pendiente'}</span>
         </div>
         ${fechaEmision ? `<div class="dte-row">
           <span class="dte-label">Emisión</span>
           <span class="dte-value mono">${esc(fechaEmision)}</span>
         </div>` : ''}
       </div>`
    : `<div class="dte-block dte-pending">
         <div class="dte-title">Documento tributario electrónico</div>
         <div class="dte-pending-text">Pendiente de transmisión al Ministerio de Hacienda</div>
       </div>`

  const qrBlock = d.qrUrl
    ? `<div class="qr-block">
         <div class="qr-img">${qrSvg(d.qrUrl, { margen: 0 })}</div>
         <div class="qr-caption">Verificá en<br/>admin.factura.gob.sv</div>
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
    font-size: 10px; line-height: 1.2;
    padding: 2mm 1.5mm; width: 100%;
    -webkit-font-smoothing: none;   /* anti-aliasing apagado: nitidez térmica */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .ticket { width: 100%; text-align: center; }
  b { font-weight: 900; }

  /* ── Cabecera operativa: una franja de tres celdas ──
     El número del programa sigue siendo lo más grande del papel: es lo que
     el operario lee desde la máquina. Lo que se achicó es el aire alrededor. */
  .op-grid {
    display: flex; width: 100%;
    border: 3px solid #000; margin-bottom: 4px;
  }
  .op-cell {
    flex: 1 1 0; padding: 3px 2px 4px; min-width: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .op-cell-mid { flex: 0 0 24%; border-left: 3px solid #000; }
  .op-cell-car { flex: 1.25 1 0; border-left: 3px solid #000; gap: 2px; }
  .op-label {
    font-size: 8.5px; font-weight: 900; letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .op-number {
    font-size: 46px; font-weight: 900; line-height: 0.95;
    margin: 1px 0 0; font-variant-numeric: tabular-nums;
  }
  .op-number-unknown { font-size: 38px; }
  .mark { width: 42px; height: 42px; margin: 3px 0 0; display: block; }
  .op-sub {
    font-size: 9.5px; font-weight: 900; letter-spacing: 0.06em;
    margin-top: 1px; text-align: center; line-height: 1.1;
  }
  .op-plate {
    border: 2px solid #000; padding: 0 4px;
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 13px; font-weight: 900;
  }
  .op-car { font-size: 9px; font-weight: 700; line-height: 1.15; }
  .op-order { font-size: 9.5px; font-weight: 900; }

  /* ── Seguro de lluvia ── */
  .seguro-block {
    border: 3px solid #000; padding: 3px 5px; margin: 4px 0;
    text-align: left;
  }
  .seguro-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .seguro-title { font-size: 12px; font-weight: 900; letter-spacing: 0.08em; }
  .seguro-sub { font-size: 9px; font-weight: 700; }
  .seguro-cortesia {
    display: inline-block; border: 2px solid #000; padding: 0 4px;
    font-size: 10px; font-weight: 900; letter-spacing: 0.12em;
  }
  .seguro-plate {
    border: 2px solid #000; padding: 1px 6px; flex-shrink: 0;
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 15px; font-weight: 900; letter-spacing: 0.06em;
  }
  .seguro-rows { font-size: 10px; font-weight: 700; margin-top: 2px; }
  .seguro-row { display: flex; justify-content: space-between; padding: 0 1px; }
  .seguro-row .strong { font-weight: 900; text-decoration: underline; }
  .seguro-legal { font-size: 8.5px; font-weight: 600; margin-top: 1px; line-height: 1.2; }

  /* ── Branding: el logo a la izquierda y los datos legales al lado ── */
  .brand-block { display: flex; align-items: center; justify-content: center; gap: 6px; margin-bottom: 2px; }
  .brand-logo { width: 21mm; height: auto; display: block; flex-shrink: 0; }
  .legal { text-align: left; min-width: 0; }
  .legal-name { font-size: 9.5px; font-weight: 900; line-height: 1.15; }
  .legal-meta { font-size: 8.5px; font-weight: 700; }
  .legal-addr { font-size: 8px; font-weight: 400; line-height: 1.15; }

  /* Separadores: siempre negro sólido (los dashed claros desaparecen) */
  .sep       { border: none; border-top: 1px solid #000; margin: 3px 0; }
  .sep-solid { border: none; border-top: 2px solid #000; margin: 2px 0 3px; }

  .doc-type { text-align: center; margin: 2px 0; }
  .doc-type-name { font-size: 11.5px; font-weight: 900; letter-spacing: 0.05em; }
  .doc-type-amb { font-size: 8.5px; font-weight: 700; letter-spacing: 0.12em; }

  /* Recuadro del DTE: mismo marco que la cabecera operativa, más fino. */
  .dte-block { margin: 2px 0; padding: 2px 4px; border: 2px solid #000; text-align: left; }
  .dte-title {
    font-size: 7.5px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase;
    text-align: center; border-bottom: 1px solid #000; padding-bottom: 1px; margin-bottom: 1px;
  }
  .dte-void {
    font-size: 11px; font-weight: 900; letter-spacing: 0.08em; text-align: center;
    border: 2px solid #000; padding: 1px 0; margin-bottom: 2px;
  }
  .dte-row { display: flex; align-items: baseline; gap: 4px; }
  .dte-label {
    flex: 0 0 54px; white-space: nowrap; font-size: 7.5px; font-weight: 900; letter-spacing: 0.02em; text-transform: uppercase;
  }
  .dte-value { flex: 1 1 auto; min-width: 0; font-size: 8.5px; line-height: 1.25; font-weight: 700; }
  .dte-pending-text { font-size: 9px; font-weight: 700; text-align: center; }
  .mono { font-family: 'SF Mono', 'Menlo', 'Consolas', 'Courier New', monospace; }
  .strong { font-weight: 900; }
  .small { font-size: 9px; font-weight: 400; }
  .wrap { word-break: break-all; overflow-wrap: anywhere; }
  .fecha-row { font-size: 9px; font-weight: 700; text-align: right; }

  .kv-block { margin: 2px 0; text-align: left; }
  .kv-label-row {
    display: flex; justify-content: space-between; gap: 6px;
    font-size: 8px; font-weight: 900; letter-spacing: 0.1em;
    text-transform: uppercase; border-bottom: 1px solid #000;
    padding-bottom: 1px; margin-bottom: 1px;
  }
  .kv-label-row span:last-child { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 9.5px; }
  .kv-label-row b { font-weight: 900; }
  .kv-row { display: flex; justify-content: space-between; gap: 6px; font-size: 9.5px; font-weight: 400; line-height: 1.25; }
  .kv-row .k { flex-shrink: 0; font-weight: 700; }
  .kv-row .v { text-align: right; word-break: break-word; font-weight: 400; }
  .kv-row .v.strong { text-align: left; font-weight: 900; }

  /* Detalle: una línea por servicio. El operario y el cliente tienen que ver
     el lavado y el aspirado por separado, no un único importe agregado. */
  .items { margin: 3px 0 2px; text-align: left; }
  .items-head {
    display: flex; justify-content: space-between;
    font-size: 8px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase;
    border-bottom: 1px solid #000; padding-bottom: 1px; margin-bottom: 1px;
  }
  .line {
    display: flex; align-items: baseline; gap: 10px;
    padding: 1px 0; border-bottom: 1px dotted #000;
  }
  .line:last-child { border-bottom: none; }
  .line-name { flex: 1 1 auto; min-width: 0; font-size: 10px; line-height: 1.2; font-weight: 700; }
  .line-qty { flex-shrink: 0; font-family: 'SF Mono', monospace; font-size: 9px; font-weight: 600; }
  .line-total { flex-shrink: 0; font-family: 'SF Mono', monospace; font-size: 10px; font-weight: 900; }

  /* Cierre: el QR a la izquierda y los totales al lado, en la misma franja. */
  .cierre { display: flex; align-items: center; gap: 6px; border-top: 2px solid #000; padding-top: 3px; margin-top: 2px; }
  .totals { flex: 1 1 auto; min-width: 0; font-size: 10px; text-align: left; }
  .totals-row { display: flex; justify-content: space-between; font-weight: 600; }
  .totals-row.total {
    font-size: 16px; font-weight: 900; padding: 2px 0 1px; margin-top: 2px;
    border-top: 2px solid #000; border-bottom: 2px solid #000;
  }
  .totals-row .v { font-family: 'SF Mono', monospace; }
  .pay-row { display: flex; justify-content: space-between; font-size: 9.5px; font-weight: 700; margin-top: 1px; }

  /* 26 mm siguen dando cuatro puntos de la térmica por módulo: se escanea. */
  .qr-block { flex: 0 0 26mm; text-align: center; }
  .qr-img { width: 26mm; height: 26mm; display: block; }
  .qr-img svg { width: 100%; height: 100%; display: block; }
  .qr-caption { font-size: 7px; font-weight: 700; margin-top: 1px; line-height: 1.15; }

  .footer {
    display: flex; justify-content: space-between; align-items: baseline; gap: 6px;
    margin-top: 4px; padding-top: 2px; border-top: 1px solid #000;
  }
  .footer-thanks { font-size: 9.5px; font-weight: 900; white-space: nowrap; }
  .footer-meta { font-size: 8px; font-weight: 600; white-space: nowrap; }

  /* Canje de cupón, orden de lavado y cortesía */
  .redencion { margin: 3px 0 2px; text-align: center; }
  .redencion-title {
    font-size: 11px; font-weight: 900; letter-spacing: 0.12em;
    text-transform: uppercase; border-top: 2px solid #000; border-bottom: 2px solid #000;
    padding: 2px 0;
  }
  .redencion-code {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 24px; font-weight: 900; letter-spacing: 0.06em; margin: 2px 0 0;
  }
  .redencion-note { font-size: 8.5px; font-weight: 600; line-height: 1.25; margin-top: 3px; }

  /* Espacio para que la cuchilla no corte información */
  .bottom-pad { height: 8px; }

  @media print {
    body { padding: 1mm 1mm; }
    @page { margin: 0; }
  }
</style>
</head>
<body>
  <div class="ticket">
    ${cortesia || consolidado ? '' : opBlock}

    <div class="brand-block">
      ${LOGO_SVG}
      ${(e.razonSocial || e.nit || e.nrc || e.direccion || e.telefono) ? `<div class="legal">
        ${e.razonSocial ? `<div class="legal-name">${esc(e.razonSocial)}</div>` : ''}
        ${(e.nit || e.nrc) ? `<div class="legal-meta">${e.nit ? `NIT ${esc(e.nit)}` : ''}${(e.nit && e.nrc) ? ' · ' : ''}${e.nrc ? `NRC ${esc(e.nrc)}` : ''}</div>` : ''}
        ${e.direccion ? `<div class="legal-addr">${esc(e.direccion)}</div>` : ''}
        ${e.telefono ? `<div class="legal-meta">Tel: ${esc(e.telefono)}</div>` : ''}
      </div>` : ''}
    </div>

    <hr class="sep-solid"/>

    ${cortesia ? cortesiaBlock : ordenDeLavado ? lavadoBlock : redencion ? redencionBlock : `
    <div class="doc-type">
      <div class="doc-type-name">${esc(tipoLabel)}</div>
      ${e.ambiente ? `<div class="doc-type-amb">${esc(e.ambiente)}</div>` : ''}
    </div>

    ${dteBlock}
    ${fechaEmision && !fechaEnDte ? `<div class="fecha-row">Emisión: ${esc(fechaEmision)}</div>` : ''}
    ${consolidado ? `<div class="kv-block"><div class="kv-row"><span><b>Lavados</b> ${consolidado.lavados}</span>
      <span><b>Período</b> ${esc(consolidado.desde)} – ${esc(consolidado.hasta)}</span></div></div>` : ''}

    <hr class="sep"/>
    ${clienteBlock}

    ${seguroBlock}

    <div class="items">
      <div class="items-head"><span>Detalle</span><span>Importe</span></div>
      ${lineasHTML}
    </div>

    <div class="cierre">
      ${qrBlock}
      <div class="totals">
        <div class="totals-row"><span class="k">Subtotal s/IVA</span><span class="v">${money(subSinIva)}</span></div>
        <div class="totals-row"><span class="k">IVA 13%</span><span class="v">${money(iva)}</span></div>
        ${descuento > 0 ? `<div class="totals-row"><span class="k">Descuento</span><span class="v">−${money(descuento)}</span></div>` : ''}
        <div class="totals-row total"><span class="k">TOTAL</span><span class="v">${money(v.total)}</span></div>
        ${v.metodoPago ? `<div class="pay-row"><span>Pago</span><span>${esc(v.metodoPago)}</span></div>` : ''}
      </div>
    </div>`}

    <div class="footer">
      <span class="footer-thanks">¡Gracias por su preferencia!</span>
      <span class="footer-meta">CORSA Carwash · ${new Date().toLocaleDateString('es-SV')}</span>
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
