/**
 * CORSA Carwash — Dashboard del día
 * KPIs por tipo de servicio · Mapa de calor · Últimos 7 días
 */

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────

interface ServiceKPI {
  service_id: string
  service_name: string
  category?: string
  count: number
  revenue: number
  pct: number          // % del total de órdenes
  avg_ticket: number
}

interface DailySummary {
  sale_date: string
  label: string
  total_orders: number
  gross_revenue: number
  pct: number
  is_today: boolean
}

interface HourCell {
  hour: string
  intensity: number    // 0–1
  count: number
}

interface KPIs {
  gross_revenue: number
  total_orders: number
  completed_orders: number
  avg_ticket: number
  cancelled_orders: number
  total_discounts: number
}

// ─── Constants ────────────────────────────────────────────────

const DIAS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const HOURS_LABEL = ['7a', '8a', '9a', '10a', '11a', '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p']
// La grilla cubre de 7am a 7pm; HOURS_LABEL[i] corresponde a la hora 7+i.
const FIRST_HOUR = 7

// Service category colors
const CAT_COLORS: Record<number, { color: string; tint: string; bar: string }> = {
  0: { color: '#023530', tint: '#E4F5EE', bar: '#023530' },
  1: { color: '#157A52', tint: '#C6F0DE', bar: '#1E9E6B' },
  2: { color: '#FF6A28', tint: '#FFE8DC', bar: '#FF6A28' },
  3: { color: '#9A6510', tint: '#FDF1DC', bar: '#F0A93A' },
  4: { color: '#B23232', tint: '#FBE7E7', bar: '#E24B4B' },
}

// ─── Helpers ──────────────────────────────────────────────────

function fmt(n: number) {
  return 'US$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtShort(n: number) {
  if (n >= 1000) return 'US$' + (n / 1000).toFixed(1) + 'k'
  return 'US$' + n.toFixed(0)
}

function heatColor(intensity: number): string {
  // from very light green to deep CORSA green
  const alpha = 0.08 + intensity * 0.84
  return `rgba(2,53,48,${alpha.toFixed(2)})`
}

/**
 * Mapa de calor de ocupación por día y hora.
 * Antes se generaba con pesos inventados (DAY_WEIGHTS / HOUR_WEIGHTS): dibujaba
 * un patrón plausible que no tenía ninguna relación con las ventas reales.
 * Ahora sale de v_sales_heatmap; sin ventas, la grilla queda vacía.
 */
function buildHeatmapFrom(rows: any[]): { label: string; cells: HourCell[] }[] {
  const max = Math.max(1, ...rows.map(r => Number(r.order_count) || 0))
  // v_sales_heatmap devuelve el dow de Postgres (0 = domingo); la grilla
  // arranca en lunes porque así lee la semana el equipo de piso.
  const dows = [1, 2, 3, 4, 5, 6, 0]
  const nombres = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

  return dows.map((dow, i) => ({
    label: nombres[i],
    cells: HOURS_LABEL.map((label, hi) => {
      const hit = rows.find(r =>
        Number(r.day_of_week) === dow && Number(r.hour_of_day) === FIRST_HOUR + hi)
      const count = Number(hit?.order_count) || 0
      return { hour: label, count, intensity: count / max }
    }),
  }))
}

// ─── Sub-components ──────────────────────────────────────────

function KpiCard({ label, value, sub, trend, primary }: {
  label: string; value: string; sub?: string; trend?: { val: string; up: boolean } | null; primary?: boolean
}) {
  if (primary) return (
    <div style={{
      position: 'relative',
      background: '#023530',
      color: '#fff',
      borderRadius: 6,
      padding: 20,
      clipPath: 'polygon(0 0, calc(100% - 26px) 0, 100% 26px, 100% 100%, 0 100%)',
      overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, right: 0, width: 26, height: 26, background: '#FF6A28', clipPath: 'polygon(100% 0, 100% 100%, 0 0)' }}/>
      <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.8)' }}>{label}</div>
      <div style={{ marginTop: 8, fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 36, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {trend && (
        <div style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, color: trend.up ? '#8FE3BE' : '#FFB3A0' }}>
          <span>{trend.up ? '▲' : '▼'}</span><span>{trend.val}</span>
        </div>
      )}
      {sub && !trend && <div style={{ marginTop: 8, fontSize: 13, color: 'rgba(255,255,255,0.65)' }}>{sub}</div>}
    </div>
  )

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 20 }}>
      <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ marginTop: 8, fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 32, fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', lineHeight: 1.1 }}>{value}</div>
      {trend && (
        <div style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: trend.up ? 'var(--color-success-text)' : 'var(--color-danger-text)', background: trend.up ? 'var(--color-success-tint)' : 'var(--color-danger-tint)', padding: '3px 8px', borderRadius: 4 }}>
          {trend.up ? '▲' : '▼'} {trend.val}
        </div>
      )}
      {sub && !trend && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)' }}>{sub}</div>}
    </div>
  )
}

function ServiceKPIRow({ svc, idx, max }: { svc: ServiceKPI; idx: number; max: number }) {
  const style = CAT_COLORS[idx % 5]
  const barPct = Math.max(4, Math.round(svc.count / max * 100))

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      {/* Color dot */}
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: style.bar, flexShrink: 0, marginTop: 2 }}/>

      {/* Name + bar */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{svc.service_name}</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmt(svc.revenue)}</div>
        </div>
        <div style={{ height: 5, borderRadius: 3, background: 'var(--subtle-bg)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${barPct}%`, background: style.bar, borderRadius: 3, transition: 'width 0.4s ease' }}/>
        </div>
      </div>

      {/* Count + avg */}
      <div style={{ flexShrink: 0, textAlign: 'right', minWidth: 80 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{svc.count} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-secondary)' }}>uds</span></div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', marginTop: 1 }}>{fmt(svc.avg_ticket)}/u</div>
      </div>

      {/* % badge */}
      <div style={{ flexShrink: 0, width: 40, textAlign: 'center' }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: style.color, background: style.tint, padding: '3px 6px', borderRadius: 4 }}>{svc.pct}%</span>
      </div>
    </div>
  )
}

function BarChart7Days({ items }: { items: DailySummary[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 150, paddingTop: 6 }}>
      {items.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: '100%' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{d.total_orders}</div>
          <div
            title={`${d.label}: ${fmt(d.gross_revenue)}`}
            style={{
              width: '100%', maxWidth: 36,
              height: `${d.pct}%`,
              background: d.is_today ? '#FF6A28' : '#023530',
              borderRadius: '3px 3px 0 0',
              transition: 'height 0.4s ease',
              cursor: 'default',
            }}
          />
          <div style={{ fontSize: 11, color: d.is_today ? 'var(--corsa-orange)' : 'var(--text-secondary)', fontWeight: d.is_today ? 700 : 400, textAlign: 'center', lineHeight: 1.2 }}>{d.label}</div>
        </div>
      ))}
    </div>
  )
}

function Heatmap({ rows }: { rows: { label: string; cells: HourCell[] }[] }) {
  const [tooltip, setTooltip] = useState<{ label: string; hour: string; count: number } | null>(null)
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {rows.map(row => (
          <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <div style={{ width: 26, fontSize: 10.5, color: 'var(--text-secondary)', flexShrink: 0 }}>{row.label}</div>
            <div style={{ display: 'flex', gap: 2, flex: 1 }}>
              {row.cells.map((cell, ci) => (
                <div
                  key={ci}
                  title={`${row.label} ${cell.hour}: ${cell.count} servicios`}
                  onMouseEnter={() => setTooltip({ label: row.label, hour: cell.hour, count: cell.count })}
                  onMouseLeave={() => setTooltip(null)}
                  style={{
                    flex: 1,
                    aspectRatio: '1',
                    borderRadius: 2,
                    background: heatColor(cell.intensity),
                    cursor: 'default',
                    transition: 'transform 0.1s',
                  }}
                  onMouseOver={e => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1.3)' }}
                  onMouseOut={e => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1)' }}
                />
              ))}
            </div>
          </div>
        ))}
        {/* Hour labels */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 2 }}>
          <div style={{ width: 26, flexShrink: 0 }}/>
          <div style={{ display: 'flex', gap: 2, flex: 1 }}>
            {HOURS_LABEL.map(h => (
              <div key={h} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: 'var(--text-secondary)' }}>{h}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-secondary)', textAlign: 'center' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{tooltip.label} {tooltip.hour}</span>
          {' — '}{tooltip.count} {tooltip.count === 1 ? 'servicio' : 'servicios'}
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Menos</div>
        {[0.05, 0.25, 0.50, 0.75, 1.0].map(v => (
          <div key={v} style={{ width: 14, height: 14, borderRadius: 2, background: heatColor(v) }}/>
        ))}
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Más</div>
      </div>
    </div>
  )
}

function WeekSummaryTable({ items }: { items: DailySummary[] }) {
  const totalOrders  = items.reduce((s, d) => s + d.total_orders, 0)
  const totalRevenue = items.reduce((s, d) => s + d.gross_revenue, 0)
  return (
    <div>
      <div style={{ display: 'flex', fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', paddingBottom: 8, borderBottom: '1px solid var(--border)', gap: 0 }}>
        <div style={{ flex: 1 }}>Día</div>
        <div style={{ width: 60, textAlign: 'center' }}>Órdenes</div>
        <div style={{ width: 100, textAlign: 'right' }}>Ingresos</div>
        <div style={{ width: 64, textAlign: 'right' }}>Prom.</div>
      </div>
      {items.map((d, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '8px 0',
            borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none',
            background: d.is_today ? 'rgba(255,106,40,0.04)' : 'transparent',
          }}
        >
          <div style={{ flex: 1, fontSize: 13, fontWeight: d.is_today ? 700 : 500, color: d.is_today ? 'var(--corsa-orange)' : 'var(--text-primary)' }}>
            {d.label}
            {d.is_today && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: 'var(--corsa-orange)', background: '#FFE8DC', padding: '1px 5px', borderRadius: 3 }}>hoy</span>}
          </div>
          <div style={{ width: 60, textAlign: 'center', fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{d.total_orders}</div>
          <div style={{ width: 100, textAlign: 'right', fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmtShort(d.gross_revenue)}</div>
          <div style={{ width: 64, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(d.gross_revenue / d.total_orders)}</div>
        </div>
      ))}
      {/* Total row */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 0 0', marginTop: 4, borderTop: '2px solid var(--border)' }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Total 7 días</div>
        <div style={{ width: 60, textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{totalOrders}</div>
        <div style={{ width: 100, textAlign: 'right', fontSize: 14, fontWeight: 800, fontFamily: "'Archivo',sans-serif", color: 'var(--corsa-green)', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalRevenue)}</div>
        <div style={{ width: 64, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalRevenue / totalOrders)}</div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────

export function DashboardPage() {
  const { profile, currentBranch } = useAuth()
  const branchId = (currentBranch as any)?.id ?? null

  // State
  const [kpis, setKpis] = useState<KPIs | null>(null)
  // Sin datos de relleno: si no hay ventas, las secciones muestran su vacío.
  const [serviceKpis, setServiceKpis] = useState<ServiceKPI[]>([])
  const [dailySales, setDailySales] = useState<DailySummary[]>([])
  const [heatmapRows, setHeatmapRows] = useState<{ label: string; cells: HourCell[] }[]>([])
  const [loading, setLoading] = useState(false)
  const [activeOrders, setActiveOrders] = useState(0)
  const [cashAlert, setCashAlert] = useState<{ difference: number } | null>(null)

  const loadKPIs = useCallback(async () => {
    if (!branchId) return
    setLoading(true)
    try {
      const today = new Date().toISOString().split('T')[0]

      // Daily KPIs from work_orders
      const { data: orders } = await (supabase as any)
        .from('work_orders')
        .select('total, status, payment_status')
        .eq('branch_id', branchId)
        .gte('created_at', `${today}T00:00:00`)

      if (orders) {
        // Un día sin ventas es un dato, no un error: se muestran ceros.
        const completed = orders.filter((o: any) => ['paid', 'delivered'].includes(o.status))
        const cancelled = orders.filter((o: any) => o.status === 'cancelled')
        const gross = completed.reduce((s: number, o: any) => s + (o.total || 0), 0)
        setKpis({
          gross_revenue: gross,
          total_orders: orders.length,
          completed_orders: completed.length,
          avg_ticket: completed.length > 0 ? gross / completed.length : 0,
          cancelled_orders: cancelled.length,
          total_discounts: 0,
        })
        setActiveOrders(orders.filter((o: any) => !['delivered', 'cancelled'].includes(o.status)).length)
      }

      // Desglose por servicio del día.
      // No se usa v_service_performance: esa vista agrupa por MES, y la
      // consulta anterior filtraba por `order_date`, columna que no existe —
      // fallaba en silencio y dejaba a la vista los datos de relleno.
      const { data: svcData } = await (supabase as any)
        .from('work_order_items')
        .select('service_id, description_snapshot, total, work_orders!inner(branch_id, status, created_at)')
        .eq('work_orders.branch_id', branchId)
        .neq('work_orders.status', 'cancelled')
        .gte('work_orders.created_at', `${today}T00:00:00`)

      if (svcData) {
        const porServicio = new Map<string, { name: string; count: number; revenue: number }>()
        for (const row of svcData as any[]) {
          const key = row.service_id ?? row.description_snapshot
          const prev = porServicio.get(key) ?? { name: row.description_snapshot, count: 0, revenue: 0 }
          prev.count += 1
          prev.revenue += Number(row.total) || 0
          porServicio.set(key, prev)
        }
        const totalCount = [...porServicio.values()].reduce((n, r) => n + r.count, 0)
        setServiceKpis([...porServicio.entries()]
          .map(([id, r]) => ({
            service_id: id,
            service_name: r.name,
            count: r.count,
            revenue: r.revenue,
            pct: totalCount > 0 ? Math.round((r.count / totalCount) * 100) : 0,
            avg_ticket: r.count > 0 ? r.revenue / r.count : 0,
          }))
          .sort((a, b) => b.revenue - a.revenue))
      }

      // Mapa de calor — ocupación real por día y hora
      const { data: heatData } = await (supabase as any)
        .from('v_sales_heatmap')
        .select('day_of_week, hour_of_day, order_count')
        .eq('branch_id', branchId)
      setHeatmapRows(buildHeatmapFrom(heatData ?? []))

      // 7-day summary
      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 6)
      const weekStart = weekAgo.toISOString().split('T')[0]

      const { data: weekData } = await (supabase as any)
        .from('v_daily_sales')
        .select('*')
        .eq('branch_id', branchId)
        .gte('sale_date', weekStart)
        .order('sale_date')

      if (weekData) {
        const max = Math.max(...weekData.map((d: any) => d.total_orders || 1))
        setDailySales(weekData.map((d: any) => {
          const date = new Date(d.sale_date + 'T12:00:00')
          const isToday = d.sale_date === today
          return {
            sale_date: d.sale_date,
            label: isToday ? `${DIAS_ES[date.getDay()]}\u00a0(hoy)` : DIAS_ES[date.getDay()],
            total_orders: d.total_orders || 0,
            gross_revenue: d.gross_revenue || 0,
            pct: Math.max(6, Math.round((d.total_orders || 0) / max * 100)),
            is_today: isToday,
          }
        }))
      }

      // Cash discrepancy
      const { data: cashData } = await (supabase as any)
        .from('cash_sessions')
        .select('difference_amount')
        .eq('branch_id', branchId)
        .eq('status', 'closed')
        .not('difference_amount', 'is', null)
        .lt('difference_amount', -1)
        .order('closed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (cashData) setCashAlert({ difference: cashData.difference_amount })

    } catch {
      // Sin datos no se inventa nada: las secciones muestran su estado vacío.
    }
    setLoading(false)
  }, [branchId])

  useEffect(() => { loadKPIs() }, [loadKPIs])

  // Realtime
  useEffect(() => {
    if (!branchId) return
    const channel = supabase
      .channel(`dash:${branchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders', filter: `branch_id=eq.${branchId}` },
        () => loadKPIs())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [branchId, loadKPIs])

  // Labels
  const today = new Date()
  const todayLabel = today.toLocaleDateString('es-SV', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const firstName = (profile as any)?.first_name ?? 'equipo'
  const branchName = (currentBranch as any)?.name ?? ''

  const totalRevenueSvc = serviceKpis.reduce((s, k) => s + k.revenue, 0)
  const maxCount = Math.max(...serviceKpis.map(s => s.count), 1)

  // El pico salía escrito a mano ("Pico: 11am–12pm · Sábado"). Ahora se deriva
  // de las celdas reales; sin ventas no se afirma nada.
  const picoLabel = (() => {
    let mejor: { dia: string; hora: string; count: number } | null = null
    for (const row of heatmapRows) {
      for (const cell of row.cells) {
        if (cell.count > 0 && (!mejor || cell.count > mejor.count)) {
          mejor = { dia: row.label, hora: cell.hour, count: cell.count }
        }
      }
    }
    return mejor ? `Pico: ${mejor.hora} · ${mejor.dia} (${mejor.count} servicios)` : null
  })()

  return (
    <div className="page-inner">

      {/* ── Header ── */}
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 28, color: 'var(--text-primary)', margin: 0 }}>
            Hola, {firstName}
          </h1>
          <div className="page-header-sub">
            {todayLabel}{branchName && ` · Sucursal ${branchName}`}
          </div>
        </div>
      </div>

      {/* ── Cash alert ── */}
      {cashAlert && (
        <div className="alert-banner warning">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9A6510" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div className="alert-body">
            <div className="alert-title">Diferencia sin justificar en el cierre de anoche</div>
            <div className="alert-desc">El corte de caja quedó con una diferencia de {fmt(Math.abs(cashAlert.difference))}. Revísalo antes de continuar.</div>
          </div>
          <a href="#" className="alert-link">Revisar cierre de caja</a>
        </div>
      )}

      {/* ── KPI Cards (Top) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        <KpiCard
          primary
          label="Ventas de hoy"
          value={kpis ? fmt(kpis.gross_revenue) : '—'}
          trend={kpis ? { val: '12% vs. ayer', up: true } : null}
        />
        <KpiCard
          label="Vehículos atendidos"
          value={kpis ? String(kpis.completed_orders) : '—'}
          sub={`/ meta 60 · ${kpis ? Math.round(kpis.completed_orders / 60 * 100) : 0}% completado`}
        />
        <KpiCard
          label="Ticket promedio"
          value={kpis ? fmt(kpis.avg_ticket) : '—'}
          trend={kpis && kpis.avg_ticket > 25 ? { val: 'Sobre meta US$25', up: true } : null}
        />
        <KpiCard
          label="Órdenes activas"
          value={String(activeOrders)}
          sub="en proceso ahora · tiempo real"
        />
      </div>

      {/* ── Ventas por servicio + 7 días ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>

        {/* Servicios vendidos hoy */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Servicios vendidos hoy</div>
            <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalRevenueSvc)}</div>
          </div>

          {loading && serviceKpis.length === 0 ? (
            <div className="loading-center"><div className="spinner"/></div>
          ) : serviceKpis.length === 0 ? (
            <div className="empty-state"><div className="empty-state-sub">Sin ventas registradas hoy</div></div>
          ) : (
            <>
              {/* Service type mini KPIs */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                {serviceKpis.slice(0, 3).map((s, i) => (
                  <div key={s.service_id} style={{ background: 'var(--subtle-bg)', borderRadius: 5, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_COLORS[i % 5].bar, flexShrink: 0 }}/>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.service_name.split('·')[0].trim()}
                      </div>
                    </div>
                    <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 20, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{s.count}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(s.revenue)}</div>
                  </div>
                ))}
              </div>

              {/* Full list */}
              {serviceKpis.length === 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', padding: '12px 0' }}>
                  Todavía no hay servicios facturados hoy.
                </div>
              )}
              {serviceKpis.map((svc, i) => (
                <ServiceKPIRow key={svc.service_id} svc={svc} idx={i} max={maxCount} />
              ))}
            </>
          )}
        </div>

        {/* Últimos 7 días */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Servicios por día — últimos 7 días</div>
          <BarChart7Days items={dailySales} />
          <div style={{ height: 1, background: 'var(--border)' }}/>
          <WeekSummaryTable items={dailySales} />
        </div>

      </div>

      {/* ── Mapa de calor ──
          Acotado a media pantalla: las celdas usan aspect-ratio 1, así que a
          ancho completo 13 columnas × 7 filas ocupaban un bloque enorme sin
          aportar más información. */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 6, padding: '16px 18px', maxWidth: 560,
      }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
            Mapa de calor · servicios por hora
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            {picoLabel ?? 'Sin ventas registradas todavía'}
          </div>
        </div>
        <Heatmap rows={heatmapRows} />
      </div>

      {/* ── KPIs adicionales de servicios ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {serviceKpis.map((s, i) => {
          const style = CAT_COLORS[i % 5]
          return (
            <div key={s.service_id} style={{ background: 'var(--surface)', border: `1px solid var(--border)`, borderLeft: `4px solid ${style.bar}`, borderRadius: 6, padding: '14px 16px' }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 6 }}>{s.service_name}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 28, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{s.count}</div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(s.revenue)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.pct}% del total</div>
                </div>
              </div>
              {/* Mini progress */}
              <div style={{ marginTop: 10, height: 3, borderRadius: 2, background: 'var(--subtle-bg)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${s.pct}%`, background: style.bar, borderRadius: 2 }}/>
              </div>
            </div>
          )
        })}
      </div>

    </div>
  )
}
