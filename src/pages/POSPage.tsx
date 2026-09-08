/**
 * CORSA Carwash — POS Nueva orden
 * Modos: Normal · Flotilla Corporativa · Membresía
 * Servicios: PRO · ÉLITE · SIGNATURE  (S / M / L)
 * Add-on: Aspirado de interiores $3
 * Modal de cobro: Ticket (FCF) o CCF
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'

// ─── Catálogo ────────────────────────────────────────────────

const SIZES = [
  { id: 'S', label: 'S', sub: 'Pequeños' },
  { id: 'M', label: 'M', sub: 'Medianos' },
  { id: 'L', label: 'L', sub: 'Grandes' },
] as const
type SizeId = typeof SIZES[number]['id']

const SERVICES = [
  {
    id: 'pro', name: 'PRO', tier: 'pro' as const,
    description: 'Elimina toda suciedad y brinda brillo excepcional en minutos',
    prices: { S: 9, M: 11, L: 12 },
  },
  {
    id: 'elite', name: 'ÉLITE', tier: 'elite' as const,
    description: 'PRO + acabado superior con acondicionador de pintura',
    prices: { S: 12, M: 14, L: 15 },
  },
  {
    id: 'signature', name: 'SIGNATURE', tier: 'signature' as const,
    description: 'Experiencia completa con acondicionador de pintura y cera protectora',
    prices: { S: 15, M: 17, L: 18 },
    recommended: true,
  },
]

const ADDON_ASPIRADO = { id: 'aspirado', label: 'Aspirado de interiores', price: 3 }
const PAYMENT_METHODS = [
  { id: 'efectivo',      label: 'Efectivo'      },
  { id: 'tarjeta',       label: 'Tarjeta'        },
  { id: 'transferencia', label: 'Transferencia'  },
  { id: 'membresia',     label: 'Membresía'      },
  { id: 'credito',       label: 'Crédito emp.'   },
]
const KEYPAD_KEYS = ['1','2','3','4','5','6','7','8','9','.','0','⌫']

const TIER_COLORS = {
  pro:       { accent: '#023530' },
  elite:     { accent: '#FF6A28' },
  signature: { accent: '#8B5A2B' },
}

type OrderMode = 'normal' | 'flotilla' | 'membresia'
type DocType = 'ticket' | 'ccf' | null
type FcfMode = 'generic' | 'named'

// ─── Types ────────────────────────────────────────────────────

interface CustomerResult {
  id: string
  customer_type: 'individual' | 'company'
  first_name?: string; last_name?: string
  trade_name?: string; legal_name?: string
  dui?: string; nit?: string
  email?: string; phone?: string
  vehicle?: { id: string; plate: string; brand?: string; model?: string; year?: string; color?: string }
  membership_status?: 'active' | 'expiring' | null
  membership_plan?: string
  lifetime_orders?: number
  days_since_last?: number | null
  ar_overdue?: boolean; ar_amount?: number
}

interface FleetCompany {
  customer_id: string
  fleet_id: string
  fleet_name: string
  trade_name: string
  nit: string | null
  elite_price_s: number
  elite_price_m: number
  elite_price_l: number
}

interface FleetVehicle {
  fv_id: string
  vehicle_id: string
  plate: string
  brand: string | null
  model: string | null
  year: number | null
  color: string | null
}

interface BillingInfo {
  docType: 'ticket' | 'ccf'
  fcfMode?: FcfMode
  fcfName?: string
  ccfCustomer?: CustomerResult | null
}

// ─── Helpers ──────────────────────────────────────────────────

function fmt(n: number) { return 'US$' + n.toFixed(2) }

function displayName(c: CustomerResult | null): string {
  if (!c) return 'Cliente Genérico'
  if (c.customer_type === 'individual') return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()
  return c.trade_name ?? c.legal_name ?? '—'
}

function useDebounce<T>(val: T, ms = 350): T {
  const [d, setD] = useState(val)
  useEffect(() => { const t = setTimeout(() => setD(val), ms); return () => clearTimeout(t) }, [val, ms])
  return d
}

// ─── Fleet Selection Modal ────────────────────────────────────

interface FleetModalProps {
  onVehicleSelected: (company: FleetCompany, vehicle: FleetVehicle) => void
  onCancel: () => void
}

function FleetModal({ onVehicleSelected, onCancel }: FleetModalProps) {
  const { profile } = useAuth()
  const orgId = (profile as any)?.organization_id ?? null

  const [companies, setCompanies] = useState<FleetCompany[]>([])
  const [selectedCompany, setSelectedCompany] = useState<FleetCompany | null>(null)
  const [vehicles, setVehicles] = useState<FleetVehicle[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingVeh, setLoadingVeh] = useState(false)
  const [searchC, setSearchC] = useState('')
  const [searchV, setSearchV] = useState('')

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  // Load fleets
  useEffect(() => {
    if (!orgId) return
    ;(async () => {
      setLoading(true)
      try {
        const { data: fleets } = await (supabase as any)
          .from('fleets')
          .select('id, name, customer_id, customers(id, trade_name, legal_name, nit), fleet_contracts(terms)')
          .eq('organization_id', orgId)
          .eq('active', true)

        setCompanies((fleets ?? []).map((f: any) => {
          const c = f.customers ?? {}
          let prices = { s: 12, m: 14, l: 15 }
          try { const t = JSON.parse(f.fleet_contracts?.[0]?.terms ?? '{}'); prices = { s: t.elite_price_s ?? 12, m: t.elite_price_m ?? 14, l: t.elite_price_l ?? 15 } } catch { /* */ }
          return {
            customer_id: c.id,
            fleet_id: f.id,
            fleet_name: f.name,
            trade_name: c.trade_name ?? c.legal_name ?? '—',
            nit: c.nit,
            elite_price_s: prices.s,
            elite_price_m: prices.m,
            elite_price_l: prices.l,
          }
        }))
      } catch { /* */ }
      setLoading(false)
    })()
  }, [orgId])

  const selectCompany = async (company: FleetCompany) => {
    setSelectedCompany(company)
    setLoadingVeh(true)
    const { data } = await (supabase as any)
      .from('fleet_vehicles')
      .select('id, vehicle_id, vehicles(plate, brand, model, year, color)')
      .eq('fleet_id', company.fleet_id)
      .eq('active', true)
    setVehicles((data ?? []).map((fv: any) => ({
      fv_id: fv.id, vehicle_id: fv.vehicle_id,
      plate: fv.vehicles?.plate ?? '—', brand: fv.vehicles?.brand ?? null,
      model: fv.vehicles?.model ?? null, year: fv.vehicles?.year ?? null, color: fv.vehicles?.color ?? null,
    })))
    setLoadingVeh(false)
  }

  const filteredCompanies = searchC.trim()
    ? companies.filter(c => c.trade_name.toLowerCase().includes(searchC.toLowerCase()) || (c.nit ?? '').includes(searchC))
    : companies

  const filteredVehicles = searchV.trim()
    ? vehicles.filter(v => v.plate.toLowerCase().includes(searchV.toLowerCase()) || (v.brand ?? '').toLowerCase().includes(searchV.toLowerCase()) || (v.model ?? '').toLowerCase().includes(searchV.toLowerCase()))
    : vehicles

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, width: '100%', maxWidth: 680, maxHeight: '85vh', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 19, color: 'var(--text-primary)' }}>Seleccionar vehículo de flotilla</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              El servicio será <strong>ÉLITE</strong> con el precio negociado de la empresa
            </div>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* Left: Companies */}
          <div style={{ width: 260, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <input
                value={searchC}
                onChange={e => setSearchC(e.target.value)}
                placeholder="Buscar empresa…"
                style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, background: 'var(--page-bg)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'var(--font-body)' }}
              />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loading ? (
                <div className="loading-center"><div className="spinner"/></div>
              ) : filteredCompanies.length === 0 ? (
                <div className="empty-state"><div className="empty-state-sub">Sin flotillas registradas</div></div>
              ) : filteredCompanies.map(c => (
                <div
                  key={c.fleet_id}
                  onClick={() => selectCompany(c)}
                  style={{
                    padding: '11px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                    background: selectedCompany?.fleet_id === c.fleet_id ? 'rgba(2,53,48,0.07)' : 'transparent',
                    borderLeft: selectedCompany?.fleet_id === c.fleet_id ? '3px solid var(--corsa-green)' : '3px solid transparent',
                    transition: 'all 0.1s',
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{c.trade_name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {c.nit ? `NIT ${c.nit}` : 'Sin NIT'}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--corsa-orange)', marginTop: 4, fontWeight: 600 }}>
                    ÉLITE: S${c.elite_price_s} · M${c.elite_price_m} · L${c.elite_price_l}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Vehicles */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {!selectedCompany ? (
              <div className="empty-state" style={{ margin: 'auto' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>←</div>
                <div className="empty-state-sub">Selecciona una empresa para ver sus vehículos</div>
              </div>
            ) : (
              <>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <input
                    value={searchV}
                    onChange={e => setSearchV(e.target.value)}
                    placeholder="Buscar por placa, marca…"
                    style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, background: 'var(--page-bg)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'var(--font-body)' }}
                  />
                </div>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {loadingVeh ? (
                    <div className="loading-center"><div className="spinner"/></div>
                  ) : filteredVehicles.length === 0 ? (
                    <div className="empty-state"><div className="empty-state-sub">Sin vehículos en esta flotilla</div></div>
                  ) : filteredVehicles.map(v => (
                    <div
                      key={v.fv_id}
                      onClick={() => onVehicleSelected(selectedCompany, v)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                        borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'var(--subtle-bg)'}
                      onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                    >
                      {/* Car icon */}
                      <div style={{ width: 38, height: 38, borderRadius: 6, background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--corsa-green)" strokeWidth="1.8" strokeLinecap="round"><path d="M5 17H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1l2-4h10l2 4h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', letterSpacing: 0.5 }}>{v.plate}</div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                          {[v.brand, v.model, v.year, v.color].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Customer Search Panel ────────────────────────────────────

function CustomerSearchPanel({ selected, onSelect, onClear }: {
  selected: CustomerResult | null
  onSelect: (c: CustomerResult) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CustomerResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const debouncedQ = useDebounce(query, 350)
  const dropRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (debouncedQ.length < 2) { setResults([]); setOpen(false); return }
    const isPlate = /^[a-zA-Z]\s?\d/.test(debouncedQ)
    setLoading(true)
    ;(async () => {
      try {
        let data: any[] = []
        if (isPlate) {
          const { data: vd } = await (supabase as any)
            .from('vehicles').select('id,plate,brand,model,year,color,customer_id,customers(id,customer_type,first_name,last_name,trade_name,legal_name,dui,nit)')
            .ilike('plate', `%${debouncedQ.replace(/\s/g, '')}%`).limit(6)
          data = (vd ?? []).map((v: any) => ({ ...(v.customers ?? {}), vehicle: { id: v.id, plate: v.plate, brand: v.brand, model: v.model, year: v.year, color: v.color } }))
        } else {
          const { data: cd } = await (supabase as any)
            .from('customers').select('id,customer_type,first_name,last_name,trade_name,legal_name,dui,nit,email,phone')
            .or(`first_name.ilike.%${debouncedQ}%,last_name.ilike.%${debouncedQ}%,trade_name.ilike.%${debouncedQ}%`).limit(8)
          data = cd ?? []
        }
        setResults(data); setOpen(true)
      } catch { setResults([]) }
      setLoading(false)
    })()
  }, [debouncedQ])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!dropRef.current?.contains(e.target as Node) && !inputRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  if (selected) return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{displayName(selected)}</div>
          {selected.vehicle && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{[selected.vehicle.brand, selected.vehicle.model].filter(Boolean).join(' ')} · <strong>{selected.vehicle.plate}</strong></div>}
        </div>
        <button onClick={onClear} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>×</button>
      </div>
      {selected.membership_status && (
        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: selected.membership_status === 'active' ? 'var(--color-success-text)' : 'var(--color-warning-text)', background: selected.membership_status === 'active' ? 'var(--color-success-tint)' : 'var(--color-warning-tint)', padding: '5px 10px', borderRadius: 4 }}>
          ● Membresía {selected.membership_status === 'active' ? 'activa' : 'por vencer'} · {selected.membership_plan}
        </div>
      )}
      {selected.ar_overdue && <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: 'var(--color-danger-text)', background: 'var(--color-danger-tint)', padding: '5px 10px', borderRadius: 4 }}>⚠ Saldo vencido {fmt(selected.ar_amount ?? 0)}</div>}
    </div>
  )

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 5, background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>Cliente Genérico</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Por defecto · busca para cambiar</div>
        </div>
      </div>
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 6, padding: '8px 11px', background: 'var(--page-bg)' }}>
          {loading ? <div className="spinner" style={{ width: 14, height: 14 }}/> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
          <input
            ref={inputRef}
            value={query} onChange={e => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            placeholder="Nombre o placa…"
            style={{ border: 'none', outline: 'none', fontSize: 13, flex: 1, background: 'transparent', color: 'var(--text-primary)', fontFamily: 'var(--font-body)' }}
          />
          {query && <button onClick={() => { setQuery(''); setResults([]); setOpen(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 15 }}>×</button>}
        </div>
        {open && results.length > 0 && (
          <div ref={dropRef} style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 50, overflow: 'hidden', maxHeight: 260, overflowY: 'auto' }}>
            {results.map((c, i) => (
              <button key={c.id + i} onClick={() => { onSelect(c); setQuery(''); setOpen(false) }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'var(--subtle-bg)'}
                onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
              >
                <div style={{ width: 26, height: 26, borderRadius: 5, background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>
                  {displayName(c).charAt(0)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(c)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{c.vehicle ? c.vehicle.plate : (c.dui ?? c.nit ?? '')}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Billing Modal ────────────────────────────────────────────

interface BillingModalProps {
  total: number; paymentMethod: string
  onConfirm: (billing: BillingInfo) => void
  onCancel: () => void
}

function BillingModal({ total, paymentMethod, onConfirm, onCancel }: BillingModalProps) {
  const [docType, setDocType] = useState<DocType>(null)
  const [fcfMode, setFcfMode] = useState<FcfMode>('generic')
  const [fcfName, setFcfName] = useState('')
  const [ccfQuery, setCcfQuery] = useState('')
  const [ccfResults, setCcfResults] = useState<CustomerResult[]>([])
  const [ccfSelected, setCcfSelected] = useState<CustomerResult | null>(null)
  const [ccfLoading, setCcfLoading] = useState(false)
  const debouncedCcf = useDebounce(ccfQuery, 350)

  useEffect(() => {
    if (debouncedCcf.length < 2) { setCcfResults([]); return }
    setCcfLoading(true)
    ;(async () => {
      const { data } = await (supabase as any).from('customers')
        .select('id,customer_type,first_name,last_name,trade_name,legal_name,dui,nit,email')
        .or(`trade_name.ilike.%${debouncedCcf}%,legal_name.ilike.%${debouncedCcf}%,nit.ilike.%${debouncedCcf}%,dui.ilike.%${debouncedCcf}%`).limit(8)
      setCcfResults(data ?? [])
      setCcfLoading(false)
    })()
  }, [debouncedCcf])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  const canConfirm = docType === 'ticket' || (docType === 'ccf' && ccfSelected != null)

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Tipo de documento fiscal</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>
              Total: <strong style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(total)}</strong>
              {' · '}{PAYMENT_METHODS.find(p => p.id === paymentMethod)?.label}
            </div>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        <div style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Doc type */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[
              { id: 'ticket', label: 'Ticket', sub: 'Factura consumidor final', color: 'var(--corsa-green)' },
              { id: 'ccf',    label: 'CCF',    sub: 'Comprobante crédito fiscal', color: 'var(--corsa-orange)' },
            ].map(opt => (
              <button
                key={opt.id}
                id={`doctype-${opt.id}`}
                onClick={() => setDocType(opt.id as DocType)}
                style={{
                  padding: '16px 14px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                  border: `2px solid ${docType === opt.id ? opt.color : 'var(--border)'}`,
                  background: docType === opt.id ? `${opt.color}10` : 'var(--surface)',
                  transition: 'all 0.12s',
                }}
              >
                <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 18, color: docType === opt.id ? opt.color : 'var(--text-primary)' }}>{opt.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{opt.sub}</div>
                {docType === opt.id && (
                  <div style={{ marginTop: 8, width: 18, height: 18, borderRadius: '50%', background: opt.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* FCF options */}
          {docType === 'ticket' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>¿A nombre de quién?</div>
              {[
                { id: 'generic', label: 'Consumidor final (Genérico)', sub: 'Sin datos fiscales · opción por defecto' },
                { id: 'named',   label: 'A nombre de…', sub: '' },
              ].map(opt => (
                <label key={opt.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 14px', borderRadius: 7, cursor: 'pointer', border: `1.5px solid ${fcfMode === opt.id ? 'var(--corsa-green)' : 'var(--border)'}`, background: fcfMode === opt.id ? 'rgba(2,53,48,0.05)' : 'var(--surface)', transition: 'all 0.12s' }}>
                  <input type="radio" name="fcf" checked={fcfMode === opt.id as FcfMode} onChange={() => setFcfMode(opt.id as FcfMode)} style={{ accentColor: 'var(--corsa-green)', marginTop: 2 }}/>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{opt.label}</div>
                    {opt.sub && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>{opt.sub}</div>}
                    {opt.id === 'named' && fcfMode === 'named' && (
                      <input id="fcf-name" value={fcfName} onChange={e => setFcfName(e.target.value)} placeholder="Nombre completo" autoFocus className="corsa-input" style={{ marginTop: 8, width: '100%' }}/>
                    )}
                  </div>
                </label>
              ))}
            </div>
          )}

          {/* CCF search */}
          {docType === 'ccf' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>Busca al cliente para el CCF</div>
              {ccfSelected ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 7, border: '1.5px solid var(--corsa-orange)', background: 'rgba(255,106,40,0.06)' }}>
                  <div style={{ width: 34, height: 34, borderRadius: 6, background: 'var(--corsa-orange)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff' }}>{displayName(ccfSelected).charAt(0)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{displayName(ccfSelected)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>{ccfSelected.nit ? `NIT: ${ccfSelected.nit}` : ccfSelected.dui ? `DUI: ${ccfSelected.dui}` : ''}</div>
                  </div>
                  <button onClick={() => { setCcfSelected(null); setCcfQuery('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>×</button>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', background: 'var(--page-bg)' }}>
                    {ccfLoading ? <div className="spinner" style={{ width: 14, height: 14 }}/> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
                    <input id="ccf-search" value={ccfQuery} onChange={e => setCcfQuery(e.target.value)} placeholder="Nombre, NIT o DUI…" autoFocus style={{ border: 'none', outline: 'none', fontSize: 13.5, flex: 1, background: 'transparent', color: 'var(--text-primary)', fontFamily: 'var(--font-body)' }}/>
                  </div>
                  {ccfResults.length > 0 && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 400, overflow: 'hidden' }}>
                      {ccfResults.map((c, i) => (
                        <button key={c.id} onClick={() => { setCcfSelected(c); setCcfResults([]) }}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', borderBottom: i < ccfResults.length - 1 ? '1px solid var(--border)' : 'none' }}
                          onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'var(--subtle-bg)'}
                          onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
                        >
                          <div style={{ width: 28, height: 28, borderRadius: 5, background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{displayName(c).charAt(0)}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(c)}</div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{c.nit ? `NIT ${c.nit}` : c.dui ? `DUI ${c.dui}` : ''}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '8px 12px', borderRadius: 5 }}>
                El CCF requiere NIT válido. Si el cliente no existe, créalo en Clientes primero.
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="btn btn-ghost">Cancelar</button>
          <div className="clip-btn-wrap" style={{ opacity: canConfirm ? 1 : 0.5, pointerEvents: canConfirm ? 'auto' : 'none' }}>
            <div className="clip-btn-corner"/>
            <button id="billing-confirm" className="clip-btn" onClick={() => { if (docType) onConfirm({ docType, fcfMode: docType === 'ticket' ? fcfMode : undefined, fcfName: fcfMode === 'named' ? fcfName : undefined, ccfCustomer: docType === 'ccf' ? ccfSelected : undefined }) }}>
              Confirmar y cobrar {fmt(total)}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Main POS Page ────────────────────────────────────────────

export function POSPage() {
  const { currentBranch } = useAuth()
  const branchId = (currentBranch as any)?.id ?? null

  // Mode
  const [mode, setMode] = useState<OrderMode>('normal')

  // Normal mode
  const [customer, setCustomer] = useState<CustomerResult | null>(null)
  const [selectedService, setSelectedService] = useState('elite')
  const [selectedSize, setSelectedSize] = useState<SizeId>('M')
  const [withAspirado, setWithAspirado] = useState(false)

  // Fleet mode
  const [showFleetModal, setShowFleetModal] = useState(false)
  const [fleetCompany, setFleetCompany] = useState<FleetCompany | null>(null)
  const [fleetVehicle, setFleetVehicle] = useState<FleetVehicle | null>(null)

  // Payment
  const [selectedPayment, setSelectedPayment] = useState('efectivo')
  const [keypadValue, setKeypadValue] = useState('')
  const [showBillingModal, setShowBillingModal] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Derived prices
  const svc = SERVICES.find(s => s.id === (mode === 'flotilla' ? 'elite' : selectedService))!
  const fleetPrices: Record<SizeId, number> = {
    S: fleetCompany?.elite_price_s ?? 12,
    M: fleetCompany?.elite_price_m ?? 14,
    L: fleetCompany?.elite_price_l ?? 15,
  }
  const servicePrice = mode === 'flotilla' ? (fleetPrices[selectedSize] ?? svc.prices[selectedSize]) : svc.prices[selectedSize]
  const aspiradoPrice = withAspirado ? ADDON_ASPIRADO.price : 0
  const total = servicePrice + aspiradoPrice
  const received = parseFloat(keypadValue) || 0
  const change = Math.max(0, received - total)

  const handleKeypad = (k: string) => {
    if (k === '⌫') { setKeypadValue(v => v.slice(0, -1)); return }
    if (k === '.' && keypadValue.includes('.')) return
    setKeypadValue(v => v + k)
  }

  const handleFleetVehicleSelected = (company: FleetCompany, vehicle: FleetVehicle) => {
    setFleetCompany(company)
    setFleetVehicle(vehicle)
    setShowFleetModal(false)
    setWithAspirado(false)
  }

  const handleModeChange = (m: OrderMode) => {
    setMode(m)
    setFleetCompany(null); setFleetVehicle(null)
    setCustomer(null); setWithAspirado(false); setKeypadValue('')
    if (m === 'flotilla') setShowFleetModal(true)
  }

  const handleBillingConfirm = useCallback(async (billing: BillingInfo) => {
    setShowBillingModal(false)
    setSubmitting(true)
    try {
      await (supabase as any).rpc('create_work_order', {
        p_branch_id:       branchId,
        p_customer_id:     mode === 'flotilla' ? (fleetCompany?.customer_id ?? null) : (customer?.id ?? null),
        p_vehicle_id:      mode === 'flotilla' ? (fleetVehicle?.vehicle_id ?? null) : (customer?.vehicle?.id ?? null),
        p_service_name:    `${svc.name} ${selectedSize}`,
        p_size:            selectedSize,
        p_total:           total,
        p_payment_method:  selectedPayment,
        p_with_aspirado:   withAspirado,
        p_doc_type:        billing.docType,
        p_fcf_name:        billing.fcfName ?? null,
        p_ccf_customer_id: billing.ccfCustomer?.id ?? null,
        p_order_type:      mode,
      })
      toast.success('Orden creada ✓')
      setCustomer(null); setFleetCompany(null); setFleetVehicle(null)
      setMode('normal'); setSelectedService('elite'); setSelectedSize('M')
      setWithAspirado(false); setKeypadValue('')
    } catch (err: any) {
      toast.error(err?.message ?? 'Error al crear la orden')
    }
    setSubmitting(false)
  }, [branchId, mode, fleetCompany, fleetVehicle, customer, svc, selectedSize, total, selectedPayment, withAspirado])

  const canCharge = mode === 'flotilla' ? !!fleetVehicle : true

  return (
    <div className="pos-inner">

      {/* Title */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 24, margin: 0, color: 'var(--text-primary)' }}>Nueva orden</h1>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Selecciona el tipo de servicio para continuar</div>
      </div>

      {/* ── Mode selector (3 cards) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {[
          {
            id: 'normal' as const,
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="2" y="7" width="20" height="13" rx="1.5"/><path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><line x1="2" y1="12" x2="22" y2="12"/></svg>,
            label: 'Normal',
            sub: 'Cliente que paga servicio completo',
            color: 'var(--corsa-green)',
          },
          {
            id: 'flotilla' as const,
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="1" y="7" width="14" height="10"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></svg>,
            label: 'Flotilla Corp.',
            sub: 'Precio especial ÉLITE negociado',
            color: 'var(--corsa-orange)',
          },
          {
            id: 'membresia' as const,
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="8" r="5"/><polyline points="8.5 13 7 22 12 19 17 22 15.5 13"/></svg>,
            label: 'Membresía',
            sub: 'Próximamente disponible',
            color: 'var(--text-secondary)',
            disabled: true,
          },
        ].map(opt => (
          <button
            key={opt.id}
            id={`mode-${opt.id}`}
            onClick={() => !opt.disabled && handleModeChange(opt.id)}
            disabled={opt.disabled}
            style={{
              padding: '14px 16px', borderRadius: 8, cursor: opt.disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
              border: `2px solid ${mode === opt.id ? opt.color : 'var(--border)'}`,
              background: mode === opt.id ? `${opt.color}0D` : 'var(--surface)',
              opacity: opt.disabled ? 0.5 : 1,
              transition: 'all 0.12s', display: 'flex', alignItems: 'flex-start', gap: 12,
            }}
          >
            <div style={{ color: mode === opt.id ? opt.color : 'var(--text-secondary)', marginTop: 2, flexShrink: 0 }}>{opt.icon}</div>
            <div>
              <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 15, color: mode === opt.id ? opt.color : 'var(--text-primary)' }}>
                {opt.label}
                {mode === opt.id && <span style={{ marginLeft: 6, fontSize: 11, color: opt.color }}>●</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{opt.sub}</div>
            </div>
          </button>
        ))}
      </div>

      {/* ── Fleet selected info ── */}
      {mode === 'flotilla' && fleetVehicle && fleetCompany && (
        <div style={{ background: 'rgba(255,106,40,0.08)', border: '1.5px solid var(--corsa-orange)', borderRadius: 8, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ width: 42, height: 42, borderRadius: 7, background: 'var(--corsa-orange)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"><path d="M5 17H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1l2-4h10l2 4h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', letterSpacing: 0.5 }}>{fleetVehicle.plate}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              {[fleetVehicle.brand, fleetVehicle.model, fleetVehicle.year, fleetVehicle.color].filter(Boolean).join(' · ')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--corsa-orange)', fontWeight: 600, marginTop: 2 }}>{fleetCompany.trade_name}</div>
          </div>
          <button onClick={() => setShowFleetModal(true)} className="btn btn-ghost" style={{ fontSize: 12.5 }}>Cambiar vehículo</button>
        </div>
      )}

      {mode === 'flotilla' && !fleetVehicle && (
        <div style={{ border: '1.5px dashed var(--border)', borderRadius: 8, padding: '20px', textAlign: 'center' }}>
          <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 10 }}>Selecciona el vehículo de la flotilla corporativa</div>
          <button className="btn btn-primary" onClick={() => setShowFleetModal(true)}>Seleccionar vehículo</button>
        </div>
      )}

      {/* ── Main layout (only when ready) ── */}
      {(mode === 'normal' || (mode === 'flotilla' && fleetVehicle)) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>

          {/* Col 1: Customer (only normal mode) */}
          {mode === 'normal' && (
            <div style={{ flex: '0 0 280px' }}>
              <CustomerSearchPanel selected={customer} onSelect={setCustomer} onClear={() => setCustomer(null)}/>
            </div>
          )}

          {/* Col 2: Services */}
          <div style={{ flex: '1 1 360px', display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Size */}
            <div className="card" style={{ padding: 12 }}>
              <div className="panel-section-label" style={{ marginBottom: 8 }}>Tamaño del vehículo</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {SIZES.map(sz => (
                  <button key={sz.id} id={`size-${sz.id}`} onClick={() => setSelectedSize(sz.id)}
                    style={{ flex: 1, padding: '11px 8px', borderRadius: 6, cursor: 'pointer', textAlign: 'center', border: `2px solid ${selectedSize === sz.id ? 'var(--corsa-green)' : 'var(--border)'}`, background: selectedSize === sz.id ? 'var(--corsa-green)' : 'var(--surface)', color: selectedSize === sz.id ? '#fff' : 'var(--text-primary)', transition: 'all 0.12s' }}>
                    <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 20 }}>{sz.label}</div>
                    <div style={{ fontSize: 11, marginTop: 1, opacity: 0.8 }}>{sz.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Services (ÉLITE fixed for flotilla) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SERVICES.filter(s => mode === 'flotilla' ? s.id === 'elite' : true).map(s => {
                const tc2 = TIER_COLORS[s.tier]
                const isSel = (mode === 'flotilla' ? 'elite' : selectedService) === s.id
                const isFleet = mode === 'flotilla' && s.id === 'elite'
                const displayPrices = isFleet ? fleetPrices : s.prices
                return (
                  <div key={s.id} id={`svc-${s.id}`}
                    onClick={() => mode !== 'flotilla' && setSelectedService(s.id)}
                    role={mode !== 'flotilla' ? 'button' : undefined} tabIndex={mode !== 'flotilla' ? 0 : undefined}
                    style={{ border: `2px solid ${isSel ? tc2.accent : 'var(--border)'}`, borderRadius: 8, padding: 14, background: isSel ? `${tc2.accent}09` : 'var(--surface)', cursor: mode !== 'flotilla' ? 'pointer' : 'default', transition: 'all 0.12s', position: 'relative' }}
                  >
                    {s.recommended && mode !== 'flotilla' && (
                      <div style={{ position: 'absolute', top: -1, right: 14, background: '#8B5A2B', color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', padding: '3px 7px', borderRadius: '0 0 5px 5px' }}>RECOMENDADO</div>
                    )}
                    {isFleet && (
                      <div style={{ position: 'absolute', top: -1, right: 14, background: 'var(--corsa-orange)', color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', padding: '3px 7px', borderRadius: '0 0 5px 5px' }}>PRECIO FLOTILLA</div>
                    )}
                    {isSel && <div style={{ position: 'absolute', top: 12, left: -2, width: 4, height: 'calc(100% - 24px)', background: tc2.accent, borderRadius: '0 2px 2px 0' }}/>}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 19, color: isSel ? tc2.accent : 'var(--text-primary)' }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, maxWidth: 260 }}>{s.description}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginLeft: 12 }}>
                        {SIZES.map(sz => (
                          <div key={sz.id} style={{ textAlign: 'center', opacity: selectedSize === sz.id ? 1 : 0.38, transition: 'opacity 0.12s' }}>
                            <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: selectedSize === sz.id ? 800 : 600, fontSize: selectedSize === sz.id ? 22 : 16, color: isSel && selectedSize === sz.id ? tc2.accent : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                              ${displayPrices[sz.id]}
                            </div>
                            <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontWeight: 600 }}>{sz.id}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Aspirado add-on */}
            <div className="card" style={{ padding: 12 }}>
              <div className="panel-section-label" style={{ marginBottom: 8 }}>Servicio adicional</div>
              <button id="addon-aspirado" onClick={() => setWithAspirado(v => !v)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 6, border: `2px solid ${withAspirado ? 'var(--corsa-orange)' : 'var(--border)'}`, background: withAspirado ? 'rgba(255,106,40,0.08)' : 'var(--surface)', cursor: 'pointer', transition: 'all 0.12s', textAlign: 'left' }}>
                <div style={{ width: 20, height: 20, borderRadius: 4, flexShrink: 0, border: `2px solid ${withAspirado ? 'var(--corsa-orange)' : 'var(--border)'}`, background: withAspirado ? 'var(--corsa-orange)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {withAspirado && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{ADDON_ASPIRADO.label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>Sin importar tamaño del vehículo</div>
                </div>
                <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 18, color: withAspirado ? 'var(--corsa-orange)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>+$3</div>
              </button>
            </div>
          </div>

          {/* Col 3: Cobro */}
          <div className="card" style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
            <div className="panel-section-label">Resumen</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{svc.name} · {selectedSize}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {SIZES.find(s => s.id === selectedSize)?.sub}
                    {mode === 'flotilla' && <span style={{ color: 'var(--corsa-orange)', marginLeft: 5 }}>· Precio flotilla</span>}
                  </div>
                </div>
                <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 20, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(servicePrice)}</div>
              </div>
              {withAspirado && (
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>Aspirado</div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--corsa-orange)', fontVariantNumeric: 'tabular-nums' }}>+{fmt(aspiradoPrice)}</div>
                </div>
              )}
            </div>

            <div className="divider"/>

            {/* Cliente */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 5, background: 'var(--subtle-bg)', fontSize: 12, color: 'var(--text-secondary)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {mode === 'flotilla' ? (fleetCompany?.trade_name ?? 'Flotilla') : displayName(customer)}
              </span>
            </div>

            <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 28, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 14 }}>Total</span>
              {fmt(total)}
            </div>

            {/* Pago */}
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 7 }}>Método de pago</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {PAYMENT_METHODS.map(pm => (
                  <button key={pm.id} id={`pay-${pm.id}`} onClick={() => setSelectedPayment(pm.id)}
                    style={{ padding: '6px 10px', borderRadius: 5, fontSize: 12, fontWeight: 500, border: `1px solid ${selectedPayment === pm.id ? 'var(--corsa-green)' : 'var(--border)'}`, background: selectedPayment === pm.id ? 'var(--corsa-green)' : 'var(--surface)', color: selectedPayment === pm.id ? '#fff' : 'var(--text-primary)', cursor: 'pointer', transition: 'all 0.12s' }}>
                    {pm.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Keypad */}
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>Monto recibido</div>
              <div style={{ border: '1.5px solid var(--border)', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontFamily: "'Archivo',sans-serif", fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', minHeight: 42, color: 'var(--text-primary)' }}>
                {keypadValue ? `$${keypadValue}` : <span style={{ color: 'var(--border)' }}>$0.00</span>}
              </div>
              <div className="keypad">
                {KEYPAD_KEYS.map(k => (
                  <button key={k} id={`kp-${k}`} className="keypad-key" onClick={() => handleKeypad(k)}>{k}</button>
                ))}
              </div>
              {received > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  <span>Recibido: <strong>{fmt(received)}</strong></span>
                  {received >= total && <span style={{ color: 'var(--color-success-text)', fontWeight: 600 }}>Cambio: {fmt(change)}</span>}
                </div>
              )}
            </div>

            <div className="divider"/>

            <div className="clip-btn-wrap" style={{ opacity: (!canCharge || submitting) ? 0.55 : 1, pointerEvents: (!canCharge || submitting) ? 'none' : 'auto' }}>
              <div className="clip-btn-corner"/>
              <button id="btn-charge" className="clip-btn large" onClick={() => setShowBillingModal(true)} disabled={!canCharge || submitting}>
                {submitting ? 'Procesando…' : `Cobrar ${fmt(total)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fleet Modal */}
      {showFleetModal && (
        <FleetModal
          onVehicleSelected={handleFleetVehicleSelected}
          onCancel={() => { setShowFleetModal(false); if (!fleetVehicle) setMode('normal') }}
        />
      )}

      {/* Billing Modal */}
      {showBillingModal && (
        <BillingModal
          total={total}
          paymentMethod={selectedPayment}
          onConfirm={handleBillingConfirm}
          onCancel={() => setShowBillingModal(false)}
        />
      )}
    </div>
  )
}
