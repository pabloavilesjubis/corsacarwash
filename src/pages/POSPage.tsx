/**
 * CORSA Carwash — POS Nueva orden
 * Modos: Normal · Flotilla Corporativa · Membresía
 * Servicios: PRO · ÉLITE · SIGNATURE  (S / M / L)
 * Add-on: Aspirado de interiores — $3 de lista, o el precio negociado si la
 *          flotilla tiene uno cargado (fleet_pricing)
 * Modal de cobro: Ticket (FCF) o CCF
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import {
  ccfReceptorStatus, fcfReceptorStatus, preferredDocType, type ReceptorStatus,
} from '../lib/fiscal/receptor'
import { FCF_IDENTIFICACION_OBLIGATORIA_DESDE } from '../lib/mh-catalogs'
import { printCorsaTicket } from '../lib/ticket/corsaTicket'
import { buildTicketArgsFromPos, EMISOR, type PosSaleResult } from '../lib/ticket/fromSale'
import { lookupVoucher, redeemVoucher, type VoucherLookup } from '../services/vouchers.service'

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

/**
 * Columnas del cliente que el POS necesita para facturar.
 * Una sola constante para las tres consultas (nombre, placa y buscador de CCF):
 * si una se quedara corta, el modal mostraría datos fiscales vacíos y el cajero
 * creería que la ficha está incompleta.
 */
const CUSTOMER_COLUMNS =
  'id,customer_type,first_name,last_name,trade_name,legal_name,dui,nit,nrc,email,phone,' +
  'fiscal_document_type,fiscal_doc_type,fiscal_doc_number,cod_actividad,desc_actividad,' +
  'fiscal_departamento,fiscal_municipio,fiscal_complemento,billing_email'

interface CustomerResult {
  id: string
  customer_type: 'individual' | 'company'
  first_name?: string; last_name?: string
  trade_name?: string; legal_name?: string
  dui?: string; nit?: string; nrc?: string
  email?: string; phone?: string
  // Fiscales — ver 0029_customer_fiscal_dte.sql
  fiscal_document_type?: string | null
  fiscal_doc_type?: string | null
  fiscal_doc_number?: string | null
  cod_actividad?: string | null
  desc_actividad?: string | null
  fiscal_departamento?: string | null
  fiscal_municipio?: string | null
  fiscal_complemento?: string | null
  billing_email?: string | null
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
  /** El aspirado se negocia aparte y a precio único, sin importar el tamaño. */
  aspirado_enabled: boolean
  aspirado_price: number | null
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
        // Precios desde fleet_pricing (0031); antes había que parsear el JSON
        // que se guardaba en fleet_contracts.terms.
        const { data: fleets } = await (supabase as any)
          .from('fleets')
          .select(`id, name, customer_id,
                   customers(id, trade_name, legal_name, nit),
                   fleet_pricing(elite_per_size, elite_price, elite_price_s, elite_price_m, elite_price_l, aspirado_enabled, aspirado_price)`)
          .eq('organization_id', orgId)
          .eq('active', true)

        setCompanies((fleets ?? []).map((f: any) => {
          const c = f.customers ?? {}
          const fp = Array.isArray(f.fleet_pricing) ? f.fleet_pricing[0] : f.fleet_pricing
          // Sin acuerdo cargado se usan los precios de lista del catálogo.
          const lista = SERVICES.find(x => x.tier === 'elite')!.prices
          const prices = !fp
            ? { s: lista.S, m: lista.M, l: lista.L }
            : fp.elite_per_size
              ? { s: fp.elite_price_s, m: fp.elite_price_m, l: fp.elite_price_l }
              : { s: fp.elite_price, m: fp.elite_price, l: fp.elite_price }

          return {
            customer_id: c.id,
            fleet_id: f.id,
            fleet_name: f.name,
            trade_name: c.trade_name ?? c.legal_name ?? '—',
            nit: c.nit,
            elite_price_s: prices.s,
            elite_price_m: prices.m,
            elite_price_l: prices.l,
            aspirado_enabled: fp?.aspirado_enabled ?? false,
            aspirado_price: fp?.aspirado_price ?? null,
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
            .from('vehicles').select(`id,plate,brand,model,year,color,customer_id,customers(${CUSTOMER_COLUMNS})`)
            .ilike('plate', `%${debouncedQ.replace(/\s/g, '')}%`).limit(6)
          data = (vd ?? []).map((v: any) => ({ ...(v.customers ?? {}), vehicle: { id: v.id, plate: v.plate, brand: v.brand, model: v.model, year: v.year, color: v.color } }))
        } else {
          const { data: cd } = await (supabase as any)
            .from('customers').select(CUSTOMER_COLUMNS)
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

// ─── Panel de validación del receptor ─────────────────────────

/**
 * Muestra, campo por campo, los datos con los que se va a emitir el DTE.
 * El cajero los valida antes de cobrar en vez de enterarse de que faltaba algo
 * cuando el MH rechaza el documento, con el cliente esperando en caja.
 */
function ReceptorPanel({ status, title }: { status: ReceptorStatus; title: string }) {
  if (status.fields.length === 0) return null
  return (
    <div style={{ border: `1.5px solid ${status.ok ? 'var(--border)' : 'var(--color-danger-text)'}`, borderRadius: 7, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--subtle-bg)', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: status.ok ? 'var(--color-success-text)' : 'var(--color-danger-text)' }}>
          {status.ok ? 'Listo para facturar' : `Faltan ${status.missing.length}`}
        </span>
      </div>
      <div style={{ padding: '4px 12px 8px' }}>
        {status.fields.map(f => (
          <div key={f.label} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            {/* Un campo opcional vacío no es un error: se marca en gris, no en
                rojo, para que el cajero distinga "falta y bloquea" de
                "no lo tenemos y no importa". */}
            <span style={{
              flexShrink: 0, width: 14, fontWeight: 900, fontSize: 12,
              color: !f.required && f.value === '—' ? 'var(--text-secondary)'
                : f.ok ? 'var(--color-success-text)'
                : 'var(--color-danger-text)',
            }}>
              {!f.required && f.value === '—' ? '–' : f.ok ? '✓' : '!'}
            </span>
            <span style={{ flexShrink: 0, width: 108, fontSize: 11.5, color: 'var(--text-secondary)' }}>{f.label}</span>
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
              {f.value}
              {!f.ok && f.hint && (
                <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-danger-text)', marginTop: 1 }}>{f.hint}</div>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Billing Modal ────────────────────────────────────────────

interface BillingModalProps {
  total: number; paymentMethod: string
  /** Cliente ya elegido en la caja; de ahí sale todo lo prellenado. */
  customer: CustomerResult | null
  onConfirm: (billing: BillingInfo) => void
  onCancel: () => void
}

function BillingModal({ total, paymentMethod, customer, onConfirm, onCancel }: BillingModalProps) {
  // Si hay cliente en la caja, el modal abre resuelto: su documento preferido
  // ya elegido y sus datos cargados. El cajero valida o corrige, no transcribe.
  const [docType, setDocType] = useState<DocType>(
    customer ? preferredDocType(customer) : null
  )
  const [fcfMode, setFcfMode] = useState<FcfMode>(
    customer && preferredDocType(customer) === 'ticket' ? 'named' : 'generic'
  )
  const [fcfName, setFcfName] = useState(
    customer ? displayName(customer) : ''
  )
  const [ccfQuery, setCcfQuery] = useState('')
  const [ccfResults, setCcfResults] = useState<CustomerResult[]>([])
  const [ccfSelected, setCcfSelected] = useState<CustomerResult | null>(
    customer && preferredDocType(customer) === 'ccf' ? customer : null
  )
  const [ccfLoading, setCcfLoading] = useState(false)
  const debouncedCcf = useDebounce(ccfQuery, 350)

  useEffect(() => {
    if (debouncedCcf.length < 2) { setCcfResults([]); return }
    setCcfLoading(true)
    ;(async () => {
      const { data } = await (supabase as any).from('customers')
        .select(CUSTOMER_COLUMNS)
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

  // El receptor efectivo: para CCF el buscado en el modal, para ticket el de la caja.
  const ccfStatus = ccfSelected ? ccfReceptorStatus(ccfSelected) : null
  const fcfStatus = fcfReceptorStatus(customer, total)

  // Antes alcanzaba con haber elegido un cliente para el CCF. Pero un cliente
  // puede tener NIT y aun así no poder recibir un CCF (sin NRC, sin actividad,
  // sin dirección): el DTE se rechazaba al transmitir. Ahora se exige el
  // receptor completo, y el panel de arriba dice exactamente qué falta.
  const canConfirm =
    docType === 'ticket' ? fcfStatus.ok
    : docType === 'ccf'  ? Boolean(ccfSelected && ccfStatus?.ok)
    : false

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
                      <input id="fcf-name" value={fcfName} onChange={e => setFcfName(e.target.value)} placeholder="Nombre completo" className="corsa-input" style={{ marginTop: 8, width: '100%' }}/>
                    )}
                  </div>
                </label>
              ))}

              {/* Siempre visible: el cajero confirma los datos con el cliente
                  antes de cobrar. Sobre el umbral del MH, además, bloquean. */}
              <ReceptorPanel
                status={fcfStatus}
                title={total >= FCF_IDENTIFICACION_OBLIGATORIA_DESDE
                  ? `Datos del ticket · identificación exigida sobre US$${FCF_IDENTIFICACION_OBLIGATORIA_DESDE.toFixed(2)}`
                  : 'Datos con los que se emitirá el ticket'}
              />
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
              {ccfSelected && ccfStatus && (
                <ReceptorPanel status={ccfStatus} title="Datos con los que se emitirá el CCF"/>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '8px 12px', borderRadius: 5 }}>
                {ccfStatus && !ccfStatus.ok
                  ? `Faltan datos en la ficha: ${ccfStatus.missing.join(', ')}. Completalos en Clientes y volvé a intentar.`
                  : 'El CCF requiere el receptor completo. Si el cliente no existe, créalo en Clientes primero.'}
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

// ─── Modal: cobrar con cupón ──────────────────────────────────

/**
 * Canje en caja. El cajero teclea el número, ve qué incluye el cupón y recién
 * entonces confirma: canjear es irreversible y de un solo uso, así que se
 * consulta antes de consumir.
 */
function VoucherRedeemModal({ branchId, onRedeemed, onCancel }: {
  branchId: string
  onRedeemed: (r: Awaited<ReturnType<typeof redeemVoucher>>, v: VoucherLookup) => void
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const [buscando, setBuscando] = useState(false)
  const [found, setFound] = useState<VoucherLookup | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [canjeando, setCanjeando] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  const buscar = async () => {
    if (!code.trim()) return
    setBuscando(true); setFound(null); setNotFound(false)
    try {
      const v = await lookupVoucher(code)
      if (v) setFound(v); else setNotFound(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo consultar el cupón')
    }
    setBuscando(false)
  }

  const canjear = async () => {
    if (!found) return
    setCanjeando(true)
    try {
      const r = await redeemVoucher(found.code, branchId)
      onRedeemed(r, found)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo canjear el cupón')
      setCanjeando(false)
    }
  }

  const usable = found?.status === 'active'

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 19 }}>Cobrar con cupón</div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label>Número de cupón (6 dígitos)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="voucher-code"
                className="corsa-input font-mono"
                style={{ fontSize: 20, fontWeight: 800, letterSpacing: 2, textAlign: 'center' }}
                value={code}
                autoFocus
                inputMode="numeric"
                placeholder="123456"
                onChange={e => { setCode(e.target.value); setFound(null); setNotFound(false) }}
                onKeyDown={e => { if (e.key === 'Enter') buscar() }}
              />
              <button className="btn btn-ghost" onClick={buscar} disabled={buscando || !code.trim()}>
                {buscando ? '…' : 'Validar'}
              </button>
            </div>
          </div>

          {notFound && (
            <div style={{ fontSize: 13, color: 'var(--color-danger-text)', background: 'var(--color-danger-bg, #FBE7E7)', padding: '10px 12px', borderRadius: 6 }}>
              No existe ningún cupón con ese número.
            </div>
          )}

          {found && (
            <div style={{
              border: `2px solid ${usable ? 'var(--corsa-green)' : 'var(--color-danger-text)'}`,
              borderRadius: 8, padding: '12px 14px',
              background: usable ? 'rgba(2,53,48,0.05)' : 'var(--color-danger-bg, #FBE7E7)',
            }}>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>
                {usable ? 'Cupón válido' : found.status === 'redeemed' ? 'Ya fue canjeado' : 'Cupón anulado'}
              </div>
              <div className="panel-row"><span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Servicio</span>
                <span style={{ fontWeight: 700, fontSize: 12.5 }}>{found.service_name} {found.size}</span></div>
              <div className="panel-row"><span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Aspirado</span>
                <span style={{ fontWeight: 700, fontSize: 12.5 }}>{found.includes_aspirado ? 'Incluido' : 'No incluye'}</span></div>
              <div className="panel-row"><span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Cliente</span>
                <span style={{ fontWeight: 600, fontSize: 12.5 }}>{found.customer_name}</span></div>
              {found.status === 'redeemed' && found.redeemed_at && (
                <div style={{ fontSize: 12, color: 'var(--color-danger-text)', marginTop: 6 }}>
                  Canjeado el {new Date(found.redeemed_at).toLocaleString('es-SV')}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: '16px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="btn btn-ghost">Cancelar</button>
          <button
            onClick={canjear}
            disabled={!usable || canjeando}
            style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', background: usable ? 'var(--corsa-green)' : 'var(--text-secondary)', borderRadius: 5, padding: '9px 16px', border: 'none', cursor: usable ? 'pointer' : 'not-allowed', opacity: usable ? 1 : 0.5 }}
          >
            {canjeando ? 'Canjeando…' : 'Canjear e imprimir'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Main POS Page ────────────────────────────────────────────

export function POSPage() {
  const { currentBranch, hasPermission } = useAuth()
  const puedeCanjearCupon = hasPermission('vouchers.redeem')
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
  const [showVoucherModal, setShowVoucherModal] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Derived prices
  const svc = SERVICES.find(s => s.id === (mode === 'flotilla' ? 'elite' : selectedService))!
  const fleetPrices: Record<SizeId, number> = {
    S: fleetCompany?.elite_price_s ?? 12,
    M: fleetCompany?.elite_price_m ?? 14,
    L: fleetCompany?.elite_price_l ?? 15,
  }
  const servicePrice = mode === 'flotilla' ? (fleetPrices[selectedSize] ?? svc.prices[selectedSize]) : svc.prices[selectedSize]
  // En flotilla manda el precio negociado; si no hay acuerdo, la tarifa de lista.
  const usaAspiradoFlotilla = mode === 'flotilla'
    && Boolean(fleetCompany?.aspirado_enabled)
    && fleetCompany?.aspirado_price != null
  const aspiradoUnit = usaAspiradoFlotilla
    ? Number(fleetCompany!.aspirado_price)
    : ADDON_ASPIRADO.price
  const aspiradoPrice = withAspirado ? aspiradoUnit : 0
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
    // Si el acuerdo de la flotilla incluye aspirado, viene marcado: es parte
    // del servicio contratado y olvidarlo significa no cobrarlo. El cajero
    // puede destildarlo si el cliente lo rechaza.
    setWithAspirado(Boolean(company.aspirado_enabled))
  }

  const handleModeChange = (m: OrderMode) => {
    setMode(m)
    setFleetCompany(null); setFleetVehicle(null)
    setCustomer(null); setWithAspirado(false); setKeypadValue('')
    if (m === 'flotilla') setShowFleetModal(true)
  }

  /**
   * Canje de cupón. No pasa por pos_register_sale: el cobro ocurrió el día que
   * se vendió el cupón, así que acá sólo se registra el servicio prestado y se
   * imprime un comprobante sin contenido tributario.
   */
  const handleVoucherRedeemed = useCallback((
    r: { code: string; order_number: string; service_name: string; size: string | null; includes_aspirado: boolean; unit_value: number; redeemed_at: string; order_id: string },
    v: VoucherLookup,
  ) => {
    setShowVoucherModal(false)
    try {
      printCorsaTicket({
        emisor: EMISOR,
        operacion: {
          servicio: r.service_name,
          aspirado: r.includes_aspirado,
          ordenNumero: r.order_number,
        },
        venta: { id: r.order_id, fecha: r.redeemed_at, lineas: [], total: 0 },
        redencion: {
          codigoCupon: r.code,
          clienteNombre: v.customer_name,
          valor: Number(r.unit_value || 0),
          fecha: new Date(r.redeemed_at).toLocaleString('es-SV'),
        },
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'El canje se registró, pero no se pudo abrir el ticket')
    }
    toast.success(`Cupón ${r.code} canjeado · orden ${r.order_number}`)
  }, [])

  const handleBillingConfirm = useCallback(async (billing: BillingInfo) => {
    setShowBillingModal(false)
    setSubmitting(true)
    try {
      // pos_register_sale (0030) reemplaza a create_work_order: aquella se
      // llamaba con parámetros que no existían en ninguna migración, así que
      // el cobro fallaba y ninguna venta llegaba a guardarse.
      const { data, error } = await (supabase as any).rpc('pos_register_sale', {
        p_branch_id:       branchId,
        p_service_code:    svc.tier.toUpperCase(),
        p_size:            selectedSize,
        p_total:           total,
        p_payment_method:  selectedPayment,
        p_with_aspirado:   withAspirado,
        p_aspirado_price:  aspiradoPrice,
        p_customer_id:     mode === 'flotilla' ? (fleetCompany?.customer_id ?? null) : (customer?.id ?? null),
        p_vehicle_id:      mode === 'flotilla' ? (fleetVehicle?.vehicle_id ?? null) : (customer?.vehicle?.id ?? null),
        p_doc_type:        billing.docType,
        p_fcf_name:        billing.fcfName ?? null,
        p_ccf_customer_id: billing.ccfCustomer?.id ?? null,
        p_order_type:      mode,
      })
      if (error) throw error

      const sale = data as PosSaleResult
      const receptor = billing.ccfCustomer ?? customer

      // El ticket se abre solo: es el comprobante y a la vez la orden que lee
      // el equipo en piso. Si el navegador bloquea la ventana emergente el
      // cobro ya quedó registrado, así que sólo se avisa — no se revierte.
      try {
        printCorsaTicket(buildTicketArgsFromPos(sale, {
          clienteNombre: billing.fcfName ?? (receptor ? displayName(receptor) : undefined),
          clienteDoc: receptor
            ? { tipo: receptor.nit ? 'NIT' : 'DUI', numero: receptor.nit ?? receptor.dui, nrc: receptor.nrc }
            : undefined,
          placa: mode === 'flotilla' ? fleetVehicle?.plate : customer?.vehicle?.plate,
          vehiculo: customer?.vehicle
            ? [customer.vehicle.brand, customer.vehicle.model, customer.vehicle.color].filter(Boolean).join(' ')
            : undefined,
          metodoPago: PAYMENT_METHODS.find(p => p.id === selectedPayment)?.label,
          aspiradoPrecio: aspiradoPrice,
          branchName: (currentBranch as any)?.name,
        }))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'La venta se guardó, pero no se pudo abrir el ticket')
      }

      toast.success(`Venta ${sale.order_number} registrada ✓`)
      setCustomer(null); setFleetCompany(null); setFleetVehicle(null)
      setMode('normal'); setSelectedService('elite'); setSelectedSize('M')
      setWithAspirado(false); setKeypadValue('')
    } catch (err: any) {
      toast.error(err?.message ?? 'Error al crear la orden')
    }
    setSubmitting(false)
  }, [branchId, mode, fleetCompany, fleetVehicle, customer, svc, selectedSize, total, selectedPayment, withAspirado, aspiradoPrice, currentBranch])

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
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>
                    Sin importar tamaño del vehículo
                    {usaAspiradoFlotilla && (
                      <span style={{ color: 'var(--corsa-orange)' }}> · Incluido en el plan de la flotilla</span>
                    )}
                  </div>
                </div>
                {/* El importe estaba escrito a mano como "+$3": la tarjeta
                    mostraba la tarifa de lista aunque la flotilla tuviera otra
                    negociada, y sólo el resumen reflejaba el precio real. */}
                <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 18, color: withAspirado ? 'var(--corsa-orange)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                  +{fmt(aspiradoUnit)}
                </div>
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

            {/* Canje de cupón. En caja sólo se canjean cupones ya emitidos:
                venderlos es cobrar por adelantado y vive en el POS
                Administrativo, al que el cajero no entra. */}
            {puedeCanjearCupon && (
              <button
                id="btn-voucher"
                className="btn btn-ghost"
                style={{ width: '100%', marginTop: 8 }}
                onClick={() => setShowVoucherModal(true)}
                disabled={submitting}
              >
                Cobrar con cupón
              </button>
            )}
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
      {showVoucherModal && branchId && (
        <VoucherRedeemModal
          branchId={branchId}
          onRedeemed={handleVoucherRedeemed}
          onCancel={() => setShowVoucherModal(false)}
        />
      )}
      {showBillingModal && (
        <BillingModal
          customer={customer}
          total={total}
          paymentMethod={selectedPayment}
          onConfirm={handleBillingConfirm}
          onCancel={() => setShowBillingModal(false)}
        />
      )}
    </div>
  )
}
