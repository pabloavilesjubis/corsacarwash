/**
 * CORSA — Excel de ventas para los contadores (0082).
 *
 * Un archivo por tipo de venta: contribuyentes (CCF, tipo 03) o consumidores
 * finales (FCF, tipo 01), en una sola pestaña. Una fila por DTE con las
 * columnas que pide el contador: identificación y sello del documento, el
 * cliente (nombre, NIT, DUI, NRC) y los montos desglosados sin IVA, de modo
 * que gravada + exenta + no sujeta = subtotal y subtotal + IVA = total.
 *
 * Los invalidados se incluyen rotulados: el contador los necesita para cuadrar
 * el correlativo, pero el total de cada pestaña suma sólo los vigentes.
 */

import { supabase } from '../supabase'

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

/** Todos los DTE del rango, CCF y FCF, sellados e invalidados. */
export async function fetchDtesDelRango(desde: string, hasta: string): Promise<DteExportado[]> {
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
  return todos
}

export async function fetchDtesParaContadores(desde: string, hasta: string, tipo: TipoVentas): Promise<DteExportado[]> {
  return (await fetchDtesDelRango(desde, hasta)).filter(d => d.dte_type === DTE_DE[tipo])
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

const TIPO_DTE: Record<string, string> = { '01': 'Factura consumidor final', '03': 'Comprobante de crédito fiscal' }

/** El número que el DTE de consumidor final trae en el receptor, si es de ese tipo. */
const docReceptor = (d: DteExportado, codigo: '13' | '36') =>
  d.receptor?.tipoDocumento === codigo ? txt(d.receptor?.numDocumento) : null

/**
 * El IVA del documento. El CCF lo trae aparte, en resumen.tributos (código
 * 20); el FCF lo trae incluido en el precio y lo informa en totalIva.
 */
const iva = (d: DteExportado) => d.dte_type === '03'
  ? num((d.resumen?.tributos ?? []).filter((t: any) => t?.codigo === '20').reduce((s: number, t: any) => s + num(t.valor), 0))
  : num(d.resumen?.totalIva)

/**
 * La venta gravada SIN IVA, para que las columnas cuadren igual en los dos
 * documentos: gravada + exenta + no sujeta = subtotal, y subtotal + IVA =
 * total. En el FCF el DTE la trae con IVA incluido, así que se le resta.
 */
const gravada = (d: DteExportado) =>
  num(num(d.resumen?.totalGravada) - (d.dte_type === '03' ? 0 : num(d.resumen?.totalIva)))
const exenta = (d: DteExportado) => num(d.resumen?.totalExenta)
const noSujeta = (d: DteExportado) => num(d.resumen?.totalNoSuj)
const subtotal = (d: DteExportado) => num(gravada(d) + exenta(d) + noSujeta(d))
/** La venta con IVA: monto total de la operación, antes de retenciones. */
const totalConIva = (d: DteExportado) => num(d.resumen?.montoTotalOperacion)

const dinero = (titulo: string, valor: (d: DteExportado) => number): Columna =>
  ({ titulo, ancho: 14, tipo: 'dinero', valor, total: true })

/**
 * Las columnas que pide el contador, siempre las mismas y en este orden. Las
 * de exenta y no sujeta van aunque estén en cero: el contador las espera.
 */
const COLUMNAS: Columna[] = [
  { titulo: 'Fecha de emisión', ancho: 12, tipo: 'fecha', valor: d => d.identificacion?.fecEmi ?? null },
  { titulo: 'Hora de emisión', ancho: 10, tipo: 'texto', valor: d => txt(d.identificacion?.horEmi) },
  { titulo: 'Tipo de documento', ancho: 28, tipo: 'texto', valor: d => TIPO_DTE[d.dte_type] ?? d.dte_type },
  { titulo: 'Estado', ancho: 11, tipo: 'texto', valor: d => (d.estado === 'INVALIDATED' ? 'Invalidado' : 'Vigente') },
  { titulo: 'Número de control', ancho: 34, tipo: 'texto', valor: d => d.numero_control },
  { titulo: 'Código de generación', ancho: 40, tipo: 'texto', valor: d => txt(d.codigo_generacion) },
  { titulo: 'Sello de recepción', ancho: 44, tipo: 'texto', valor: d => txt(d.sello_recepcion) },
  { titulo: 'Nombre del cliente', ancho: 34, tipo: 'texto',
    valor: d => txt(d.receptor?.nombre ?? d.cliente_nombre) ?? 'Consumidor final' },
  { titulo: 'NIT', ancho: 17, tipo: 'texto', valor: d => txt(d.receptor?.nit) ?? docReceptor(d, '36') ?? txt(d.cliente_nit) },
  { titulo: 'DUI', ancho: 12, tipo: 'texto', valor: d => docReceptor(d, '13') ?? txt(d.cliente_dui) },
  { titulo: 'NRC', ancho: 10, tipo: 'texto', valor: d => txt(d.receptor?.nrc ?? d.cliente_nrc) },
  dinero('Venta gravada', gravada),
  dinero('Venta exenta', exenta),
  dinero('Venta no sujeta', noSujeta),
  dinero('Subtotal de venta', subtotal),
  dinero('IVA', iva),
  dinero('Total de venta con IVA', totalConIva),
]

// ─── Hoja ─────────────────────────────────────────────────────

export interface Hoja {
  nombre: string
  columnas: Columna[]
  filas: DteExportado[]
}

export function armarHoja(dtes: DteExportado[], tipo: TipoVentas): Hoja {
  return { nombre: tipo === 'ccf' ? 'Contribuyentes (CCF)' : 'Consumidores (FCF)', columnas: COLUMNAS, filas: dtes }
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
  const colEstado = letra(h.columnas.findIndex(c => c.titulo === 'Estado'))

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
    total: num(vigentes.reduce((s, d) => s + totalConIva(d), 0)),
  }
}
