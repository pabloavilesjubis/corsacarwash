import { useEffect, useState, useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { ClipButton } from '../components/ui/ClipButton'
import { CustomerFormPanel } from '../components/CustomerFormPanel'
import {
  searchCustomers,
  getCustomerVehicles,
  getCustomerMetrics,
  getMembershipPlans,
  updateCustomer,
  checkPlateConflict,
  addVehicleToCustomer,
  transferVehicleOwnership,
  type CustomerWithStats,
} from '../services/customers.service'
import type { Vehicle } from '../types'

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

// ─── Side Panel ─────────────────────────────────────────────

function ViewPanel({
  customer,
  onClose,
  onUpdated,
  onEdit,
  orgId,
}: {
  customer: CustomerWithStats
  onClose: () => void
  onUpdated: () => void
  onEdit: () => void
  orgId: string
}) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [metrics, setMetrics] = useState<any>(null)
  const [plans, setPlans] = useState<any[]>([])
  const [newPlate, setNewPlate] = useState('')
  const [newBrand, setNewBrand] = useState('')
  const [conflict, setConflict] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  const displayName = getDisplayName(customer)
  const ms = getMembershipStyle(customer.membership_status)

  useEffect(() => {
    Promise.all([
      getCustomerVehicles(customer.id),
      getCustomerMetrics(customer.id),
      getMembershipPlans(orgId),
    ]).then(([v, m, p]) => {
      setVehicles(v)
      setMetrics(m)
      setPlans(p)
    }).catch(() => {})
  }, [customer.id, orgId])

  const handleAddVehicle = async () => {
    const plate = newPlate.trim()
    if (!plate) return
    setConflict(null)

    // Check conflict
    const existing = await checkPlateConflict(plate, customer.id).catch(() => null)
    if (existing) {
      setConflict({ plate, vehicleId: existing.id, ownerId: existing.customer_id, ownerName: getDisplayName(existing.customers as any) })
      return
    }

    setSaving(true)
    try {
      await addVehicleToCustomer({ customer_id: customer.id, organization_id: orgId, plate, brand: newBrand || undefined })
      setNewPlate(''); setNewBrand('')
      const updated = await getCustomerVehicles(customer.id)
      setVehicles(updated)
      toast.success('Vehículo agregado')
      onUpdated()
    } catch { toast.error('No se pudo agregar el vehículo') }
    setSaving(false)
  }

  const handleTransfer = async () => {
    if (!conflict) return
    setSaving(true)
    try {
      await transferVehicleOwnership(conflict.vehicleId, customer.id)
      setConflict(null); setNewPlate(''); setNewBrand('')
      const updated = await getCustomerVehicles(customer.id)
      setVehicles(updated)
      toast.success('Vehículo transferido')
      onUpdated()
    } catch { toast.error('Error al transferir vehículo') }
    setSaving(false)
  }

  /** Guarda un campo suelto; si la base lo rechaza, avisa y restaura. */
  const quickEdit = async (
    field: 'email' | 'phone',
    value: string,
    input: HTMLInputElement,
  ) => {
    const current = customer[field] ?? ''
    if (value === current) return
    try {
      await updateCustomer(customer.id, { [field]: value || null })
      onUpdated()
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      toast.error(
        /ccf_requires_fiscal_data/.test(message)
          ? 'Este cliente emite CCF: no puede quedarse sin teléfono ni correo'
          : 'No se pudo guardar el cambio'
      )
      input.value = current
    }
  }

  const idLine = customer.customer_type === 'individual'
    ? customer.dui ? `DUI ${customer.dui}` : 'Sin DUI registrado'
    : customer.nit ? `NIT ${customer.nit}` : 'Sin NIT registrado'

  return (
    <div className="side-panel">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{displayName}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{idLine}</div>
          {/* El POS lee esto para decidir qué documento emitir. */}
          <span
            className={`badge ${customer.fiscal_document_type === 'ccf' ? 'badge-green' : 'badge-neutral'}`}
            style={{ marginTop: 6, display: 'inline-block' }}
          >
            {customer.fiscal_document_type === 'ccf' ? 'Crédito fiscal' : 'Consumidor final'}
          </span>
        </div>
        <button className="panel-close" onClick={onClose} aria-label="Cerrar panel">×</button>
      </div>

      <button className="btn btn-ghost" onClick={onEdit}>Editar ficha</button>

      {/* Email / Phone — edición rápida.
          Un cliente marcado como CCF tiene un CHECK en la base que exige
          teléfono y correo; vaciarlos acá falla. Antes el error se tragaba en
          silencio y el input seguía mostrando el valor nuevo sin haberse
          guardado, así que ahora se avisa y se restaura el valor real. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          className="corsa-input"
          defaultValue={customer.email ?? ''}
          placeholder="Email"
          onBlur={e => quickEdit('email', e.target.value, e.target)}
        />
        <input
          className="corsa-input"
          defaultValue={customer.phone ?? ''}
          placeholder="Teléfono"
          onBlur={e => quickEdit('phone', e.target.value, e.target)}
        />
      </div>

      {/* Metrics */}
      {metrics && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {metrics.total_orders} visitas · {metrics.lifetime_value ? `US$${parseFloat(metrics.lifetime_value).toFixed(2)} acumulado` : ''} · última visita{' '}
          {metrics.days_since_last_visit != null ? (metrics.days_since_last_visit === 0 ? 'hoy' : metrics.days_since_last_visit === 1 ? 'hace 1 día' : `hace ${metrics.days_since_last_visit} días`) : 'sin visitas'}
        </div>
      )}

      <div className="panel-divider"/>

      {/* Vehicles */}
      <div>
        <div className="panel-section-label">Vehículos</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {vehicles.map(v => (
            <div key={v.id} className="panel-row">
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                {v.plate ?? '—'}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {[v.brand, v.model, v.year].filter(Boolean).join(' ') || '—'}
              </span>
            </div>
          ))}
          {vehicles.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Sin vehículos registrados</div>
          )}
        </div>

        {/* Add vehicle */}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <input
            className="corsa-input"
            value={newPlate}
            onChange={e => setNewPlate(e.target.value)}
            placeholder="Placa (P 123-456)"
            style={{ flex: 1 }}
          />
          <input
            className="corsa-input"
            value={newBrand}
            onChange={e => setNewBrand(e.target.value)}
            placeholder="Marca / modelo"
            style={{ flex: 1 }}
          />
        </div>
        <button
          onClick={handleAddVehicle}
          disabled={saving || !newPlate.trim()}
          style={{ marginTop: 6, width: '100%', textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: 'var(--corsa-green)', border: '1px solid var(--border)', borderRadius: 5, padding: 7, cursor: 'pointer', background: 'transparent' }}
        >
          {saving ? 'Guardando…' : 'Agregar vehículo'}
        </button>

        {/* Conflict */}
        {conflict && (
          <div className="alert-banner danger" style={{ marginTop: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B23232" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div className="alert-body">
              <div style={{ fontSize: 12 }}>La placa {conflict.plate} ya está registrada a nombre de {conflict.ownerName}.</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                <a href="#" onClick={e => { e.preventDefault(); handleTransfer() }} style={{ fontSize: 12, fontWeight: 600 }}>Transferir a este cliente</a>
                <a href="#" onClick={e => { e.preventDefault(); setConflict(null) }} style={{ fontSize: 12 }}>Cancelar</a>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="panel-divider"/>

      {/* Membership */}
      <div>
        <div className="panel-section-label">Membresía</div>
        {customer.membership_status !== 'none' ? (
          <div className="membership-indicator" style={{ background: ms.tint }}>
            <div className="membership-dot" style={{ background: ms.color }}/>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: ms.color }}>
              {customer.membership_plan ?? ms.label}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plans.slice(0, 3).map(p => (
              <div key={p.id} className="plan-row">
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.billing_cycle}</div>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                  US${parseFloat(p.price).toFixed(2)}/mes
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
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
  const { profile } = useAuth()
  const orgId = (profile as any)?.organization_id ?? ''

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

  return (
    <div className="page-inner">
      {/* Header */}
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 26 }}>Clientes</h1>
          <div className="page-header-sub">
            {customers.length} clientes · {totalVehicles} vehículos registrados
          </div>
        </div>
        <ClipButton
          id="btn-new-customer"
          label="+ Nuevo cliente"
          onClick={() => setPanel({ type: 'new' })}
        />
      </div>

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
        <div style={{ flex: '2 1 560px', minWidth: 480, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {/* Table header */}
          <div style={{ display: 'flex', padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
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
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{segLabel}</div>
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }} className="truncate">{c.email ?? '—'}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.phone ?? '—'}</div>
                      </td>
                      <td>
                        <span className={`badge ${c.fiscal_document_type === 'ccf' ? 'badge-green' : 'badge-neutral'}`}>
                          {c.fiscal_document_type === 'ccf' ? 'CCF' : 'Consumidor final'}
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
          )}
        </div>

        {/* Side panel */}
        {panel && (
          panel.type === 'view' && selectedCustomer ? (
            <ViewPanel
              customer={selectedCustomer}
              onClose={() => setPanel(null)}
              onUpdated={() => loadCustomers(search)}
              onEdit={() => setPanel({ type: 'edit', customerId: selectedCustomer.id })}
              orgId={orgId}
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
