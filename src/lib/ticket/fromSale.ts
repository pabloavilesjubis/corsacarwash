/**
 * CORSA Carwash — De una venta a los argumentos del ticket
 *
 * Dos caminos llegan al mismo ticket: el cobro en el POS (que tiene todos los
 * datos frescos) y la reimpresión desde el historial (que sólo tiene la fila de
 * v_sales_history). Ambos se normalizan acá para que el ticket salga idéntico.
 */

import type { TicketArgs, TicketDte, TicketEmisor } from './corsaTicket'
import type { DteDeVenta, Sale } from '../../services/sales.service'

/**
 * El emisor del ticket con el rótulo del ambiente y la sucursal.
 *
 * Los datos fiscales vienen de `fiscal_issuer_config` (ver lib/fiscal/emisor),
 * la misma fila que el Worker mete en el DTE: si el papel dijera un NIT y el
 * documento sellado otro, la representación impresa no le correspondería.
 */
function emisorDelTicket(
  emisor: TicketEmisor, branchName: string | undefined, dte: DteDeVenta | null | undefined,
): TicketEmisor {
  return {
    ...emisor,
    direccion: branchName
      ? [branchName, emisor.direccion].filter(Boolean).join(' · ')
      : emisor.direccion,
    // Sin NIT es el ticket con la marca sola: no hay DTE que esperar.
    ambiente: emisor.nit ? rotuloAmbiente(dte) : 'SIN VALIDEZ FISCAL',
  }
}

/**
 * Rótulo del ambiente. Un documento de pruebas tiene que decirlo en el papel:
 * es idéntico a uno real y no vale nada ante Hacienda.
 */
export function rotuloAmbiente(dte?: Pick<DteDeVenta, 'ambiente'> | null): string | undefined {
  if (!dte) return 'SIN TRANSMITIR AL MH'
  return dte.ambiente === '00' ? 'AMBIENTE DE PRUEBAS · SIN VALIDEZ FISCAL' : undefined
}

/** El DTE de la base, en la forma que espera el ticket. */
export function dteParaTicket(dte: DteDeVenta, tipoPorDefecto: string): TicketDte {
  return {
    tipoDte: dte.tipoDte || tipoPorDefecto,
    numeroControl: dte.numeroControl,
    codigoGeneracion: dte.codigoGeneracion,
    selloRecibido: dte.selloRecepcion ?? undefined,
    qrUrl: dte.qrUrl ?? undefined,
    fhProcesamiento: dte.fechaEmision
      ? `${dte.fechaEmision.split('-').reverse().join('/')}${dte.horaEmision ? ` ${dte.horaEmision}` : ''}`
      : undefined,
    estado: dte.estado,
  }
}

/** Reimpresión desde el historial de ventas. */
export function buildTicketArgsFromSale(
  sale: Sale, emisor: TicketEmisor, branchName?: string, dte?: DteDeVenta | null,
): TicketArgs {
  const tipo = sale.invoice_type === 'credito_fiscal' ? '03' : '01'
  const iva = Number(sale.tax_total || 0)
  const total = Number(sale.total || 0)

  return {
    emisor: emisorDelTicket(emisor, branchName, dte),
    operacion: {
      // service_name viene como "ÉLITE M": el tier es la primera palabra y es
      // lo que resuelve el número de programa.
      servicio: (sale.service_name ?? '').split(' ')[0] || (sale.service_name ?? ''),
      aspirado: sale.with_aspirado,
      placa: sale.plate ?? undefined,
      ordenNumero: sale.order_number,
    },
    venta: {
      id: sale.order_id,
      fecha: sale.created_at,
      // Líneas reales cuando existen; si no, una sola agregada.
      lineas: sale.items?.length
        ? sale.items.map(i => ({
            nombre: i.descripcion, cantidad: i.cantidad,
            precioUnitario: i.unitario, subtotal: i.total,
          }))
        : [{ nombre: sale.service_name ?? 'Servicio', cantidad: 1, precioUnitario: total, subtotal: total }],
      total,
      iva,
      metodoPago: sale.payment_method ?? undefined,
    },
    cliente: {
      nombre: sale.customer_name,
      // El MH exige el receptor completo en un CCF; para una FCF estos campos
      // simplemente vienen vacíos y el ticket no los dibuja.
      tipoDocumento: sale.customer_nit ? 'NIT' : sale.customer_dui ? 'DUI' : undefined,
      numeroDocumento: sale.customer_nit ?? sale.customer_dui ?? undefined,
      nrc: sale.customer_nrc ?? undefined,
      actividad: sale.customer_desc_actividad ?? undefined,
      direccion: sale.customer_direccion ?? undefined,
      telefono: sale.customer_phone ?? undefined,
      correo: sale.customer_email ?? undefined,
    },
    // Sin DTE el ticket deja el bloque fiscal rotulado como pendiente.
    dte: dte ? dteParaTicket(dte, tipo) : { tipoDte: tipo },
    atendio: undefined,
  }
}

/** Lo que devuelve pos_register_sale(). */
export interface PosSaleResult {
  order_id: string
  invoice_id: string
  order_number: string
  service_name: string
  machine_program: number | null
  size: string
  with_aspirado: boolean
  subtotal: number
  tax: number
  total: number
  doc_type: 'ticket' | 'ccf'
  fcf_name: string | null
  issued_at: string
  /** Póliza emitida con esta venta, si se vendió seguro de lluvia (0039). */
  rain_policy: {
    id: string
    plate: string
    price: number
    issued_at: string
    valid_until: string
    /** De cortesía (0053): la agrega el POS después del cobro, sin línea de venta. */
    courtesy?: boolean
  } | null
  /** Póliza consumida por esta venta, si el lavado se cobró con un seguro. */
  rain_redeemed: {
    id: string
    plate: string
    issued_at: string
    valid_until: string
  } | null
}

/** Cobro recién hecho en el POS. */
export function buildTicketArgsFromPos(
  result: PosSaleResult,
  emisor: TicketEmisor,
  extras: {
    clienteNombre?: string
    clienteDoc?: { tipo?: string; numero?: string; nrc?: string }
    placa?: string
    vehiculo?: string
    metodoPago?: string
    atendio?: string
    aspiradoPrecio?: number
    branchName?: string
  } = {},
  dte: DteDeVenta | null = null,
): TicketArgs {
  const tipo = result.doc_type === 'ccf' ? '03' : '01'
  const total = Number(result.total || 0)
  const aspirado = extras.aspiradoPrecio ?? 0
  const seguro = Number(result.rain_policy?.price ?? 0)
  // El precio del lavado es lo que queda después de los complementos: sin
  // restarlos, la línea del servicio mostraría el total y el ticket sumaría
  // más que lo cobrado.
  const base = total - (result.with_aspirado ? aspirado : 0) - seguro

  return {
    emisor: emisorDelTicket(emisor, extras.branchName, dte),
    operacion: {
      servicio: result.service_name,
      aspirado: result.with_aspirado,
      placa: extras.placa,
      vehiculo: extras.vehiculo,
      ordenNumero: result.order_number,
    },
    venta: {
      id: result.order_id,
      fecha: result.issued_at,
      lineas: [
        {
          nombre: `${result.service_name} ${result.size}`,
          cantidad: 1, precioUnitario: base, subtotal: base,
        },
        ...(result.with_aspirado
          ? [{ nombre: 'Aspirado de interiores', cantidad: 1, precioUnitario: aspirado, subtotal: aspirado }]
          : []),
        // Una cortesía no se cobró: no va como línea, sólo como el bloque del seguro.
        ...(result.rain_policy && !result.rain_policy.courtesy
          ? [{
              nombre: 'Seguro de lluvia',
              cantidad: 1,
              precioUnitario: Number(result.rain_policy.price || 0),
              subtotal: Number(result.rain_policy.price || 0),
            }]
          : []),
      ],
      total,
      iva: Number(result.tax || 0),
      metodoPago: extras.metodoPago,
    },
    cliente: {
      nombre: extras.clienteNombre ?? result.fcf_name ?? 'Consumidor Final',
      tipoDocumento: extras.clienteDoc?.tipo,
      numeroDocumento: extras.clienteDoc?.numero,
      nrc: extras.clienteDoc?.nrc,
    },
    // Con la sucursal emitiendo, el POS espera el sello y llega el DTE; si no,
    // el ticket deja el bloque fiscal como pendiente.
    dte: dte ? dteParaTicket(dte, tipo) : { tipoDte: tipo },
    atendio: extras.atendio,
    // La vigencia se imprime con lo que devolvió el servidor, no con una
    // cuenta hecha acá: el reloj que vale es el de la base, que es el mismo
    // que va a decidir si el seguro está vivo cuando el cliente vuelva.
    seguroLluvia: result.rain_policy
      ? {
          placa: result.rain_policy.plate,
          desde: result.rain_policy.issued_at,
          hasta: result.rain_policy.valid_until,
          cortesia: !!result.rain_policy.courtesy,
        }
      : undefined,
  }
}
