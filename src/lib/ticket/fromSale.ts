/**
 * CORSA Carwash — De una venta a los argumentos del ticket
 *
 * Dos caminos llegan al mismo ticket: el cobro en el POS (que tiene todos los
 * datos frescos) y la reimpresión desde el historial (que sólo tiene la fila de
 * v_sales_history). Ambos se normalizan acá para que el ticket salga idéntico.
 */

import type { TicketArgs, TicketEmisor } from './corsaTicket'
import type { Sale } from '../../services/sales.service'

/**
 * Datos del emisor.
 *
 * PENDIENTE: hoy son constantes con los valores de la organización sembrada en
 * 0002. Cuando se conecte la emisión real de DTE tienen que leerse de
 * `organizations` (y el NIT de ahí es todavía un placeholder).
 */
export const EMISOR: TicketEmisor = {
  nombreComercial: 'CORSA',
  razonSocial: 'CORSA Carwash S.A. de C.V.',
  nit: '0614-010101-000-0',
  nrc: '123456',
  direccion: 'Colonia Escalón, San Salvador, El Salvador',
  telefono: '+503 2222-1111',
  ambiente: 'SIN TRANSMITIR AL MH',
}

/** Reimpresión desde el historial de ventas. */
export function buildTicketArgsFromSale(sale: Sale, branchName?: string): TicketArgs {
  const iva = Number(sale.tax_total || 0)
  const total = Number(sale.total || 0)

  return {
    emisor: {
      ...EMISOR,
      direccion: branchName ? `${branchName} · ${EMISOR.direccion}` : EMISOR.direccion,
    },
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
    // El DTE todavía no se transmite: el ticket sale sin número de control ni
    // QR, y el generador ya contempla ese caso.
    dte: {
      tipoDte: sale.invoice_type === 'credito_fiscal' ? '03' : '01',
    },
    atendio: undefined,
  }
}

/** Lo que devuelve pos_register_sale(). */
export interface PosSaleResult {
  order_id: string
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
}

/** Cobro recién hecho en el POS. */
export function buildTicketArgsFromPos(
  result: PosSaleResult,
  extras: {
    clienteNombre?: string
    clienteDoc?: { tipo?: string; numero?: string; nrc?: string }
    placa?: string
    vehiculo?: string
    metodoPago?: string
    atendio?: string
    aspiradoPrecio?: number
    branchName?: string
  } = {}
): TicketArgs {
  const total = Number(result.total || 0)
  const aspirado = extras.aspiradoPrecio ?? 0
  const base = result.with_aspirado ? total - aspirado : total

  return {
    emisor: {
      ...EMISOR,
      direccion: extras.branchName ? `${extras.branchName} · ${EMISOR.direccion}` : EMISOR.direccion,
    },
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
    dte: { tipoDte: result.doc_type === 'ccf' ? '03' : '01' },
    atendio: extras.atendio,
  }
}
