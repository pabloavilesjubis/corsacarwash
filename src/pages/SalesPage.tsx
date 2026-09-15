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
  fetchSales, summarize, dateRange, fetchDtePayload,
  type Sale, type SalesFilters,
} from '../services/sales.service'
import { printFactura } from '../lib/fiscal/facturaDocument'
import { printCorsaTicket } from '../lib/ticket/corsaTicket'
import { buildTicketArgsFromSale } from '../lib/ticket/fromSale'
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


// ─── Iconos de descarga ──────────────────────────────────────

const ICONS = {
  ticket: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16v5a3 3 0 0 0 0 6v5H4v-5a3 3 0 0 0 0-6z"/>
      <line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="14" x2="15" y2="14"/>
    </svg>
  ),
  json: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 4H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1"/>
      <path d="M16 4h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1"/>
    </svg>
  ),
  factura: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>
    </svg>
  ),
}

/**
 * Botón de icono para las descargas de cada venta.
 * Cuando está deshabilitado explica por qué en el title: un icono gris sin
 * explicación se lee como que la app está rota.
 */
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

function IconAction({ icon, label, onClick, disabled, reason }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  reason?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `${label} — ${reason ?? 'no disponible'}` : label}
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 10, marginRight: 4,
        border: '1px solid var(--border)', background: 'var(--surface)',
        color: disabled ? 'var(--text-secondary)' : 'var(--text-primary)',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {icon}
    </button>
  )
}

function money(n: number): string {
  return 'US$' + (Number(n) || 0).toFixed(2)
}

function fechaHora(iso: string): string {
  return formatearFechaHora(iso)
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

  const reimprimir = (s: Sale) => {
    try {
      printCorsaTicket(buildTicketArgsFromSale(s, (currentBranch as any)?.name))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo abrir el ticket')
    }
  }

  const verFactura = (s: Sale) => {
    try {
      // Sin DTE transmitido la factura sale rotulada como no válida ante el MH;
      // el documento ya contempla ese caso.
      printFactura(s)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo abrir la factura')
    }
  }

  const descargarJson = async (s: Sale) => {
    if (!s.fiscal_document_id) return
    try {
      const doc = await fetchDtePayload(s.fiscal_document_id)
      const contenido = JSON.stringify(
        { estado: doc.status, enviado: doc.payload, respuesta: doc.response },
        null, 2
      )
      const url = URL.createObjectURL(new Blob([contenido], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `dte-${s.invoice_number || s.order_number}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('No se pudo obtener el JSON del DTE')
    }
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
  /** Las mismas tres acciones, con rótulo y a ancho completo, para la hoja. */
  const accionesGrandes = (s: Sale) => (
    <>
      <button className="btn btn-primary" onClick={() => reimprimir(s)}>
        Reimprimir ticket térmico
      </button>
      <button className="btn btn-ghost"
              onClick={() => verFactura(s)}
              disabled={s.order_kind === 'voucher_redemption'}
              title={s.order_kind === 'voucher_redemption' ? 'Un canje no genera documento fiscal' : undefined}>
        Ver factura (PDF carta)
      </button>
      <button className="btn btn-ghost"
              onClick={() => descargarJson(s)}
              disabled={!s.has_dte_payload}
              title={!s.has_dte_payload ? 'Se genera al transmitir el DTE al Ministerio de Hacienda' : undefined}>
        Descargar JSON del DTE
      </button>
    </>
  )

  const accionesDe = (s: Sale) => (
    <>
      <IconAction icon={ICONS.ticket} label="Ticket térmico (PDF)"
                  onClick={() => reimprimir(s)}/>
      {/* Un canje no genera documento fiscal: el cupón se facturó el día que
          se vendió. */}
      <IconAction icon={ICONS.factura} label="Factura carta (PDF)"
                  onClick={() => verFactura(s)}
                  disabled={s.order_kind === 'voucher_redemption'}
                  reason="un canje no genera documento fiscal"/>
      <IconAction icon={ICONS.json} label="JSON del DTE"
                  onClick={() => descargarJson(s)}
                  disabled={!s.has_dte_payload}
                  reason="se genera al transmitir el DTE al Ministerio de Hacienda"/>
    </>
  )

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
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>Ventas</h1>
          <div className="page-header-sub">
            Historial completo · {sales.length} {sales.length === 1 ? 'venta' : 'ventas'} en el rango
          </div>
        </div>
        <button className="btn btn-ghost" onClick={exportarCsv} disabled={sales.length === 0}>
          Exportar CSV
        </button>
      </div>

      {/* KPIs del rango filtrado */}
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        {[
          { label: 'Ventas', value: String(totals.count) },
          { label: 'Ingreso bruto', value: money(totals.gross) },
          { label: 'IVA incluido', value: money(totals.tax) },
          { label: 'Ticket promedio', value: money(totals.average) },
          { label: 'Cupones', value: `${totals.vouchersSold} vendidos · ${totals.vouchersRedeemed} canjes` },
          { label: 'Con aspirado', value: `${totals.withAspirado} de ${totals.count}` },
        ].map(k => (
          <div key={k.label} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
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
        <input type="date" className="corsa-input" style={{ width: esMovil ? 0 : 150, flex: esMovil ? '1 1 0' : undefined }} value={from}
               onChange={e => setFrom(e.target.value)} aria-label="Desde"/>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>a</span>
        <input type="date" className="corsa-input" style={{ width: esMovil ? 0 : 150, flex: esMovil ? '1 1 0' : undefined }} value={to}
               onChange={e => setTo(e.target.value)} aria-label="Hasta"/>
        <select className="corsa-input" style={{ width: esMovil ? '100%' : 170 }} value={docType}
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
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
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
            <table className="corsa-table">
              <thead>
                <tr>
                  <th>Fecha</th><th>Orden</th><th>Cliente</th><th>Servicio</th>
                  <th>Placa</th><th>Pago</th><th>Documento</th>
                  <th style={{ textAlign: 'right' }}>Total</th><th>Documentos</th>
                </tr>
              </thead>
              <tbody>
                {sales.map(s => (
                  <tr key={s.order_id} style={{ cursor: 'default' }}>
                    <td style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fechaHora(s.created_at)}</td>
                    <td className="font-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{s.order_number}</td>
                    <td style={{ fontSize: 13 }} className="truncate">{s.customer_name}</td>
                    <td style={{ fontSize: 13 }}>
                      {s.order_kind === 'voucher_sale'
                        ? <span className="badge badge-orange">Venta de {s.voucher_quantity ?? ''} cupones</span>
                        : s.order_kind === 'voucher_redemption'
                          ? <span className="badge badge-neutral">Canje de cupón</span>
                          : <>
                              {s.service_name ?? '—'}
                              {s.with_aspirado && (
                                <span className="badge badge-neutral" style={{ marginLeft: 6 }}>+ aspirado</span>
                              )}
                            </>}
                    </td>
                    <td className="font-mono" style={{ fontSize: 12.5 }}>{s.plate ?? '—'}</td>
                    <td style={{ fontSize: 12.5 }}>{s.payment_method ?? '—'}</td>
                    <td>
                      <span className={`badge ${s.invoice_type === 'credito_fiscal' ? 'badge-green' : 'badge-neutral'}`}>
                        {DOC_LABELS[s.invoice_type ?? ''] ?? '—'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(s.total)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{accionesDe(s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
