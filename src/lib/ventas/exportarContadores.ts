/**
 * CORSA — Excel de ventas para los contadores (0082).
 *
 * Un archivo por tipo de venta: contribuyentes (CCF, tipo 03) o consumidores
 * finales (FCF, tipo 01), en una sola pestaña. Una fila por DTE, con todo lo del documento tal como
 * se selló —identificación, receptor, resumen, sello y respuesta de Hacienda—
 * más lo que el contador pregunta y no viaja en el DTE: orden, forma de pago,
 * DUI y NIT de la ficha, invalidación.
 *
 * Los invalidados se incluyen rotulados: el contador los necesita para cuadrar
 * el correlativo, pero el total de cada pestaña suma sólo los vigentes.
 */

import { supabase } from '../supabase'
import { findDepartamento, findMunicipio, TIPOS_DOCUMENTO_RECEPTOR } from '../mh-catalogs'

export interface DteExportado {
  fiscal_document_id: string
  branch_name: string | null
  dte_type: string
  estado: 'ACCEPTED' | 'INVALIDATED'
  numero_control: string
  codigo_generacion: string | null
  sello_recepcion: string | null
  fh_procesamiento: string | null
  identificacion: any
  receptor: any
  resumen: any
  cuerpo: any[] | null
  invalidada_at: string | null
  invalidacion_motivo: string | null
  invalidacion_sello: string | null
  order_number: string | null
  order_kind: string | null
  consolidado: boolean
  ordenes_consolidadas: string | null
  forma_pago: string | null
  placa: string | null
  cliente_tipo: string | null
  cliente_nombre: string | null
  cliente_nombre_comercial: string | null
  cliente_dui: string | null
  cliente_nit: string | null
  cliente_nrc: string | null
  cliente_telefono: string | null
  cliente_correo: string | null
}

export type TipoVentas = 'ccf' | 'fcf'

const DTE_DE: Record<TipoVentas, string> = { ccf: '03', fcf: '01' }

/**
 * PostgREST corta cada respuesta en 1000 filas, también las de una función:
 * un mes de facturas pasa de eso, así que se pide por páginas. La función
 * ordena de forma estable (tipo, fecha, hora, número de control).
 */
const PAGINA = 1000

export async function fetchDtesParaContadores(desde: string, hasta: string, tipo: TipoVentas): Promise<DteExportado[]> {
  const todos: DteExportado[] = []
  for (let inicio = 0; ; inicio += PAGINA) {
    const { data, error } = await (supabase as any)
      .rpc('sales_export_for_accounting', { p_from: desde, p_to: hasta })
      .range(inicio, inicio + PAGINA - 1)
    if (error) throw new Error(error.message)
    const filas = (data ?? []) as DteExportado[]
    todos.push(...filas)
    if (filas.length < PAGINA) break
  }
  return todos.filter(d => d.dte_type === DTE_DE[tipo])
}

// ─── Columnas ─────────────────────────────────────────────────

type Tipo = 'texto' | 'fecha' | 'dinero' | 'numero'

interface Columna {
  titulo: string
  ancho: number
  tipo: Tipo
  valor: (d: DteExportado) => string | number | null
  /** Se suma en la fila de totales (sólo los vigentes). */
  total?: boolean
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}
const txt = (v: unknown): string | null => (v == null || v === '' ? null : String(v))

const TIPO_DTE: Record<string, string> = { '01': 'Factura consumidor final (01)', '03': 'Crédito fiscal (03)' }
const CONDICION: Record<string, string> = { '1': 'Contado', '2': 'A crédito', '3': 'Otro' }
const MODELO: Record<string, string> = { '1': 'Previo', '2': 'Diferido' }
const OPERACION: Record<string, string> = { '1': 'Normal', '2': 'Contingencia' }
const AMBIENTE: Record<string, string> = { '00': 'Pruebas', '01': 'Producción' }

function tipoVenta(d: DteExportado): string {
  if (d.consolidado) return 'Consolidado (cuentas por cobrar)'
  switch (d.order_kind) {
    case 'service': return 'Lavado'
    case 'voucher_sale': return 'Venta de cupones'
    case 'voucher_gift': return 'Cupones de cortesía'
    case 'addon_sale': return 'Venta sin lavado'
    default: return d.order_kind ?? ''
  }
}

const dir = (d: DteExportado) => d.receptor?.direccion ?? null
const departamento = (d: DteExportado) => {
  const c = dir(d)?.departamento
  return c ? `${c} ${findDepartamento(c)?.nombre ?? ''}`.trim() : null
}
const municipio = (d: DteExportado) => {
  const x = dir(d)
  return x?.municipio ? `${x.municipio} ${findMunicipio(x.departamento, x.municipio)?.nombre ?? ''}`.trim() : null
}

/** «2 × PRO S @ 7.96; 1 × Aspirado @ 3.00» */
function detalle(d: DteExportado): string {
  return (d.cuerpo ?? [])
    .map(l => `${num(l.cantidad)} × ${l.descripcion} @ ${num(l.precioUni).toFixed(2)}`)
    .join('; ')
}

/** El IVA del CCF viaja en resumen.tributos (código 20); el del FCF, en totalIva. */
const ivaCcf = (d: DteExportado) =>
  num((d.resumen?.tributos ?? []).filter((t: any) => t?.codigo === '20').reduce((s: number, t: any) => s + num(t.valor), 0))

const inicio: Columna[] = [
  { titulo: 'Fecha emisión', ancho: 12, tipo: 'fecha', valor: d => d.identificacion?.fecEmi ?? null },
  { titulo: 'Hora emisión', ancho: 10, tipo: 'texto', valor: d => txt(d.identificacion?.horEmi) },
  { titulo: 'Tipo de documento', ancho: 26, tipo: 'texto', valor: d => TIPO_DTE[d.dte_type] ?? d.dte_type },
  { titulo: 'Estado', ancho: 11, tipo: 'texto', valor: d => (d.estado === 'INVALIDATED' ? 'Invalidado' : 'Vigente') },
  { titulo: 'Número de control', ancho: 34, tipo: 'texto', valor: d => d.numero_control },
  { titulo: 'Código de generación', ancho: 40, tipo: 'texto', valor: d => txt(d.codigo_generacion) },
  { titulo: 'Sello de recepción', ancho: 44, tipo: 'texto', valor: d => txt(d.sello_recepcion) },
  { titulo: 'Fecha procesamiento MH', ancho: 20, tipo: 'texto', valor: d => txt(d.fh_procesamiento) },
  { titulo: 'Ambiente', ancho: 11, tipo: 'texto', valor: d => AMBIENTE[d.identificacion?.ambiente] ?? txt(d.identificacion?.ambiente) },
  { titulo: 'Versión DTE', ancho: 8, tipo: 'numero', valor: d => d.identificacion?.version ?? null },
  { titulo: 'Modelo de facturación', ancho: 10, tipo: 'texto', valor: d => MODELO[String(d.identificacion?.tipoModelo)] ?? null },
  { titulo: 'Tipo de transmisión', ancho: 12, tipo: 'texto', valor: d => OPERACION[String(d.identificacion?.tipoOperacion)] ?? null },
  { titulo: 'Moneda', ancho: 8, tipo: 'texto', valor: d => txt(d.identificacion?.tipoMoneda) },
  { titulo: 'Condición de la operación', ancho: 12, tipo: 'texto', valor: d => CONDICION[String(d.resumen?.condicionOperacion)] ?? null },
  { titulo: 'Sucursal', ancho: 14, tipo: 'texto', valor: d => txt(d.branch_name) },
  { titulo: 'Orden(es)', ancho: 18, tipo: 'texto', valor: d => txt(d.ordenes_consolidadas ?? d.order_number) },
  { titulo: 'Tipo de venta', ancho: 20, tipo: 'texto', valor: tipoVenta },
  { titulo: 'Placa', ancho: 10, tipo: 'texto', valor: d => txt(d.placa) },
  { titulo: 'Forma de pago', ancho: 16, tipo: 'texto', valor: d => txt(d.forma_pago) },
]

const receptorCcf: Columna[] = [
  { titulo: 'Nombre o razón social', ancho: 34, tipo: 'texto', valor: d => txt(d.receptor?.nombre ?? d.cliente_nombre) },
  { titulo: 'Nombre comercial', ancho: 24, tipo: 'texto', valor: d => txt(d.receptor?.nombreComercial ?? d.cliente_nombre_comercial) },
  { titulo: 'NIT', ancho: 17, tipo: 'texto', valor: d => txt(d.receptor?.nit ?? d.cliente_nit) },
  { titulo: 'NRC', ancho: 10, tipo: 'texto', valor: d => txt(d.receptor?.nrc ?? d.cliente_nrc) },
  { titulo: 'DUI (ficha del cliente)', ancho: 12, tipo: 'texto', valor: d => txt(d.cliente_dui) },
  { titulo: 'Código actividad', ancho: 10, tipo: 'texto', valor: d => txt(d.receptor?.codActividad) },
  { titulo: 'Actividad económica', ancho: 34, tipo: 'texto', valor: d => txt(d.receptor?.descActividad) },
  { titulo: 'Departamento', ancho: 16, tipo: 'texto', valor: departamento },
  { titulo: 'Municipio', ancho: 18, tipo: 'texto', valor: municipio },
  { titulo: 'Dirección', ancho: 40, tipo: 'texto', valor: d => txt(dir(d)?.complemento) },
  { titulo: 'Teléfono', ancho: 12, tipo: 'texto', valor: d => txt(d.receptor?.telefono ?? d.cliente_telefono) },
  { titulo: 'Correo', ancho: 28, tipo: 'texto', valor: d => txt(d.receptor?.correo ?? d.cliente_correo) },
]

const receptorFcf: Columna[] = [
  { titulo: 'Nombre del cliente', ancho: 30, tipo: 'texto', valor: d => txt(d.receptor?.nombre ?? d.cliente_nombre) ?? 'Consumidor final' },
  { titulo: 'Tipo doc. receptor (DTE)', ancho: 12, tipo: 'texto', valor: d => {
    const c = d.receptor?.tipoDocumento
    return c ? (TIPOS_DOCUMENTO_RECEPTOR.find(t => t.codigo === c)?.nombre ?? c) : null
  } },
  { titulo: 'Número doc. receptor (DTE)', ancho: 17, tipo: 'texto', valor: d => txt(d.receptor?.numDocumento) },
  { titulo: 'DUI (ficha del cliente)', ancho: 12, tipo: 'texto', valor: d => txt(d.cliente_dui) },
  { titulo: 'NIT (ficha del cliente)', ancho: 17, tipo: 'texto', valor: d => txt(d.cliente_nit) },
  { titulo: 'NRC', ancho: 10, tipo: 'texto', valor: d => txt(d.receptor?.nrc ?? d.cliente_nrc) },
  { titulo: 'Código actividad', ancho: 10, tipo: 'texto', valor: d => txt(d.receptor?.codActividad) },
  { titulo: 'Actividad económica', ancho: 30, tipo: 'texto', valor: d => txt(d.receptor?.descActividad) },
  { titulo: 'Departamento', ancho: 16, tipo: 'texto', valor: departamento },
  { titulo: 'Municipio', ancho: 18, tipo: 'texto', valor: municipio },
  { titulo: 'Dirección', ancho: 36, tipo: 'texto', valor: d => txt(dir(d)?.complemento) },
  { titulo: 'Teléfono', ancho: 12, tipo: 'texto', valor: d => txt(d.receptor?.telefono ?? d.cliente_telefono) },
  { titulo: 'Correo', ancho: 28, tipo: 'texto', valor: d => txt(d.receptor?.correo ?? d.cliente_correo) },
]

const lineas: Columna[] = [
  { titulo: 'Líneas', ancho: 7, tipo: 'numero', valor: d => (d.cuerpo ?? []).length },
  { titulo: 'Detalle (cant. × descripción @ precio unitario)', ancho: 50, tipo: 'texto', valor: detalle },
]

const r = (campo: string) => (d: DteExportado) => num(d.resumen?.[campo])
const dinero = (titulo: string, valor: (d: DteExportado) => number, ancho = 13): Columna =>
  ({ titulo, ancho, tipo: 'dinero', valor, total: true })

const ventasYDescuentos: Columna[] = [
  dinero('Ventas no sujetas', r('totalNoSuj')),
  dinero('Ventas exentas', r('totalExenta')),
  dinero('Ventas gravadas', r('totalGravada')),
  dinero('Subtotal ventas', r('subTotalVentas')),
  dinero('Descuento no sujetas', r('descuNoSuj')),
  dinero('Descuento exentas', r('descuExenta')),
  dinero('Descuento gravadas', r('descuGravada')),
  { titulo: '% descuento', ancho: 9, tipo: 'numero', valor: r('porcentajeDescuento') },
  dinero('Total descuentos', r('totalDescu')),
]

const cierre: Columna[] = [
  dinero('IVA retenido', r('ivaRete1')),
  dinero('Retención renta', r('reteRenta')),
  dinero('Monto total operación', r('montoTotalOperacion'), 15),
  dinero('Total no gravado', r('totalNoGravado')),
  dinero('Total a pagar', r('totalPagar'), 14),
  dinero('Saldo a favor', r('saldoFavor')),
  { titulo: 'Total en letras', ancho: 40, tipo: 'texto', valor: d => txt(d.resumen?.totalLetras) },
]

const invalidacion: Columna[] = [
  { titulo: 'Fecha invalidación', ancho: 20, tipo: 'texto', valor: d => (d.invalidada_at ? fechaHoraSv(d.invalidada_at) : null) },
  { titulo: 'Motivo invalidación', ancho: 30, tipo: 'texto', valor: d => txt(d.invalidacion_motivo) },
  { titulo: 'Sello de invalidación', ancho: 44, tipo: 'texto', valor: d => txt(d.invalidacion_sello) },
]

/** El CCF se emite sin IVA en las líneas: el IVA 13 % se suma aparte. */
const COLUMNAS_CCF: Columna[] = [
  ...inicio, ...receptorCcf, ...lineas, ...ventasYDescuentos,
  dinero('Subtotal (sin IVA)', r('subTotal')),
  dinero('IVA 13%', ivaCcf),
  dinero('IVA percibido', r('ivaPerci1')),
  ...cierre, ...invalidacion,
]

/** El FCF lleva el IVA incluido en el precio: se desglosa para el libro. */
const COLUMNAS_FCF: Columna[] = [
  ...inicio, ...receptorFcf, ...lineas, ...ventasYDescuentos,
  dinero('Subtotal (IVA incluido)', r('subTotal')),
  dinero('Venta neta (sin IVA)', d => num(num(d.resumen?.totalGravada) - num(d.resumen?.totalIva))),
  dinero('IVA 13% incluido', r('totalIva')),
  ...cierre, ...invalidacion,
]

function fechaHoraSv(iso: string): string {
  return new Date(iso).toLocaleString('es-SV', {
    timeZone: 'America/El_Salvador', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

// ─── Hoja ─────────────────────────────────────────────────────

export interface Hoja {
  nombre: string
  columnas: Columna[]
  filas: DteExportado[]
}

export function armarHoja(dtes: DteExportado[], tipo: TipoVentas): Hoja {
  return tipo === 'ccf'
    ? { nombre: 'Contribuyentes (CCF)', columnas: COLUMNAS_CCF, filas: dtes }
    : { nombre: 'Consumidores (FCF)', columnas: COLUMNAS_FCF, filas: dtes }
}

/** «A», «B», … «AA»: para las fórmulas de la fila de totales. */
function letra(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

const FORMATO_DINERO = '#,##0.00'

export async function descargarExcel(h: Hoja, nombreArchivo: string): Promise<void> {
  // Se carga sólo al exportar: no tiene por qué pesar en el resto de la app.
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  const colEstado = letra(inicio.findIndex(c => c.titulo === 'Estado'))

  const encabezado = h.columnas.map(c => ({
    value: c.titulo, fontWeight: 'bold' as const, wrap: true,
    backgroundColor: '#0E3B36', textColor: '#FFFFFF', alignVertical: 'center' as const,
  }))
  const filas = h.filas.map(d => h.columnas.map(c => {
    const v = c.valor(d)
    if (v == null || v === '') return null
    if (c.tipo === 'fecha') {
      const [y, m, dia] = String(v).split('-').map(Number)
      return { value: new Date(Date.UTC(y, m - 1, dia)), type: Date, format: 'dd/mm/yyyy' }
    }
    if (c.tipo === 'dinero' || c.tipo === 'numero') {
      const n = Number(v)
      if (!Number.isFinite(n)) return null
      return c.tipo === 'dinero' ? { value: n, type: Number, format: FORMATO_DINERO } : { value: n, type: Number }
    }
    return { value: String(v), type: String }
  }))
  // Totales de los vigentes: los invalidados están para cuadrar el correlativo.
  const ult = h.filas.length + 1
  const totales = h.columnas.map((c, i) => {
    if (i === 0) return { value: 'Total vigentes', type: String, fontWeight: 'bold' as const }
    if (!c.total || h.filas.length === 0) return null
    const col = letra(i)
    return {
      value: `SUMIFS(${col}2:${col}${ult},${colEstado}2:${colEstado}${ult},"Vigente")`,
      type: 'Formula' as const, format: FORMATO_DINERO, fontWeight: 'bold' as const,
    }
  })

  await writeXlsxFile([encabezado, ...filas, [], totales] as any, {
    sheet: h.nombre,
    columns: h.columnas.map(c => ({ width: c.ancho })),
    stickyRowsCount: 1,
  }).toFile(nombreArchivo)
}

export function descargarCsv(h: Hoja, nombreArchivo: string): void {
  const celda = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const filas = [
    h.columnas.map(c => c.titulo),
    ...h.filas.map(d => h.columnas.map(c => {
      const v = c.valor(d)
      if (v == null) return ''
      if (c.tipo === 'fecha') { const [y, m, dia] = String(v).split('-'); return `${dia}/${m}/${y}` }
      if (c.tipo === 'dinero') return Number(v).toFixed(2)
      return v
    })),
  ]
  const csv = filas.map(f => f.map(celda).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = nombreArchivo
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revocar en el mismo tick cancela la descarga en algunos navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Para el modal: cuántos documentos y cuánto suman los vigentes. */
export function resumenHoja(h: Hoja) {
  const vigentes = h.filas.filter(d => d.estado === 'ACCEPTED')
  return {
    documentos: h.filas.length,
    invalidados: h.filas.length - vigentes.length,
    total: num(vigentes.reduce((s, d) => s + num(d.resumen?.totalPagar), 0)),
  }
}
