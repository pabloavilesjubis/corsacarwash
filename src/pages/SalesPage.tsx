/**
 * CORSA Carwash — Ventas (historial completo)
 *
 * Complementa el «Resumen del día», que sólo mira hoy. Acá va todo el
 * histórico, filtrable por rango de fechas, documento fiscal y búsqueda, y
 * desde cada línea se puede reimprimir el ticket.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { useEsMovil } from '../hooks/useEsMovil'
import {
  fetchSales, summarize, dateRange, fetchDteDeVenta,
  type DteDeVenta, type Sale, type SalesFilters,
} from '../services/sales.service'
import { printFactura } from '../lib/fiscal/facturaDocument'
import { imprimirTicketEnSegundoPlano } from '../lib/ticket/corsaTicket'
import { emitirConFirmaLocal, fetchJsonDelDte, descargarJson } from '../services/fiscal.service'
import { enviarCorreoVenta } from '../services/correo.service'
import { AjusteVentaModal, type TipoAjuste } from '../components/AjusteVentaModal'
import { buildTicketArgsFromSale } from '../lib/ticket/fromSale'
import { emisorParaTicket, exigirEmisor } from '../lib/fiscal/emisor'
import { formatearFechaHora } from '../utils/fecha'

const PRESETS = [
  { id: 'hoy',        label: 'Hoy' },
  { id: 'semana',     label: 'Últimos 7 días' },
  { id: 'mes',        label: 'Este mes' },
  { id: 'mes_pasado', label: 'Mes pasado' },
  { id: 'anio',       label: 'Este año' },
  { id: 'todo',       label: 'Todo' },
] as const
type PresetId = typeof PRESETS[number]['id']

const DOC_LABELS: Record<string, string> = {
  consumidor_final: 'Ticket',
  credito_fiscal: 'CCF',
  nota_credito: 'Nota de crédito',
  nota_debito: 'Nota de débito',
}

/**
 * Una venta, en el teléfono: sólo lo que sirve para reconocerla.
 *
 * Cuatro datos —cuánto, quién, cuándo y qué orden— entran en dos renglones. El
 * resto (documento fiscal, método de pago, placa, impuestos, líneas) vive en el
 * detalle, a un toque. Con todo a la vista, cada venta ocupaba media pantalla
 * y buscar la de las 3 de la tarde eran veinte scrolls.
 */
function LineaVenta({ s, onAbrir }: { s: Sale; onAbrir: () => void }) {
  return (
    <button
      onClick={onAbrir}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '11px 14px', border: 'none',
        borderBottom: '1px solid var(--border)',
        background: 'transparent', cursor: 'pointer',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span className="font-mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
          {s.order_number}
        </span>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15.5, fontVariantNumeric: 'tabular-nums' }}>
          {money(s.total)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginTop: 3 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }} className="truncate">
          {s.customer_name}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          {fechaHora(s.created_at)}
        </span>
      </div>
    </button>
  )
}

/** Una fila de dato en el detalle. Se omite sola cuando no hay qué mostrar. */
function Dato({ label, valor }: { label: string; valor: React.ReactNode }) {
  if (valor == null || valor === '' || valor === '—') return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--text-primary)', textAlign: 'right' }}>{valor}</span>
    </div>
  )
}

/**
 * El detalle de una venta, en hoja.
 *
 * Los tres documentos van acá abajo y a ancho completo: en la lista eran tres
 * iconos de 28 px pegados entre sí, y equivocarse de documento delante del
 * cliente es el tipo de error que no se nota hasta que se imprimió.
 */
function DetalleVenta({ s, onCerrar, acciones }: {
  s: Sale; onCerrar: () => void; acciones: React.ReactNode
}) {
  const esCanje = s.order_kind === 'voucher_redemption'
  const esCupones = s.order_kind === 'voucher_sale'

  return (
    <>
      <div onClick={onCerrar}
           style={{ position: 'fixed', inset: 0, background: 'rgba(2,20,18,0.5)', zIndex: 60 }}/>
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 61,
        background: 'var(--surface)', borderRadius: '14px 14px 0 0',
        maxHeight: '90dvh', overflowY: 'auto',
        padding: '10px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
        boxShadow: '0 -12px 40px rgba(0,0,0,0.22)',
      }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--border)', margin: '2px auto 12px' }}/>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <span className="font-mono" style={{ fontSize: 13, fontWeight: 700 }}>{s.order_number}</span>
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>
            {money(s.total)}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
          {fechaHora(s.created_at)}
        </div>

        <div style={{ marginTop: 14 }}>
          <Dato label="Cliente" valor={s.customer_name}/>
          <Dato label="NIT" valor={s.customer_nit}/>
          <Dato label="DUI" valor={s.customer_dui}/>
          <Dato label="Servicio" valor={
            esCupones ? `Venta de ${s.voucher_quantity ?? ''} cupones`
              : esCanje ? 'Canje de cupón'
              : `${s.service_name ?? '—'}${s.with_aspirado ? ' + aspirado' : ''}`
          }/>
          <Dato label="Placa" valor={s.plate}/>
          <Dato label="Pago" valor={s.payment_method}/>
          <Dato label="Documento" valor={
            <>
              {DOC_LABELS[s.invoice_type ?? ''] ?? '—'}
              {s.invoice_number && <span className="font-mono" style={{ marginLeft: 6, fontSize: 12 }}>{s.invoice_number}</span>}
            </>
          }/>
          <Dato label="Subtotal" valor={money(s.subtotal)}/>
          <Dato label="IVA" valor={money(s.tax_total)}/>
          <Dato label="Sucursal" valor={s.branch_name}/>
        </div>

        {/* Las líneas tal como se facturaron, cuando la venta las tiene. */}
        {!!s.items?.length && (
          <div style={{ marginTop: 14 }}>
            <div className="panel-section-label">Detalle facturado</div>
            {s.items.map((i, n) => (
              <div key={n} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', fontSize: 12.5 }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {i.cantidad > 1 && <strong style={{ color: 'var(--text-primary)' }}>{i.cantidad}× </strong>}
                  {i.descripcion}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(i.total)}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {acciones}
        </div>

        <button onClick={onCerrar} className="btn btn-ghost" style={{ width: '100%', marginTop: 10 }}>
          Cerrar
        </button>
      </div>
    </>
  )
}


/** Acción de la tabla con su nombre escrito: «Ticket», «PDF», «.json»… */
function ChipAction({ label, title, onClick, disabled, reason, peligro }: {
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
  reason?: string
  peligro?: boolean
}) {
  return (
    <button type="button" className={`ventas-chip${peligro ? ' peligro' : ''}`} onClick={onClick} disabled={disabled}
            title={disabled ? `${title} — ${reason ?? 'no disponible'}` : title} aria-label={title}>
      {label}
    </button>
  )
}

/** «ESC-2026-000015» → «15»: con una sola sucursal basta el correlativo. */
function correlativo(orden: string): string {
  const m = /(\d+)$/.exec(orden ?? '')
  return m ? String(Number(m[1])) : orden
}

function money(n: number): string {
  return 'US$' + (Number(n) || 0).toFixed(2)
}

function fechaHora(iso: string): string {
  return formatearFechaHora(iso)
}

/** «04 oct · 14:56»: la fecha de la fila en una sola línea corta. */
function fechaFila(iso: string): string {
  const d = new Date(iso)
  const dia = d.toLocaleDateString('es-SV', { day: '2-digit', month: 'short', timeZone: 'America/El_Salvador' }).replace('.', '')
  const hora = d.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/El_Salvador' })
  return `${dia} · ${hora}`
}

export function SalesPage() {
  const { hasPermission, currentBranch } = useAuth()
  const canRead = hasPermission('screens.sales') || hasPermission('reports.sales')
  const esMovil = useEsMovil()
  // Qué venta está abierta en la hoja de detalle (sólo teléfono).
  const [detalle, setDetalle] = useState<Sale | null>(null)

  const [preset, setPreset] = useState<PresetId>('mes')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [docType, setDocType] = useState('')
  const [search, setSearch] = useState('')
  const [sales, setSales] = useState<Sale[]>([])
  const [loading, setLoading] = useState(true)

  // El preset escribe las fechas; tocarlas a mano pasa a 'personalizado'.
  useEffect(() => {
    if (preset === 'todo') { setFrom(''); setTo(''); return }
    const r = dateRange(preset)
    setFrom(r.from); setTo(r.to)
  }, [preset])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const filters: SalesFilters = {
        from: from || undefined,
        to: to || undefined,
        invoiceType: docType || undefined,
        search: search || undefined,
      }
      setSales(await fetchSales(filters))
    } catch {
      toast.error('No se pudieron cargar las ventas')
    }
    setLoading(false)
  }, [from, to, docType, search])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  const totals = useMemo(() => summarize(sales), [sales])

  /**
   * Busca el DTE de la venta, si lo tiene. Un error al buscarlo no impide
   * imprimir: el documento sale con el bloque fiscal como pendiente, y eso
   * se avisa para que nadie entregue ese papel creyendo que está completo.
   */
  const dteDe = async (s: Sale): Promise<DteDeVenta | null> => {
    if (!s.invoice_id || s.dte_status === 'no_emitido') return null
    try {
      return await fetchDteDeVenta(s.invoice_id)
    } catch {
      toast.error('No se pudo leer el DTE de esta venta; se imprime sin él')
      return null
    }
  }

  // En segundo plano, sin ventanas: sale directo por la impresora predeterminada.
  const reimprimir = async (s: Sale) => {
    try {
      // El emisor es el de la sucursal donde se vendió, no el de la que está
      // abierta ahora: es el que va dentro de su DTE.
      const dte = await dteDe(s)
      const emisor = await emisorParaTicket(s.branch_id, !!dte)
      await imprimirTicketEnSegundoPlano(buildTicketArgsFromSale(s, emisor, s.branch_name || (currentBranch as any)?.name, dte))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo abrir el ticket')
    }
  }

  const verFactura = async (s: Sale) => {
    const ventana = window.open('', `corsa_factura_${s.order_id}`, 'width=900,height=1000')
    try {
      // Sin DTE transmitido la factura sale rotulada como no válida ante el MH.
      // La factura carta es siempre un documento fiscal: sin emisor completo
      // no sale, y el error dice qué falta.
      const [dte, emisor] = await Promise.all([dteDe(s), exigirEmisor(s.branch_id)])
      printFactura(s, emisor, dte, ventana)
    } catch (err) {
      ventana?.close()
      toast.error(err instanceof Error ? err.message : 'No se pudo abrir la factura')
    }
  }

  /** El JSON del DTE como lo entrega Hacienda: documento + firmaElectronica + selloRecibido. */
  const tieneJson = (s: Sale) => !!s.fiscal_document_id && (s.dte_status === 'ACCEPTED' || s.dte_status === 'INVALIDATED')

  const descargarJsonDte = async (s: Sale) => {
    if (!s.fiscal_document_id) return
    try {
      const { json, numeroControl } = await fetchJsonDelDte(s.fiscal_document_id)
      descargarJson(`${numeroControl ?? `dte-${s.invoice_number || s.order_number}`}.json`, json)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo obtener el JSON del DTE')
    }
  }

  /**
   * Emitir el DTE de una venta ya cobrada que no tiene sello de Hacienda.
   * Firma LOCAL: hay que estar en la PC de facturación, con la estación
   * fiscal lista. Un documento a medio camino (preparado, pendiente, sin
   * respuesta) se retoma: el MISMO, sin otro número. Uno RECHAZADO se regenera:
   * el Worker abre un documento nuevo con los datos actuales de la ficha.
   */
  const sellado = (s: Sale) => s.dte_status === 'ACCEPTED' || s.dte_status === 'INVALIDATED'
  const puedeEmitir = (s: Sale) =>
    hasPermission('fiscal.issue') && !!s.invoice_id && s.order_kind !== 'voucher_redemption' && s.status !== 'cancelled' &&
    !sellado(s)
  const rotuloEmitir = (s: Sale) =>
    s.dte_status === 'REJECTED' ? 'Regenerar DTE (rechazado)'
      : s.dte_status === 'no_emitido' ? 'Emitir DTE con Hacienda'
      : 'Reintentar DTE (sin sello)'

  const [emitiendo, setEmitiendo] = useState<string | null>(null)

  /**
   * Anular y cambiar forma de pago (0048). Cualquiera con acceso a Ventas ve
   * los botones; quien no es Super Admin ni Administrador necesita que un
   * Super Admin autorice con su contraseña en el diálogo.
   */
  const [ajuste, setAjuste] = useState<{ tipo: TipoAjuste; venta: Sale } | null>(null)
  const anulada = (s: Sale) => s.status === 'cancelled'
  const puedeAnular = (s: Sale) => !anulada(s)
  const puedeCambiarPago = (s: Sale) => !anulada(s) && s.order_kind !== 'voucher_redemption' && Number(s.total) > 0
  const emitirDte = async (s: Sale) => {
    if (!s.invoice_id || emitiendo) return
    const tipo = s.invoice_type === 'credito_fiscal' ? 'Crédito Fiscal (CCF)' : 'Factura Consumidor Final (FCF)'
    const aviso = s.dte_status === 'REJECTED'
      ? `Hacienda rechazó el DTE ${s.dte_numero_control ?? ''} de la venta ${s.order_number}:\n«${s.dte_error ?? 'sin motivo registrado'}»\n\n` +
        'Si el problema está en los datos del cliente (NIT, NRC, dirección…), corregí la ficha del cliente ANTES: ' +
        `el DTE nuevo sale con lo que tenga la ficha.\n\nSe emitirá una ${tipo} NUEVA por ${money(Number(s.total))}, ` +
        'con el siguiente correlativo. ¿Continuar?'
      : s.dte_status === 'no_emitido'
        ? `Se emitirá ante Hacienda la ${tipo} de la venta ${s.order_number} por ${money(Number(s.total))}.\n\n` +
          'Es un documento tributario real y usa el siguiente correlativo. ¿Continuar?'
        : `El DTE ${s.dte_numero_control ?? ''} de la venta ${s.order_number} no tiene sello de Hacienda` +
          `${s.dte_error ? `:\n«${s.dte_error}»` : '.'}\n\nSe retoma EL MISMO documento, sin pedir otro número. ¿Continuar?`
    if (!window.confirm(aviso)) return
    setEmitiendo(s.order_id)
    const espera = toast.loading('Firmando en la estación fiscal y transmitiendo a Hacienda…')
    try {
      const r = await emitirConFirmaLocal(s.invoice_id, { manual: true })
      if (r.estado === 'ACCEPTED') {
        toast.success(`DTE sellado por Hacienda: ${r.numeroControl ?? ''}`, { id: espera, duration: 8000 })
        // El ticket que se entregó salió sin sello: el nuevo sale con él.
        reimprimir({ ...s, dte_status: 'ACCEPTED' })
        // Y el correo con el DTE, ahora que está sellado.
        enviarCorreoVenta(s.order_id).then(r => {
          if (!r.ok) toast.error(`DTE sellado, pero el correo no salió: ${r.error ?? ''}`, { duration: 8000 })
          load()
        })
        if (r.documentoId) {
          const { json, numeroControl } = await fetchJsonDelDte(r.documentoId)
          descargarJson(`${numeroControl ?? r.numeroControl ?? 'dte'}.json`, json)
        }
      } else {
        toast.error(`DTE ${r.estado === 'REJECTED' ? 'rechazado' : 'pendiente'}: ${r.mensaje ?? 'revisalo en Contabilidad'}`,
          { id: espera, duration: 12000 })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo emitir el DTE', { id: espera, duration: 12000 })
    }
    setEmitiendo(null)
    load()
  }

  const exportarCsv = () => {
    const filas = [
      ['Fecha', 'Orden', 'Cliente', 'Servicio', 'Aspirado', 'Placa', 'Pago', 'Documento', 'Subtotal', 'IVA', 'Total'],
      ...sales.map(s => [
        // Hora del carwash: el CSV lo lee gente de acá, no una máquina.
        formatearFechaHora(s.created_at),
        s.order_number, s.customer_name, s.service_name ?? '',
        s.with_aspirado ? 'Sí' : 'No', s.plate ?? '', s.payment_method ?? '',
        DOC_LABELS[s.invoice_type ?? ''] ?? '',
        String(s.subtotal), String(s.tax_total), String(s.total),
      ]),
    ]
    // Comillas dobles escapadas: los nombres de cliente pueden traer comas.
    const csv = filas.map(f => f.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `ventas-corsa-${from || 'inicio'}_${to || 'hoy'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  /**
   * Los tres documentos de una venta. Una sola definición para la tabla y para
   * la tarjeta: si mañana cambia una regla —qué se puede reimprimir y qué no—
   * no puede quedar cambiada en un formato y vieja en el otro.
   */
  /**
   * El correo de la venta (0061): verde si salió, rojo si no. Sólo cuando hay
   * algo que mandar: el DTE sellado, o el lavado de un cliente al crédito.
   */
  const [enviandoCorreo, setEnviandoCorreo] = useState<string | null>(null)
  const tieneCorreo = (s: Sale) => s.status !== 'cancelled' && (s.dte_status === 'ACCEPTED' || s.facturacion_diferida)
  const reintentarCorreo = async (s: Sale) => {
    if (s.correo_estado === 'sent' || enviandoCorreo) return
    if (!window.confirm(`El correo de la venta ${s.order_number} no se envió${s.correo_error ? `:\n«${s.correo_error}»` : '.'}\n\n¿Reintentar el envío?`)) return
    setEnviandoCorreo(s.order_id)
    const r = await enviarCorreoVenta(s.order_id)
    setEnviandoCorreo(null)
    if (r.ok) toast.success(`Correo enviado a ${r.destinatarios?.join(', ') ?? ''}`)
    else toast.error(r.error ?? 'No se pudo enviar el correo', { duration: 10000 })
    load()
  }
  const TarjetaCorreo = ({ s }: { s: Sale }) => {
    if (!tieneCorreo(s)) return null
    const enviado = s.correo_estado === 'sent'
    const cargando = enviandoCorreo === s.order_id
    return (
      <button type="button" onClick={() => reintentarCorreo(s)} disabled={enviado || cargando}
        title={enviado ? `Enviado ${s.correo_at ? fechaHora(s.correo_at) : ''}` : (s.correo_error ?? 'No se ha enviado: tocá para reintentar')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 700,
          border: `1px solid ${enviado ? 'var(--color-success-text)' : 'var(--color-danger-text)'}`,
          background: enviado ? 'var(--color-success-tint)' : 'var(--color-danger-tint)',
          color: enviado ? 'var(--color-success-text)' : 'var(--color-danger-text)',
          cursor: enviado ? 'default' : 'pointer', whiteSpace: 'nowrap', fontFamily: 'var(--font-body)',
        }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>
        {cargando ? 'Enviando…' : enviado ? 'Enviado' : 'No enviado'}
      </button>
    )
  }

  /** En la tabla, el correo es un punto: verde salió, rojo no (tocá para reintentar). */
  const PuntoCorreo = ({ s }: { s: Sale }) => {
    if (!tieneCorreo(s)) return <span style={{ color: 'var(--text-secondary)' }}>·</span>
    const enviado = s.correo_estado === 'sent'
    const cargando = enviandoCorreo === s.order_id
    return (
      <button type="button" className="ventas-correo" onClick={() => reintentarCorreo(s)} disabled={enviado || cargando}
        aria-label={enviado ? 'Correo enviado' : 'Correo no enviado'}
        title={cargando ? 'Enviando…' : enviado ? `Correo enviado ${s.correo_at ? fechaHora(s.correo_at) : ''}` : `Correo no enviado${s.correo_error ? `: ${s.correo_error}` : ''} · tocá para reintentar`}
        style={{ background: cargando ? 'var(--color-warning)' : enviado ? 'var(--color-success)' : 'var(--color-danger)', cursor: enviado ? 'default' : 'pointer' }}/>
    )
  }

  /** Las mismas tres acciones, con rótulo y a ancho completo, para la hoja. */
  const accionesGrandes = (s: Sale) => (
    <>
      {tieneCorreo(s) && <div><TarjetaCorreo s={s}/></div>}
      <button className="btn btn-primary" onClick={() => reimprimir(s)}>
        Reimprimir ticket térmico
      </button>
      <button className="btn btn-ghost"
              onClick={() => verFactura(s)}
              disabled={s.order_kind === 'voucher_redemption'}
              title={s.order_kind === 'voucher_redemption' ? 'Un canje no genera documento fiscal' : undefined}>
        Ver factura (PDF carta)
      </button>
      {puedeEmitir(s) && (
        <button className="btn btn-primary" onClick={() => emitirDte(s)} disabled={emitiendo !== null}>
          {emitiendo === s.order_id ? 'Emitiendo…' : rotuloEmitir(s)}
        </button>
      )}
      {puedeCambiarPago(s) && (
        <button className="btn btn-ghost" onClick={() => setAjuste({ tipo: 'pago', venta: s })}>
          Cambiar forma de pago
        </button>
      )}
      {puedeAnular(s) && (
        <button className="btn btn-ghost" style={{ color: 'var(--color-danger-text)' }}
                onClick={() => setAjuste({ tipo: 'anular', venta: s })}>
          Anular venta
        </button>
      )}
      <button className="btn btn-ghost"
              onClick={() => descargarJsonDte(s)}
              disabled={!tieneJson(s)}
              title={!tieneJson(s) ? 'Se genera cuando Hacienda sella el DTE' : undefined}>
        Descargar JSON del DTE
      </button>
    </>
  )

  const accionesDe = (s: Sale) => (
    <>
      <ChipAction label="Ticket" title="Ticket térmico (PDF)" onClick={() => reimprimir(s)}/>
      {/* Un canje no genera documento fiscal: el cupón se facturó el día que
          se vendió. */}
      <ChipAction label="PDF" title="Factura carta (PDF)" onClick={() => verFactura(s)}
                  disabled={s.order_kind === 'voucher_redemption'} reason="un canje no genera documento fiscal"/>
      <ChipAction label=".json" title="JSON del DTE" onClick={() => descargarJsonDte(s)}
                  disabled={!tieneJson(s)} reason="se genera cuando Hacienda sella el DTE"/>
      {puedeEmitir(s) && (
        <ChipAction label={emitiendo === s.order_id ? 'Emitiendo…' : 'Emitir'} title={rotuloEmitir(s)}
                    onClick={() => emitirDte(s)} disabled={emitiendo !== null} reason="hay otra emisión en curso"/>
      )}
      {puedeAnular(s) && (
        <ChipAction label="Anular" title="Anular venta" peligro onClick={() => setAjuste({ tipo: 'anular', venta: s })}/>
      )}
    </>
  )

  /** La forma de pago, como tarjetita: si se puede cambiar, al tocarla lo ofrece. */
  const PagoDe = ({ s }: { s: Sale }) => {
    const texto = s.payment_method ?? (s.facturacion_diferida ? 'Crédito' : '—')
    if (!puedeCambiarPago(s)) return <span className="ventas-pago fijo">{texto}</span>
    return (
      <button type="button" className="ventas-pago" title="Tocá para cambiar la forma de pago"
              onClick={() => {
                if (window.confirm(`La venta ${s.order_number} se cobró con ${texto}.\n\n¿Deseás cambiar el método de pago?`)) {
                  setAjuste({ tipo: 'pago', venta: s })
                }
              }}>
        {texto}
      </button>
    )
  }

  if (!canRead) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso a Ventas</div>
          <div className="empty-state-sub">Pedile acceso a un administrador.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-inner ventas-page">
      <div className="ventas-head">
        <div>
          <h1 style={{ display: 'inline' }}>Ventas</h1>
          <span className="sub">{sales.length} {sales.length === 1 ? 'venta' : 'ventas'} en el rango</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={exportarCsv} disabled={sales.length === 0}>
          Exportar CSV
        </button>
      </div>

      {/* KPIs del rango filtrado: una franja, no tarjetas */}
      <div className="ventas-kpis">
        {[
          { label: 'Ventas', value: String(totals.count) },
          { label: 'Venta facturada', value: money(totals.facturada) },
          { label: 'Sólo CxC (sin facturar)', value: money(totals.soloCxc) },
          { label: 'IVA incluido', value: money(totals.tax) },
          { label: 'Ticket promedio', value: money(totals.average) },
          { label: 'Cupones', value: `${totals.vouchersSold} vend. · ${totals.vouchersRedeemed} canj.` },
          { label: 'Con aspirado', value: `${totals.withAspirado} de ${totals.count}` },
        ].map(k => (
          <div key={k.label} className="ventas-kpi" title={k.label}>
            <div className="l">{k.label}</div>
            <div className="v">{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="ventas-filtros">
        <div className="filter-pills">
          {PRESETS.map(p => (
            <button key={p.id}
              className={`filter-pill${preset === p.id ? ' active' : ''}`}
              onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {/* Los anchos fijos de escritorio no entran en 390 px: las dos fechas
            se reparten la fila y el resto ocupa el ancho completo. */}
        <input type="date" className="corsa-input" style={{ width: esMovil ? 0 : 132, flex: esMovil ? '1 1 0' : undefined }} value={from}
               onChange={e => setFrom(e.target.value)} aria-label="Desde"/>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>a</span>
        <input type="date" className="corsa-input" style={{ width: esMovil ? 0 : 132, flex: esMovil ? '1 1 0' : undefined }} value={to}
               onChange={e => setTo(e.target.value)} aria-label="Hasta"/>
        <select className="corsa-input" style={{ width: esMovil ? '100%' : 150 }} value={docType}
                onChange={e => setDocType(e.target.value)} aria-label="Documento">
          <option value="">Todos los documentos</option>
          <option value="consumidor_final">Ticket</option>
          <option value="credito_fiscal">CCF</option>
        </select>
        <input className="corsa-input" style={{ flex: '1 1 200px', minWidth: esMovil ? 0 : 180 }}
               placeholder="Orden, cliente o placa…" value={search}
               onChange={e => setSearch(e.target.value)}/>
      </div>

      {/* Tabla */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
        ) : sales.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">Sin ventas en este rango</div>
            <div className="empty-state-sub">Probá con otro período o quitá los filtros.</div>
          </div>
        ) : esMovil ? (
          /* Mismos datos y mismos filtros: sólo cambia la forma. La tabla sigue
             viva para la computadora, intacta. */
          sales.map(s => (
            <LineaVenta key={s.order_id} s={s} onAbrir={() => setDetalle(s)}/>
          ))
        ) : (
          <div className="table-wrap">
            <table className="corsa-table ventas-tabla">
              <thead>
                <tr>
                  <th>Fecha</th><th>#</th><th>Cliente</th><th>Servicio</th>
                  <th>Placa</th><th>Pago</th><th>Doc.</th>
                  <th style={{ textAlign: 'right' }}>Total</th><th title="Correo">✉</th><th style={{ textAlign: 'right' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {sales.map(s => (
                  <tr key={s.order_id}>
                    <td style={{ color: 'var(--text-secondary)' }} title={fechaHora(s.created_at)}>{fechaFila(s.created_at)}</td>
                    <td className="font-mono" style={{ fontSize: 12, fontWeight: 600 }}>
                      <span style={anulada(s) ? { textDecoration: 'line-through', opacity: 0.6 } : undefined} title={s.order_number}>#{correlativo(s.order_number)}</span>
                      {anulada(s) && <span className="badge badge-neutral" style={{ marginLeft: 4 }}>Anulada</span>}
                    </td>
                    <td className="cliente" title={s.customer_name}>{s.customer_name}</td>
                    <td className="servicio">
                      {s.order_kind === 'voucher_sale'
                        ? <span className="badge badge-orange">{s.voucher_quantity ?? ''} cupones</span>
                        : s.order_kind === 'voucher_redemption'
                          ? <span className="badge badge-neutral">Canje de cupón</span>
                          : s.order_kind === 'addon_sale'
                            ? <>{(s.items ?? []).map(i => String(i.descripcion).replace(/^Aspirado de interiores/, 'Aspirado')).join(' + ') || '—'}<span className="extra">sin lavado</span></>
                            : <>{s.service_name ?? '—'}{s.with_aspirado && <span className="extra">+ aspirado</span>}</>}
                    </td>
                    <td className="font-mono" style={{ fontSize: 12 }}>{s.plate ?? '—'}</td>
                    <td><PagoDe s={s}/></td>
                    <td>
                      {s.facturacion_diferida && !s.invoice_type
                        ? <span className="badge badge-warning" title="Se factura en el CCF consolidado desde Cuentas por cobrar">Por facturar</span>
                        : <span className={`badge ${s.invoice_type === 'credito_fiscal' ? 'badge-green' : 'badge-neutral'}`}>
                            {DOC_LABELS[s.invoice_type ?? ''] ?? '—'}
                          </span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(s.total)}</td>
                    <td><PuntoCorreo s={s}/></td>
                    <td><div className="acciones">{accionesDe(s)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {ajuste && (
        <AjusteVentaModal
          tipo={ajuste.tipo}
          venta={ajuste.venta}
          tienePermiso={hasPermission(ajuste.tipo === 'anular' ? 'sales.void' : 'sales.change_payment')}
          onCerrar={() => setAjuste(null)}
          onHecho={() => { setDetalle(null); load() }}
        />
      )}

      {/* Detalle de una venta — sólo teléfono */}
      {esMovil && detalle && (
        <DetalleVenta
          s={detalle}
          onCerrar={() => setDetalle(null)}
          acciones={accionesGrandes(detalle)}
        />
      )}
    </div>
  )
}
