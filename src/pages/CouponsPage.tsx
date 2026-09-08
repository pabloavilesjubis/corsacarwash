/**
 * CORSA Carwash — Cupones
 *
 * Todos los cupones emitidos, con su estado. Filtrable por estado, cliente y
 * fechas. Desde acá se reimprime el PDF de un lote completo.
 *
 * Si la URL trae ?v=<token>, viene de escanear un QR: se busca ese cupón y se
 * resalta, que es el flujo de validación en mostrador.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import {
  fetchVouchers, fetchBatchVouchers,
  type VoucherRow, type VoucherFilters,
} from '../services/vouchers.service'
import { printVouchers } from '../lib/vouchers/voucherDocument'

const ESTADOS = [
  { id: '', label: 'Todos' },
  { id: 'active', label: 'Sin usar' },
  { id: 'redeemed', label: 'Usados' },
  { id: 'void', label: 'Anulados' },
] as const

function money(n: number) { return 'US$' + (Number(n) || 0).toFixed(2) }

function fecha(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-SV', { day: '2-digit', month: 'short', year: '2-digit' })
}

export function CouponsPage() {
  const { hasPermission } = useAuth()
  const puedeVer = hasPermission('vouchers.read')
  const [params, setParams] = useSearchParams()
  const token = params.get('v')

  const [status, setStatus] = useState<string>('')
  const [origen, setOrigen] = useState<'' | 'venta' | 'regalia'>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<VoucherRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const f: VoucherFilters = {
        status: (status || undefined) as VoucherFilters['status'],
        from: from || undefined,
        to: to || undefined,
        search: search || undefined,
      }
      const data = await fetchVouchers(f)
      // El origen se filtra en el cliente: es un flag, no vale un ida y vuelta.
      setRows(origen === '' ? data : data.filter(r => (origen === 'regalia') === r.is_gift))
    } catch {
      toast.error('No se pudieron cargar los cupones')
    }
    setLoading(false)
  }, [status, from, to, search, origen])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  // Cupón escaneado: se localiza aunque no encaje con los filtros activos.
  const escaneado = useMemo(
    () => (token ? rows.find(r => r.validation_token === token) ?? null : null),
    [token, rows]
  )

  useEffect(() => {
    if (token && !loading && !escaneado && status) {
      // El filtro activo lo está escondiendo: se limpia para poder mostrarlo.
      setStatus('')
    }
  }, [token, loading, escaneado, status])

  const totales = useMemo(() => ({
    total: rows.length,
    activos: rows.filter(r => r.status === 'active').length,
    usados: rows.filter(r => r.status === 'redeemed').length,
    // Sólo lo vendido: una regalía no representa dinero por devolver.
    valorActivo: rows.filter(r => r.status === 'active' && !r.is_gift)
      .reduce((s, r) => s + Number(r.unit_value || 0), 0),
    regalias: rows.filter(r => r.is_gift).length,
  }), [rows])

  const reimprimir = async (batchId: string) => {
    try {
      printVouchers(await fetchBatchVouchers(batchId))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo generar el PDF')
    }
  }

  if (!puedeVer) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso a Cupones</div>
          <div className="empty-state-sub">Se requiere el permiso <strong>vouchers.read</strong>.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 26 }}>Cupones</h1>
          <div className="page-header-sub">{rows.length} cupones en el filtro actual</div>
        </div>
      </div>

      {escaneado && (
        <div style={{
          border: `2px solid ${escaneado.status === 'active' ? 'var(--corsa-green)' : 'var(--color-danger-text)'}`,
          borderRadius: 8, padding: '14px 18px', marginBottom: 16,
          background: escaneado.status === 'active' ? 'rgba(2,53,48,0.05)' : 'var(--color-danger-bg, #FBE7E7)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
            Cupón escaneado
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'baseline', marginTop: 4, flexWrap: 'wrap' }}>
            <span className="font-mono" style={{ fontSize: 26, fontWeight: 900 }}>{escaneado.code}</span>
            <span style={{ fontSize: 15, fontWeight: 700 }}>
              {escaneado.status === 'active' ? 'VÁLIDO · sin usar' : escaneado.status === 'redeemed' ? `YA CANJEADO el ${fecha(escaneado.redeemed_at)}` : 'ANULADO'}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {escaneado.service_name} {escaneado.size} · {escaneado.includes_aspirado ? 'con aspirado' : 'sin aspirado'} · {escaneado.customer_name}
              {escaneado.is_gift && ' · Regalía'}
            </span>
          </div>
          <button className="btn btn-ghost" style={{ marginTop: 8 }}
                  onClick={() => { params.delete('v'); setParams(params) }}>
            Cerrar
          </button>
        </div>
      )}

      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        {[
          { label: 'Cupones', value: String(totales.total) },
          { label: 'Sin usar', value: String(totales.activos) },
          { label: 'Usados', value: String(totales.usados) },
          { label: 'Valor pendiente de canje', value: money(totales.valorActivo) },
          { label: 'Regalías', value: String(totales.regalias) },
        ].map(k => (
          <div key={k.label} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <div className="filter-pills">
          {ESTADOS.map(e => (
            <button key={e.id} className={`filter-pill${status === e.id ? ' active' : ''}`}
                    onClick={() => setStatus(e.id)}>{e.label}</button>
          ))}
        </div>
        <div className="filter-pills">
          {([['', 'Venta y regalía'], ['venta', 'Vendidos'], ['regalia', 'Regalías']] as const).map(([id, label]) => (
            <button key={id} className={`filter-pill${origen === id ? ' active' : ''}`}
                    onClick={() => setOrigen(id)}>{label}</button>
          ))}
        </div>
        <input type="date" className="corsa-input" style={{ width: 150 }} value={from}
               onChange={e => setFrom(e.target.value)} aria-label="Desde"/>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>a</span>
        <input type="date" className="corsa-input" style={{ width: 150 }} value={to}
               onChange={e => setTo(e.target.value)} aria-label="Hasta"/>
        <input className="corsa-input" style={{ flex: '1 1 200px', minWidth: 180 }}
               placeholder="Número de cupón o cliente…" value={search}
               onChange={e => setSearch(e.target.value)}/>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {loading ? (
          <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">Sin cupones en este filtro</div>
            <div className="empty-state-sub">Se emiten desde el POS Administrativo.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="corsa-table">
              <thead>
                <tr>
                  <th>Cupón</th><th>Correlativo</th><th>Cliente</th><th>Servicio</th>
                  <th>Estado</th><th>Emitido</th><th>Canjeado</th>
                  <th style={{ textAlign: 'right' }}>Valor</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}
                      style={{ cursor: 'default', background: r.validation_token === token ? 'var(--subtle-bg)' : undefined }}>
                    <td className="font-mono" style={{ fontSize: 13.5, fontWeight: 700 }}>{r.code}</td>
                    <td className="font-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {String(r.sequence_number).padStart(6, '0')}
                    </td>
                    <td style={{ fontSize: 13 }} className="truncate">
                      {r.customer_name}
                      {r.is_gift && <span className="badge badge-orange" style={{ marginLeft: 6 }}>Regalía</span>}
                    </td>
                    <td style={{ fontSize: 13 }}>
                      {r.service_name} {r.size}
                      {r.includes_aspirado && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>+ aspirado</span>}
                    </td>
                    <td>
                      <span className={`badge ${r.status === 'active' ? 'badge-success' : r.status === 'redeemed' ? 'badge-neutral' : 'badge-danger'}`}>
                        {r.status === 'active' ? 'Sin usar' : r.status === 'redeemed' ? 'Usado' : 'Anulado'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{fecha(r.created_at)}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      {r.redeemed_at ? `${fecha(r.redeemed_at)}${r.redeemed_order_number ? ` · ${r.redeemed_order_number}` : ''}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {r.is_gift ? 'Regalía' : money(r.unit_value)}
                    </td>
                    <td>
                      <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => reimprimir(r.batch_id)}
                              title={`Reimprimir los ${r.batch_quantity} cupones de esta venta`}>
                        PDF del lote
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
