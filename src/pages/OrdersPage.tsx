/**
 * CORSA Carwash — Órdenes del turno
 * Lista de órdenes activas e historial del día con realtime.
 */

import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import type { WorkOrder, WorkOrderStatus } from '../types'

// ─── Constants ───────────────────────────────────────────────

const STATUS_LABELS: Record<WorkOrderStatus, string> = {
  received: 'Recibido',
  waiting: 'En espera',
  washing: 'En máquina',
  drying_detailing: 'Secado y detalle',
  quality_control: 'Control calidad',
  ready: 'Listo',
  paid: 'Pagado',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
}

const STATUS_STYLE: Record<WorkOrderStatus, { color: string; tint: string }> = {
  received:         { color: 'var(--text-secondary)', tint: 'var(--subtle-bg)' },
  waiting:          { color: 'var(--color-warning-text)', tint: 'var(--color-warning-tint)' },
  washing:          { color: 'var(--color-success-text)', tint: 'var(--color-success-tint)' },
  drying_detailing: { color: 'var(--color-warning-text)', tint: 'var(--color-warning-tint)' },
  quality_control:  { color: 'var(--text-secondary)', tint: 'var(--subtle-bg)' },
  ready:            { color: '#157A52', tint: '#C6F0DE' },
  paid:             { color: 'var(--color-success-text)', tint: 'var(--color-success-tint)' },
  delivered:        { color: 'var(--text-secondary)', tint: 'var(--subtle-bg)' },
  cancelled:        { color: 'var(--color-danger-text)', tint: 'var(--color-danger-tint)' },
}

const FILTER_DEFS = [
  { value: 'active', label: 'Activas' },
  { value: 'all', label: 'Todo el día' },
  { value: 'ready', label: 'Listos' },
  { value: 'delivered', label: 'Entregados' },
  { value: 'cancelled', label: 'Cancelados' },
]

// ─── Helpers ─────────────────────────────────────────────────

function minutesSince(isoString: string): number {
  return Math.floor((Date.now() - new Date(isoString).getTime()) / 60000)
}

function timeSince(isoString: string): string {
  const m = minutesSince(isoString)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}min`
}

function isOverdue(order: any): boolean {
  if (['delivered', 'cancelled', 'paid'].includes(order.status)) return false
  return minutesSince(order.created_at) > 60
}

// ─── Main Component ──────────────────────────────────────────

export function OrdersPage() {
  const { currentBranch, hasPermission } = useAuth()
  const [orders, setOrders] = useState<WorkOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('active')

  const loadOrders = useCallback(async () => {
    if (!currentBranch) { setLoading(false); return }
    setLoading(true)
    setError(null)

    const today = new Date().toISOString().split('T')[0]

    let query = (supabase as any)
      .from('work_orders')
      .select('*')
      .eq('branch_id', currentBranch.id)
      .gte('created_at', `${today}T00:00:00`)
      .order('created_at', { ascending: false })
      .limit(100)

    if (filterStatus === 'active') {
      query = query.not('status', 'in', '("delivered","cancelled")')
    } else if (filterStatus !== 'all') {
      query = query.eq('status', filterStatus)
    }

    const { data, error: qErr } = await query
    if (qErr) {
      setError('Error al cargar órdenes')
    } else {
      setOrders((data ?? []) as WorkOrder[])
    }
    setLoading(false)
  }, [currentBranch, filterStatus])

  useEffect(() => { loadOrders() }, [loadOrders])

  // Realtime
  useEffect(() => {
    if (!currentBranch) return
    const channel = supabase
      .channel(`orders:${currentBranch.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'work_orders',
        filter: `branch_id=eq.${currentBranch.id}`,
      }, () => { loadOrders() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [currentBranch, loadOrders])

  if (!hasPermission('orders.read')) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">Sin acceso</div>
          <div className="empty-state-sub">No tienes permiso para ver las órdenes de trabajo.</div>
        </div>
      </div>
    )
  }

  // Counts
  const activeCount = orders.filter(o => !['delivered','cancelled'].includes(o.status)).length
  const overdueCount = orders.filter(isOverdue).length

  return (
    <div className="page-inner">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 26, color: 'var(--text-primary)' }}>
            Órdenes del turno
          </h1>
          <div className="page-header-sub">
            {activeCount} activa{activeCount !== 1 ? 's' : ''}
            {overdueCount > 0 && (
              <span style={{ color: 'var(--color-danger-text)', marginLeft: 8 }}>
                · {overdueCount} con tiempo excedido
              </span>
            )}
          </div>
        </div>
        {hasPermission('orders.create') && (
          <Link to="/pos" style={{ textDecoration: 'none' }}>
            <div className="clip-btn-wrap">
              <div className="clip-btn-corner"/>
              <button id="btn-new-order" className="clip-btn">+ Nueva orden</button>
            </div>
          </Link>
        )}
      </div>

      {/* Filters */}
      <div className="filter-pills">
        {FILTER_DEFS.map(f => (
          <button
            key={f.value}
            id={`filter-${f.value}`}
            className={`filter-pill${filterStatus === f.value ? ' active' : ''}`}
            onClick={() => setFilterStatus(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="alert-banner danger">
          <div className="alert-body"><div className="alert-title">{error}</div></div>
        </div>
      )}

      {/* Content */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}>
        {/* Table header */}
        <div style={{ display: 'flex', padding: '10px 20px', borderBottom: '1px solid var(--border)', fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
          <div style={{ width: 120, flexShrink: 0 }}>Orden</div>
          <div style={{ width: 130, flexShrink: 0 }}>Estado</div>
          <div style={{ flex: 1 }}>Tiempo en turno</div>
          <div style={{ width: 100, flexShrink: 0 }}>Pago</div>
          <div style={{ width: 100, flexShrink: 0, textAlign: 'right' }}>Total</div>
        </div>

        {loading ? (
          <div className="loading-center"><div className="spinner"/><span>Cargando órdenes…</span></div>
        ) : orders.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">No hay órdenes en este turno</div>
            <div className="empty-state-sub">Las órdenes creadas hoy aparecerán aquí en tiempo real.</div>
          </div>
        ) : (
          orders.map(o => {
            const ss = STATUS_STYLE[o.status] ?? STATUS_STYLE.received
            const overdue = isOverdue(o)
            const elapsed = timeSince(o.created_at)
            return (
              <div
                key={o.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '13px 20px',
                  borderBottom: '1px solid var(--border)',
                  background: overdue ? 'rgba(226,75,75,0.04)' : 'transparent',
                  transition: 'background 0.1s',
                  cursor: 'default',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--subtle-bg)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = overdue ? 'rgba(226,75,75,0.04)' : 'transparent' }}
              >
                {/* Order number */}
                <div style={{ width: 120, flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-heading)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
                    {o.order_number}
                  </div>
                  {overdue && (
                    <div style={{ fontSize: 11, color: 'var(--color-danger-text)', fontWeight: 600, marginTop: 2 }}>
                      ⚠ Tiempo excedido
                    </div>
                  )}
                </div>

                {/* Status */}
                <div style={{ width: 130, flexShrink: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: ss.color, background: ss.tint, padding: '3px 8px', borderRadius: 4, display: 'inline-block' }}>
                    {STATUS_LABELS[o.status]}
                  </span>
                </div>

                {/* Time */}
                <div style={{ flex: 1, fontSize: 13, color: overdue ? 'var(--color-danger-text)' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                  {elapsed}
                  {o.started_at && (
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
                      {' · inició hace '}{timeSince(o.started_at)}
                    </span>
                  )}
                </div>

                {/* Payment */}
                <div style={{ width: 100, flexShrink: 0 }}>
                  <span style={{
                    fontSize: 12, fontWeight: 600,
                    color: o.payment_status === 'paid' ? 'var(--color-success-text)' : 'var(--text-secondary)',
                    background: o.payment_status === 'paid' ? 'var(--color-success-tint)' : 'var(--subtle-bg)',
                    padding: '3px 8px', borderRadius: 4, display: 'inline-block',
                  }}>
                    {o.payment_status === 'paid' ? 'Pagado' : o.payment_status === 'partial' ? 'Parcial' : 'Pendiente'}
                  </span>
                </div>

                {/* Total */}
                <div style={{ width: 100, flexShrink: 0, textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
                  US${o.total.toFixed(2)}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
