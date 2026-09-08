/**
 * CORSA Carwash — Flotillas Corporativas
 * Gestión de empresas · vehículos de flota · precios especiales
 */

import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'

// ─── Types ────────────────────────────────────────────────────

interface FleetCompany {
  id: string                      // customers.id
  customer_type: string
  trade_name: string | null
  legal_name: string | null
  nit: string | null
  email: string | null
  phone: string | null
  address_line1: string | null
  // corporate_account fields
  account_id: string | null
  credit_limit: number
  credit_status: string
  current_balance: number
  blocked: boolean
  // fleet fields
  fleet_id: string | null
  fleet_name: string | null
  fleet_code: string | null
  // special price (ÉLITE)
  elite_price_s: number | null
  elite_price_m: number | null
  elite_price_l: number | null
  vehicle_count: number
}

interface FleetVehicle {
  fv_id: string          // fleet_vehicles.id
  vehicle_id: string
  plate: string
  brand: string | null
  model: string | null
  year: number | null
  color: string | null
  cost_center: string | null
  active: boolean
}

// ─── Helpers ──────────────────────────────────────────────────

function fmt(n: number) { return 'US$' + n.toFixed(2) }

function initials(name: string): string {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

// ─── Create Company Modal ─────────────────────────────────────

interface CreateCompanyModalProps {
  orgId: string
  onCreated: () => void
  onCancel: () => void
}

function CreateCompanyModal({ orgId, onCreated, onCancel }: CreateCompanyModalProps) {
  const [form, setForm] = useState({
    trade_name: '', legal_name: '', nit: '',
    email: '', phone: '', address_line1: '',
    credit_limit: '500',
    elite_price_s: '8', elite_price_m: '10', elite_price_l: '11',
    fleet_name: '', fleet_code: '',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  const handleSave = async () => {
    if (!form.trade_name.trim() && !form.legal_name.trim()) {
      toast.error('Ingresa el nombre de la empresa')
      return
    }
    setSaving(true)
    try {
      const db = supabase as any

      // 1. Create customer (company)
      const { data: cust, error: custErr } = await db
        .from('customers')
        .insert({
          organization_id: orgId,
          customer_type: 'company',
          trade_name: form.trade_name.trim() || null,
          legal_name: form.legal_name.trim() || null,
          nit: form.nit.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          address_line1: form.address_line1.trim() || null,
          status: 'active',
        })
        .select('id')
        .single()

      if (custErr) throw custErr

      // 2. Create corporate account
      const { error: accErr } = await db
        .from('corporate_accounts')
        .insert({
          customer_id: cust.id,
          credit_limit: parseFloat(form.credit_limit) || 500,
          credit_status: 'active',
          current_balance: 0,
          blocked: false,
        })
      if (accErr) throw accErr

      // 3. Create fleet
      const fleetCode = form.fleet_code.trim() || form.trade_name.replace(/\s+/g, '-').toUpperCase().slice(0, 10)
      const { data: fleet, error: fleetErr } = await db
        .from('fleets')
        .insert({
          organization_id: orgId,
          customer_id: cust.id,
          name: form.fleet_name.trim() || form.trade_name.trim(),
          code: fleetCode,
          active: true,
        })
        .select('id')
        .single()
      if (fleetErr) throw fleetErr

      // 4. Fleet contract with credit limit
      await db.from('fleet_contracts').insert({
        fleet_id: fleet.id,
        starts_at: new Date().toISOString().split('T')[0],
        billing_frequency: 'monthly',
        credit_limit: parseFloat(form.credit_limit) || 500,
        credit_days: 30,
        active: true,
      })

      // 5. Store ÉLITE special prices as customer_price_agreements
      // We'll use a simpler approach: store prices in a metadata JSON via upsert
      // Since service IDs aren't known yet, store in fleet notes or use a simple prices table
      // For now, store as fleet metadata using fleet_contracts terms field (JSON string)
      await db.from('fleet_contracts')
        .update({ terms: JSON.stringify({
          elite_price_s: parseFloat(form.elite_price_s),
          elite_price_m: parseFloat(form.elite_price_m),
          elite_price_l: parseFloat(form.elite_price_l),
        })})
        .eq('fleet_id', fleet.id)

      toast.success(`Flotilla ${form.trade_name} creada ✓`)
      onCreated()
    } catch (err: any) {
      toast.error(err?.message ?? 'Error al crear la empresa')
    }
    setSaving(false)
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Nueva empresa de flotilla</div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Sección: Empresa */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--corsa-green)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Información de la empresa</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field" style={{ gridColumn: '1/-1' }}>
                <label>Nombre comercial *</label>
                <input className="corsa-input" value={form.trade_name} onChange={e => set('trade_name', e.target.value)} placeholder="Ej: Distribuidora La Central"/>
              </div>
              <div className="field">
                <label>Razón social</label>
                <input className="corsa-input" value={form.legal_name} onChange={e => set('legal_name', e.target.value)} placeholder="S.A. de C.V."/>
              </div>
              <div className="field">
                <label>NIT</label>
                <input className="corsa-input" value={form.nit} onChange={e => set('nit', e.target.value)} placeholder="0614-010101-000-0"/>
              </div>
              <div className="field">
                <label>Teléfono</label>
                <input className="corsa-input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="2222-3333"/>
              </div>
              <div className="field">
                <label>Email</label>
                <input className="corsa-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="facturacion@empresa.com"/>
              </div>
              <div className="field" style={{ gridColumn: '1/-1' }}>
                <label>Dirección</label>
                <input className="corsa-input" value={form.address_line1} onChange={e => set('address_line1', e.target.value)} placeholder="Calle Principal #123, San Salvador"/>
              </div>
            </div>
          </div>

          <div className="divider"/>

          {/* Sección: Flotilla */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--corsa-green)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Datos de la flotilla</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>Nombre de la flotilla</label>
                <input className="corsa-input" value={form.fleet_name} onChange={e => set('fleet_name', e.target.value)} placeholder="Flotilla principal"/>
              </div>
              <div className="field">
                <label>Código</label>
                <input className="corsa-input" value={form.fleet_code} onChange={e => set('fleet_code', e.target.value.toUpperCase())} placeholder="DIST-CENTRAL"/>
              </div>
              <div className="field">
                <label>Límite de crédito (US$)</label>
                <input className="corsa-input" type="number" value={form.credit_limit} onChange={e => set('credit_limit', e.target.value)} min="0" step="50"/>
              </div>
            </div>
          </div>

          <div className="divider"/>

          {/* Sección: Precios ÉLITE especiales */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--corsa-orange)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Precio especial ÉLITE</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 12 }}>
              Precio negociado para el servicio ÉLITE. Deja en blanco para usar precio estándar (S$12 · M$14 · L$15).
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              {[
                { key: 'elite_price_s', label: 'S · Pequeño', placeholder: '12.00' },
                { key: 'elite_price_m', label: 'M · Mediano', placeholder: '14.00' },
                { key: 'elite_price_l', label: 'L · Grande',  placeholder: '15.00' },
              ].map(f => (
                <div key={f.key} className="field">
                  <label>{f.label}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', flexShrink: 0 }}>$</span>
                    <input className="corsa-input" type="number" step="0.50" min="0"
                      value={(form as any)[f.key]} onChange={e => set(f.key, e.target.value)}
                      placeholder={f.placeholder}/>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="btn btn-ghost">Cancelar</button>
          <div className="clip-btn-wrap" style={{ opacity: saving ? 0.6 : 1 }}>
            <div className="clip-btn-corner"/>
            <button id="fleet-save" className="clip-btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Guardando…' : 'Crear empresa'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Add Vehicle Modal ─────────────────────────────────────────

interface AddVehicleModalProps {
  fleetId: string
  customerId: string
  orgId: string
  onAdded: () => void
  onCancel: () => void
}

function AddVehicleModal({ fleetId, customerId, onAdded, onCancel }: Omit<AddVehicleModalProps, 'orgId'> & { orgId?: string }) {
  const [form, setForm] = useState({ plate: '', brand: '', model: '', year: '', color: '', cost_center: '' })
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  const handleSave = async () => {
    if (!form.plate.trim()) { toast.error('La placa es requerida'); return }
    setSaving(true)
    try {
      const db = supabase as any
      // 1. Create vehicle
      const { data: veh, error: vehErr } = await db
        .from('vehicles')
        .insert({
          customer_id: customerId,
          plate: form.plate.trim().toUpperCase(),
          brand: form.brand.trim() || null,
          model: form.model.trim() || null,
          year: form.year ? parseInt(form.year) : null,
          color: form.color.trim() || null,
          status: 'active',
        })
        .select('id')
        .single()
      if (vehErr) throw vehErr

      // 2. Add to fleet_vehicles
      const { error: fvErr } = await db
        .from('fleet_vehicles')
        .insert({
          fleet_id: fleetId,
          vehicle_id: veh.id,
          cost_center: form.cost_center.trim() || null,
          active: true,
        })
      if (fvErr) throw fvErr

      toast.success(`Vehículo ${form.plate.toUpperCase()} agregado ✓`)
      onAdded()
    } catch (err: any) {
      toast.error(err?.message ?? 'Error al agregar el vehículo')
    }
    setSaving(false)
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, width: '100%', maxWidth: 440, boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>Agregar vehículo a la flota</div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field" style={{ gridColumn: '1/-1' }}>
              <label>Placa *</label>
              <input className="corsa-input" value={form.plate} onChange={e => set('plate', e.target.value.toUpperCase())} placeholder="P 123-456" style={{ fontWeight: 700, letterSpacing: 1 }}/>
            </div>
            <div className="field">
              <label>Marca</label>
              <input className="corsa-input" value={form.brand} onChange={e => set('brand', e.target.value)} placeholder="Toyota"/>
            </div>
            <div className="field">
              <label>Modelo</label>
              <input className="corsa-input" value={form.model} onChange={e => set('model', e.target.value)} placeholder="Hilux"/>
            </div>
            <div className="field">
              <label>Año</label>
              <input className="corsa-input" type="number" value={form.year} onChange={e => set('year', e.target.value)} placeholder="2022" min="1990" max={new Date().getFullYear() + 1}/>
            </div>
            <div className="field">
              <label>Color</label>
              <input className="corsa-input" value={form.color} onChange={e => set('color', e.target.value)} placeholder="Blanco"/>
            </div>
            <div className="field" style={{ gridColumn: '1/-1' }}>
              <label>Centro de costo</label>
              <input className="corsa-input" value={form.cost_center} onChange={e => set('cost_center', e.target.value)} placeholder="Logística · Ventas · Gerencia"/>
            </div>
          </div>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="btn btn-ghost">Cancelar</button>
          <div className="clip-btn-wrap" style={{ opacity: saving ? 0.6 : 1 }}>
            <div className="clip-btn-corner"/>
            <button className="clip-btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Guardando…' : 'Agregar vehículo'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Main FlotillasPage ───────────────────────────────────────

export function FlotillasPage() {
  const { profile } = useAuth()
  const orgId = (profile as any)?.organization_id ?? null

  const [companies, setCompanies] = useState<FleetCompany[]>([])
  const [selected, setSelected] = useState<FleetCompany | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingVeh, setLoadingVeh] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [search, setSearch] = useState('')

  const loadCompanies = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    try {
      // Load customers (company type) + join fleet + contract pricing
      const { data: custs } = await (supabase as any)
        .from('customers')
        .select(`
          id, customer_type, trade_name, legal_name, nit, email, phone, address_line1,
          corporate_accounts(id, credit_limit, credit_status, current_balance, blocked),
          fleets(id, name, code, active)
        `)
        .eq('organization_id', orgId)
        .eq('customer_type', 'company')
        .order('trade_name')

      if (!custs) { setLoading(false); return }

      // For each customer with a fleet, get vehicle count + pricing
      const result: FleetCompany[] = await Promise.all(
        custs.map(async (c: any) => {
          const acc = c.corporate_accounts?.[0]
          const fleet = c.fleets?.[0]
          let vehicleCount = 0
          let prices = { s: null as number | null, m: null as number | null, l: null as number | null }

          if (fleet) {
            const { count } = await (supabase as any)
              .from('fleet_vehicles')
              .select('*', { count: 'exact', head: true })
              .eq('fleet_id', fleet.id)
              .eq('active', true)
            vehicleCount = count ?? 0

            // Get pricing from fleet_contracts.terms
            const { data: contract } = await (supabase as any)
              .from('fleet_contracts')
              .select('terms')
              .eq('fleet_id', fleet.id)
              .eq('active', true)
              .maybeSingle()

            if (contract?.terms) {
              try {
                const t = JSON.parse(contract.terms)
                prices = { s: t.elite_price_s ?? null, m: t.elite_price_m ?? null, l: t.elite_price_l ?? null }
              } catch { /* */ }
            }
          }

          return {
            id: c.id,
            customer_type: c.customer_type,
            trade_name: c.trade_name,
            legal_name: c.legal_name,
            nit: c.nit,
            email: c.email,
            phone: c.phone,
            address_line1: c.address_line1,
            account_id: acc?.id ?? null,
            credit_limit: acc?.credit_limit ?? 0,
            credit_status: acc?.credit_status ?? 'active',
            current_balance: acc?.current_balance ?? 0,
            blocked: acc?.blocked ?? false,
            fleet_id: fleet?.id ?? null,
            fleet_name: fleet?.name ?? null,
            fleet_code: fleet?.code ?? null,
            elite_price_s: prices.s,
            elite_price_m: prices.m,
            elite_price_l: prices.l,
            vehicle_count: vehicleCount,
          } as FleetCompany
        })
      )

      setCompanies(result)
    } catch { /* */ }
    setLoading(false)
  }, [orgId])

  useEffect(() => { loadCompanies() }, [loadCompanies])

  const loadVehicles = useCallback(async (fleetId: string) => {
    setLoadingVeh(true)
    const { data } = await (supabase as any)
      .from('fleet_vehicles')
      .select('id, vehicle_id, cost_center, active, vehicles(plate, brand, model, year, color)')
      .eq('fleet_id', fleetId)
      .order('added_at', { ascending: false })

    setVehicles(
      (data ?? []).map((fv: any) => ({
        fv_id: fv.id,
        vehicle_id: fv.vehicle_id,
        plate: fv.vehicles?.plate ?? '—',
        brand: fv.vehicles?.brand ?? null,
        model: fv.vehicles?.model ?? null,
        year: fv.vehicles?.year ?? null,
        color: fv.vehicles?.color ?? null,
        cost_center: fv.cost_center,
        active: fv.active,
      }))
    )
    setLoadingVeh(false)
  }, [])

  const selectCompany = (c: FleetCompany) => {
    setSelected(c)
    if (c.fleet_id) loadVehicles(c.fleet_id)
    else setVehicles([])
  }

  const filteredCompanies = search.trim()
    ? companies.filter(c =>
        (c.trade_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (c.legal_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (c.nit ?? '').includes(search)
      )
    : companies

  const deactivateVehicle = async (fvId: string) => {
    await (supabase as any).from('fleet_vehicles').update({ active: false }).eq('id', fvId)
    if (selected?.fleet_id) loadVehicles(selected.fleet_id)
  }

  return (
    <div className="page-inner">

      {/* Header */}
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 26, margin: 0, color: 'var(--text-primary)' }}>
            Flotillas corporativas
          </h1>
          <div className="page-header-sub">
            {companies.length} empresa{companies.length !== 1 ? 's' : ''} · {companies.reduce((s, c) => s + c.vehicle_count, 0)} vehículos en flota
          </div>
        </div>
        <div className="clip-btn-wrap">
          <div className="clip-btn-corner"/>
          <button id="btn-new-fleet" className="clip-btn" onClick={() => setShowCreateModal(true)}>
            + Nueva empresa
          </button>
        </div>
      </div>

      {/* Layout */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* ── Lista de empresas ── */}
        <div style={{ flex: '0 0 340px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar empresa o NIT…"
              style={{ border: 'none', outline: 'none', fontSize: 13.5, flex: 1, background: 'transparent', color: 'var(--text-primary)', fontFamily: 'var(--font-body)' }}
            />
          </div>

          {loading ? (
            <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
          ) : filteredCompanies.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">No hay empresas registradas</div>
              <div className="empty-state-sub">Crea la primera empresa de flotilla con el botón de arriba.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filteredCompanies.map(c => (
                <div
                  key={c.id}
                  onClick={() => selectCompany(c)}
                  style={{
                    background: 'var(--surface)',
                    border: `1px solid ${selected?.id === c.id ? 'var(--corsa-green)' : 'var(--border)'}`,
                    borderRadius: 6, padding: '12px 14px', cursor: 'pointer',
                    transition: 'all 0.12s',
                    borderLeft: selected?.id === c.id ? '4px solid var(--corsa-green)' : '1px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 6, background: selected?.id === c.id ? 'var(--corsa-green)' : 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: selected?.id === c.id ? '#fff' : 'var(--text-primary)', flexShrink: 0 }}>
                      {initials(c.trade_name ?? c.legal_name ?? '?')}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.trade_name ?? c.legal_name}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>
                        {c.nit ? `NIT ${c.nit}` : 'Sin NIT'} · {c.vehicle_count} vehículo{c.vehicle_count !== 1 ? 's' : ''}
                      </div>
                    </div>
                    {c.blocked ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-danger-text)', background: 'var(--color-danger-tint)', padding: '2px 6px', borderRadius: 4 }}>Bloqueada</span>
                    ) : c.credit_status !== 'active' ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-warning-text)', background: 'var(--color-warning-tint)', padding: '2px 6px', borderRadius: 4 }}>{c.credit_status}</span>
                    ) : (
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-success-text)', background: 'var(--color-success-tint)', padding: '2px 6px', borderRadius: 4 }}>Activa</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Detalle de empresa ── */}
        {selected ? (
          <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Company header */}
            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>
                    {selected.trade_name ?? selected.legal_name}
                  </div>
                  {selected.legal_name && selected.trade_name && (
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{selected.legal_name}</div>
                  )}
                  <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
                    {selected.nit && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>NIT: <strong style={{ color: 'var(--text-primary)' }}>{selected.nit}</strong></div>}
                    {selected.phone && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>📞 {selected.phone}</div>}
                    {selected.email && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>✉ {selected.email}</div>}
                  </div>
                  {selected.address_line1 && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>📍 {selected.address_line1}</div>}
                </div>

                {/* Credit status */}
                <div style={{ background: 'var(--subtle-bg)', borderRadius: 6, padding: '12px 16px', textAlign: 'right', minWidth: 160 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }}>CRÉDITO DISPONIBLE</div>
                  <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 22, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', marginTop: 4 }}>
                    {fmt(selected.credit_limit - selected.current_balance)}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>de {fmt(selected.credit_limit)} límite</div>
                  {/* Bar */}
                  <div style={{ marginTop: 8, height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, selected.credit_limit > 0 ? (selected.current_balance / selected.credit_limit * 100) : 0)}%`, background: selected.current_balance > selected.credit_limit * 0.8 ? 'var(--color-danger)' : 'var(--corsa-green)', borderRadius: 2 }}/>
                  </div>
                </div>
              </div>

              {/* Special prices */}
              {(selected.elite_price_s || selected.elite_price_m || selected.elite_price_l) && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--corsa-orange)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Precio especial ÉLITE</div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    {[['S · Pequeños', selected.elite_price_s], ['M · Medianos', selected.elite_price_m], ['L · Grandes', selected.elite_price_l]].map(([label, price]) => (
                      <div key={String(label)} style={{ textAlign: 'center' }}>
                        <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 22, color: 'var(--corsa-orange)', fontVariantNumeric: 'tabular-nums' }}>
                          {price ? `$${price}` : '—'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Vehicles */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>
                  Vehículos en flota
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '2px 8px', borderRadius: 4 }}>
                    {vehicles.filter(v => v.active).length} activos
                  </span>
                </div>
                {selected.fleet_id && (
                  <button
                    id="btn-add-vehicle"
                    onClick={() => setShowAddVehicle(true)}
                    className="btn btn-primary"
                    style={{ padding: '7px 14px', fontSize: 13 }}
                  >
                    + Agregar
                  </button>
                )}
              </div>

              {loadingVeh ? (
                <div className="loading-center"><div className="spinner"/></div>
              ) : vehicles.length === 0 ? (
                <div className="empty-state">
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🚗</div>
                  <div className="empty-state-title">Sin vehículos en esta flotilla</div>
                  <div className="empty-state-sub">Agrega el primer vehículo con el botón de arriba.</div>
                </div>
              ) : (
                <div>
                  {/* Table header */}
                  <div style={{ display: 'flex', padding: '8px 18px', fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ flex: 1 }}>Placa</div>
                    <div style={{ width: 160 }}>Vehículo</div>
                    <div style={{ width: 80 }}>Año</div>
                    <div style={{ width: 80 }}>Color</div>
                    <div style={{ width: 120 }}>Centro de costo</div>
                    <div style={{ width: 60 }}></div>
                  </div>
                  {vehicles.map(v => (
                    <div
                      key={v.fv_id}
                      style={{ display: 'flex', alignItems: 'center', padding: '11px 18px', borderBottom: '1px solid var(--border)', opacity: v.active ? 1 : 0.5 }}
                    >
                      <div style={{ flex: 1, fontWeight: 700, fontSize: 14, fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', letterSpacing: 0.5 }}>{v.plate}</div>
                      <div style={{ width: 160, fontSize: 13, color: 'var(--text-primary)' }}>
                        {[v.brand, v.model].filter(Boolean).join(' ') || '—'}
                      </div>
                      <div style={{ width: 80, fontSize: 13, color: 'var(--text-secondary)' }}>{v.year ?? '—'}</div>
                      <div style={{ width: 80, fontSize: 13, color: 'var(--text-secondary)' }}>{v.color ?? '—'}</div>
                      <div style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)' }}>{v.cost_center ?? '—'}</div>
                      <div style={{ width: 60, textAlign: 'right' }}>
                        {v.active && (
                          <button
                            onClick={() => deactivateVehicle(v.fv_id)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', padding: '2px 6px', borderRadius: 4 }}
                            title="Dar de baja"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minWidth: 320 }}>
            <div className="empty-state" style={{ paddingTop: 60 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🏢</div>
              <div className="empty-state-title">Selecciona una empresa</div>
              <div className="empty-state-sub">Haz clic en una empresa de la lista para ver sus vehículos y detalles.</div>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreateModal && orgId && (
        <CreateCompanyModal
          orgId={orgId}
          onCreated={() => { setShowCreateModal(false); loadCompanies() }}
          onCancel={() => setShowCreateModal(false)}
        />
      )}
      {showAddVehicle && selected?.fleet_id && (
        <AddVehicleModal
          fleetId={selected.fleet_id}
          customerId={selected.id}
          orgId={orgId}
          onAdded={() => { setShowAddVehicle(false); loadVehicles(selected.fleet_id!) }}
          onCancel={() => setShowAddVehicle(false)}
        />
      )}
    </div>
  )
}
