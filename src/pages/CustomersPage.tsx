import { useEffect, useState, useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { useEsMovil } from '../hooks/useEsMovil'
import { CustomerFormPanel } from '../components/CustomerFormPanel'
import { CargaMasivaClientes } from '../components/CargaMasivaClientes'
import { GruposEmpresarialesModal } from '../components/GruposEmpresarialesModal'
import { QrRegistroModal } from '../components/QrRegistroModal'
import { FichaCliente } from '../components/clientes/FichaCliente'
import { infoFiscalPendiente, requiereCcf } from '../lib/fiscal/receptor'
import {
  searchCustomers,
  type CustomerWithStats,
} from '../services/customers.service'

// ─── Types ──────────────────────────────────────────────────

type FilterType = 'todos' | 'frecuente' | 'riesgo' | 'nuevo' | 'corporativo'

interface Panel {
  type: 'view' | 'new' | 'edit'
  customerId?: string
}

// ─── Helpers ────────────────────────────────────────────────

function getDisplayName(c: CustomerWithStats): string {
  if (c.customer_type === 'individual') {
    return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()
  }
  return c.trade_name ?? c.legal_name ?? '—'
}

function getMembershipStyle(status?: string): { color: string; tint: string; label: string } {
  switch (status) {
    case 'active': return { color: 'var(--color-success-text)', tint: 'var(--color-success-tint)', label: 'Membresía activa' }
    case 'expiring': return { color: 'var(--color-warning-text)', tint: 'var(--color-warning-tint)', label: 'Por vencer' }
    default: return { color: 'var(--text-secondary)', tint: 'var(--subtle-bg)', label: 'Sin membresía' }
  }
}

function classifySegment(c: CustomerWithStats): FilterType {
  if (c.customer_type === 'company') return 'corporativo'
  const days = c.last_visit_days ?? 999
  if (days > 45) return 'riesgo'
  if (days <= 7) return 'frecuente'
  return 'nuevo'
}

// ─── Main Customers Page ─────────────────────────────────────

const FILTER_DEFS: { id: FilterType; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'frecuente', label: 'Frecuentes' },
  { id: 'riesgo', label: 'En riesgo de fuga' },
  { id: 'nuevo', label: 'Nuevos' },
  { id: 'corporativo', label: 'Corporativos' },
]

export function CustomersPage() {
  const { profile, hasPermission, currentBranch } = useAuth()
  const orgId = (profile as any)?.organization_id ?? ''
  const [cargaMasiva, setCargaMasiva] = useState(false)
  const [grupos, setGrupos] = useState(false)
  const [qrRegistro, setQrRegistro] = useState(false)

  const [customers, setCustomers] = useState<CustomerWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterType>('todos')
  const [panel, setPanel] = useState<Panel | null>({ type: 'view', customerId: undefined })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadCustomers = useCallback(async (q: string) => {
    setLoading(true)
    try {
      const data = await searchCustomers(q)
      setCustomers(data)
    } catch { toast.error('Error al cargar clientes') }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => loadCustomers(search), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search, loadCustomers])

  // Filter clients
  const filtered = customers.filter(c => {
    if (filter === 'todos') return true
    return classifySegment(c) === filter
  })

  const selectedCustomer = panel?.customerId
    ? customers.find(c => c.id === panel.customerId) ?? null
    : null

  const totalVehicles = customers.reduce((s, c) => s + (c.vehicle_count ?? 0), 0)
  const esMovil = useEsMovil()
  const cuenta = (f: FilterType) => customers.filter(c => classifySegment(c) === f).length
  const fiscalPendiente = customers.filter(c => infoFiscalPendiente(c).length > 0).length

  return (
    <div className="page-inner ventas-page">
      {/* Header */}
      <div className="ventas-head">
        <div>
          <h1 style={{ display: 'inline' }}>Clientes</h1>
          <span className="sub">{customers.length} clientes · {totalVehicles} vehículos registrados</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {currentBranch?.code && (
            <button id="btn-qr-registro" className="btn btn-ghost btn-sm" onClick={() => setQrRegistro(true)}>
              QR de registro
            </button>
          )}
          <button id="btn-grupos" className="btn btn-ghost btn-sm" onClick={() => setGrupos(true)}>
            Grupos empresariales
          </button>
          {hasPermission('customers.create') && !esMovil && (
            <button id="btn-carga-masiva" className="btn btn-ghost btn-sm" onClick={() => setCargaMasiva(true)}>
              Carga masiva
            </button>
          )}
          <button id="btn-new-customer" className="btn btn-primary btn-sm" onClick={() => setPanel({ type: 'new' })}>
            + Nuevo cliente
          </button>
        </div>
      </div>

      {/* Indicadores: una franja que además filtra */}
      <div className="ventas-kpis">
        {([
          ['todos', 'Clientes', customers.length],
          ['corporativo', 'Corporativos', cuenta('corporativo')],
          ['frecuente', 'Frecuentes', cuenta('frecuente')],
          ['nuevo', 'Nuevos', cuenta('nuevo')],
          ['riesgo', 'En riesgo de fuga', cuenta('riesgo')],
          [null, 'Vehículos', totalVehicles],
          [null, 'Info fiscal pendiente', fiscalPendiente],
        ] as [FilterType | null, string, number][]).map(([f, l, v]) => (
          <div key={l} className={`ventas-kpi${f ? ' clic' : ''}${f && filter === f ? ' activo' : ''}`}
               onClick={f ? () => setFilter(f) : undefined} title={f ? `Ver ${l.toLowerCase()}` : l}>
            <div className="l">{l}</div>
            <div className="v" style={l === 'Info fiscal pendiente' && v > 0 ? { color: 'var(--color-danger-text)' } : undefined}>{v}</div>
          </div>
        ))}
      </div>

      {qrRegistro && currentBranch?.code && (
        <QrRegistroModal branchCode={currentBranch.code} branchName={currentBranch.name}
                         onCerrar={() => setQrRegistro(false)}/>
      )}

      {grupos && orgId && (
        <GruposEmpresarialesModal orgId={orgId} onCerrar={() => setGrupos(false)}
                                  onCambio={() => loadCustomers(search)}/>
      )}

      {cargaMasiva && orgId && (
        <CargaMasivaClientes
          orgId={orgId}
          onCerrar={() => setCargaMasiva(false)}
          onImportado={() => loadCustomers(search)}
        />
      )}

      {/* Filtros + búsqueda, en una fila */}
      <div className="ventas-filtros">
        <div className="filter-pills">
          {FILTER_DEFS.map(f => (
            <button
              key={f.id}
              id={`filter-${f.id}`}
              className={`filter-pill${filter === f.id ? ' active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          id="customer-search"
          type="search"
          className="corsa-input"
          style={{ flex: '1 1 220px', minWidth: esMovil ? 0 : 200 }}
          placeholder="Buscar por nombre, placa o DUI…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Buscar clientes"
        />
      </div>

      {/* Content */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        {/* Table */}
        {/* En el teléfono la lista y el detalle no conviven: abrir un cliente
            y tener que pasar cien fichas para llegar a la suya es peor que no
            abrirlo. El panel reemplaza a la lista y se vuelve con su ✕. */}
        {(!esMovil || !panel) && (
        <div style={{ flex: '2 1 560px', minWidth: esMovil ? 0 : 480, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>

          {loading ? (
            <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">{search ? 'No encontramos clientes con esos datos' : 'Sin clientes registrados'}</div>
              <div className="empty-state-sub">{search ? 'Probá con el nombre completo, el DUI o la placa del vehículo.' : ''}</div>
            </div>
          ) : (
            esMovil ? (
              /* En el teléfono cada cliente es una tarjeta que se toca entera.
                 Las seis columnas de la tabla no entran en 390 px, y las que
                 importan al buscar un cliente son tres: quién es, cuántos
                 vehículos tiene y cuándo vino por última vez. */
              filtered.map(c => {
                const ms = getMembershipStyle(c.membership_status)
                const segment = classifySegment(c)
                const segLabels: Partial<Record<FilterType, string>> = { frecuente: 'Cliente frecuente', riesgo: 'En riesgo de fuga', nuevo: 'Cliente nuevo', corporativo: 'Cuenta corporativa' }
                return (
                  <button
                    key={c.id}
                    onClick={() => setPanel({ type: 'view', customerId: c.id })}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '12px 14px', border: 'none',
                      borderBottom: '1px solid var(--border)',
                      background: panel?.customerId === c.id ? 'var(--subtle-bg)' : 'transparent',
                      cursor: 'pointer', fontFamily: 'var(--font-body)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }} className="truncate">
                        {getDisplayName(c)}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {c.vehicle_count ?? 0} {c.vehicle_count === 1 ? 'vehículo' : 'vehículos'}
                      </span>
                    </div>

                    <div style={{ marginTop: 3, fontSize: 12, color: 'var(--text-secondary)' }} className="truncate">
                      {c.phone ?? c.email ?? '—'}
                    </div>

                    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: ms.color, background: ms.tint, padding: '3px 8px', borderRadius: 4 }}>
                        {c.membership_plan ? `${c.membership_plan} · ${ms.label}` : ms.label}
                      </span>
                      {requiereCcf(c) && <span className="badge badge-green">CCF</span>}
                      {infoFiscalPendiente(c).length > 0 && <span className="pendiente-fiscal">Información fiscal pendiente</span>}
                      <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                        {segLabels[segment] ?? segment}
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-secondary)' }}>
                        {c.last_visit_days != null
                          ? c.last_visit_days === 0 ? 'Hoy' : c.last_visit_days === 1 ? 'Ayer' : `Hace ${c.last_visit_days} d`
                          : '—'}
                      </span>
                    </div>
                  </button>
                )
              })
            ) : (
            <div className="table-wrap">
            <table className="corsa-table ventas-tabla clientes-tabla" style={{ border: 'none' }}>
              <thead>
                <tr>
                  <th>Cliente</th><th>Tipo</th><th>Correo</th><th>Teléfono</th><th>Doc.</th>
                  <th style={{ textAlign: 'right' }}>Vehíc.</th><th>Última visita</th><th>Membresía</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const name = getDisplayName(c)
                  const ms = getMembershipStyle(c.membership_status)
                  const isSelected = panel?.customerId === c.id
                  const segment = classifySegment(c)
                  const segLabels: Partial<Record<FilterType, string>> = { frecuente: 'Frecuente', riesgo: 'Riesgo de fuga', nuevo: 'Nuevo', corporativo: 'Corporativo' }
                  const pendiente = infoFiscalPendiente(c)

                  return (
                    <tr
                      key={c.id}
                      className={isSelected ? 'selected' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setPanel({ type: 'view', customerId: c.id })}
                    >
                      <td className="cliente" title={name} style={{ fontWeight: 600, maxWidth: 240 }}>
                        {name}
                        {pendiente.length > 0 && (
                          <span className="pendiente-fiscal" style={{ marginLeft: 6, fontSize: 10 }}
                                title={`Falta: ${pendiente.join(', ')}`}>Fiscal pendiente</span>
                        )}
                      </td>
                      <td style={{ color: segment === 'riesgo' ? 'var(--color-warning-text)' : 'var(--text-secondary)' }}>
                        {segLabels[segment] ?? segment}
                      </td>
                      <td className="cliente" title={c.email ?? ''} style={{ maxWidth: 230 }}>{c.email ?? '—'}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{c.phone ?? '—'}</td>
                      <td>
                        <span className={`badge ${requiereCcf(c) ? 'badge-green' : 'badge-neutral'}`}>
                          {requiereCcf(c) ? 'CCF' : 'CF'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{c.vehicle_count ?? 0}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>
                        {c.last_visit_days != null
                          ? c.last_visit_days === 0 ? 'Hoy' : c.last_visit_days === 1 ? 'Ayer' : `Hace ${c.last_visit_days} d`
                          : '—'}
                      </td>
                      <td style={{ color: ms.color, fontWeight: 600 }}>
                        {c.membership_status === 'active' || c.membership_status === 'expiring'
                          ? (c.membership_plan ? `${c.membership_plan} · ${ms.label}` : ms.label)
                          : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
            )
          )}
        </div>
        )}

        {/* Side panel */}
        {panel && (
          panel.type === 'view' && selectedCustomer ? (
            <FichaCliente
              customer={selectedCustomer}
              orgId={orgId}
              onCerrar={() => setPanel(null)}
              onActualizado={() => loadCustomers(search)}
            />
          ) : panel.type === 'new' || (panel.type === 'edit' && selectedCustomer) ? (
            <CustomerFormPanel
              customer={panel.type === 'edit' ? selectedCustomer ?? undefined : undefined}
              orgId={orgId}
              onClose={() => setPanel(null)}
              onSaved={id => {
                setPanel({ type: 'view', customerId: id })
                loadCustomers(search)
              }}
            />
          ) : null
        )}
      </div>
    </div>
  )
}
