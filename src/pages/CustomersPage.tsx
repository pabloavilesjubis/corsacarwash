import { useEffect, useState, useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { ClipButton } from '../components/ui/ClipButton'
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

  return (
    <div className="page-inner">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>Clientes</h1>
          <div className="page-header-sub">
            {customers.length} clientes · {totalVehicles} vehículos registrados
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {currentBranch?.code && (
            <button id="btn-qr-registro" className="btn btn-ghost" onClick={() => setQrRegistro(true)}>
              QR de registro
            </button>
          )}
          <button id="btn-grupos" className="btn btn-ghost" onClick={() => setGrupos(true)}>
            Grupos empresariales
          </button>
          {hasPermission('customers.create') && !esMovil && (
            <button id="btn-carga-masiva" className="btn btn-ghost" onClick={() => setCargaMasiva(true)}>
              Carga masiva
            </button>
          )}
          <ClipButton
            id="btn-new-customer"
            label="+ Nuevo cliente"
            onClick={() => setPanel({ type: 'new' })}
          />
        </div>
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

      {/* Filters + Search */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
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
        <div className="search-bar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            id="customer-search"
            type="search"
            placeholder="Buscar por nombre, placa o DUI"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Buscar clientes"
          />
        </div>
      </div>

      {/* Content */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        {/* Table */}
        {/* En el teléfono la lista y el detalle no conviven: abrir un cliente
            y tener que pasar cien fichas para llegar a la suya es peor que no
            abrirlo. El panel reemplaza a la lista y se vuelve con su ✕. */}
        {(!esMovil || !panel) && (
        <div style={{ flex: '2 1 560px', minWidth: esMovil ? 0 : 480, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {/* Table header — en el teléfono no hay columnas que encabezar */}
          <div style={{ display: esMovil ? 'none' : 'flex', padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
            <div style={{ flex: 2.2 }}>Cliente</div>
            <div style={{ flex: 1.6 }}>Contacto</div>
            <div style={{ flex: 1 }}>Documento</div>
            <div style={{ flex: 0.8, textAlign: 'center' }}>Vehículos</div>
            <div style={{ flex: 1 }}>Última visita</div>
            <div style={{ flex: 1.3 }}>Membresía</div>
          </div>

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
            <table className="corsa-table" style={{ border: 'none' }}>
              <tbody>
                {filtered.map(c => {
                  const name = getDisplayName(c)
                  const ms = getMembershipStyle(c.membership_status)
                  const isSelected = panel?.customerId === c.id
                  const segment = classifySegment(c)
                  const segLabels: Partial<Record<FilterType, string>> = { frecuente: 'Cliente frecuente', riesgo: 'En riesgo de fuga', nuevo: 'Cliente nuevo', corporativo: 'Cuenta corporativa' }
                  const segLabel = segLabels[segment] ?? segment

                  return (
                    <tr
                      key={c.id}
                      className={isSelected ? 'selected' : ''}
                      onClick={() => setPanel({ type: 'view', customerId: c.id })}
                    >
                      <td style={{ flex: undefined, width: undefined }}>
                        <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 200 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }} className="truncate">{name}</div>
                          {infoFiscalPendiente(c).length > 0
                            ? <span className="pendiente-fiscal" style={{ marginTop: 3, alignSelf: 'flex-start' }}
                                    title={`Falta: ${infoFiscalPendiente(c).join(', ')}`}>Información fiscal pendiente</span>
                            : <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{segLabel}</div>}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }} className="truncate">{c.email ?? '—'}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.phone ?? '—'}</div>
                      </td>
                      <td>
                        <span className={`badge ${requiereCcf(c) ? 'badge-green' : 'badge-neutral'}`}>
                          {requiereCcf(c) ? 'CCF' : 'Consumidor final'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center', fontSize: 13, fontWeight: 600 }}>
                        {c.vehicle_count ?? 0}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                        {c.last_visit_days != null
                          ? c.last_visit_days === 0 ? 'Hoy' : c.last_visit_days === 1 ? 'Hace 1 día' : `Hace ${c.last_visit_days} días`
                          : '—'}
                      </td>
                      <td>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: ms.color, background: ms.tint, padding: '3px 8px', borderRadius: 4 }}>
                          {c.membership_plan ? `${c.membership_plan} · ${ms.label}` : ms.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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
