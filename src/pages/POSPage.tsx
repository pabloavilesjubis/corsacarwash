/**
 * CORSA Carwash — POS Nueva orden
 * Modos: Normal · Flotilla Corporativa · Membresía
 * Servicios: PRO · ÉLITE · SIGNATURE  (S / M / L)
 * Flotilla: los servicios que la flotilla negoció (PRO, ÉLITE y/o SIGNATURE),
 *           a su precio (fleet_service_prices, 0050)
 * Add-on: Aspirado de interiores — $3 de lista, o el precio negociado si la
 *          flotilla tiene uno cargado (fleet_pricing)
 * Modal de cobro: Ticket (FCF) o CCF
 */

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { useEsMovil } from '../hooks/useEsMovil'
import { supabase } from '../lib/supabase'
import {
  ccfReceptorStatus, fcfReceptorStatus, preferredDocType, type ReceptorStatus,
} from '../lib/fiscal/receptor'
import { FCF_IDENTIFICACION_OBLIGATORIA_DESDE } from '../lib/mh-catalogs'
import { imprimirTicketEnSegundoPlano } from '../lib/ticket/corsaTicket'
import { emitirConFirmaLocal, posEmiteDte } from '../services/fiscal.service'
import { fetchDteDeVenta, type DteDeVenta } from '../services/sales.service'
import { buildTicketArgsFromPos, buildTicketSeguroDeVenta, type PosSaleResult } from '../lib/ticket/fromSale'
import { cargarEmisor, emisorParaTicket, MARCA } from '../lib/fiscal/emisor'
import { lookupVoucher, redeemVoucher, type VoucherLookup } from '../services/vouchers.service'
import { darCortesia, fetchPolizaVigente, tiempoRestante, type RainPolicy } from '../services/rain.service'
import { ModalCortesiaSeguro } from '../components/pos/CortesiaSeguro'
import { cargarAcuerdoGrupo } from '../lib/grupos/grupos'
import type { AcuerdoFlotilla } from '../lib/flotillas/precios'
import {
  getCustomerVehicles, fetchMapaTamanos, type TamanoVehiculo,
} from '../services/customers.service'
import {
  ModalNuevoCliente, ModalNuevoVehiculo, SelectorVehiculos, type VehiculoPos,
} from '../components/pos/AltaRapida'
import { formatearFechaHora } from '../utils/fecha'
import { cargarAcuerdos, PRECIOS_LISTA, type CodigoServicio } from '../lib/flotillas/precios'

/**
 * Cuánto espera el POS el sello antes de imprimir sin él. Hacienda suele
 * contestar en uno o dos segundos; pasado esto, tener al cliente parado en la
 * caja cuesta más que imprimir el DTE como pendiente.
 */
const ESPERA_DTE_MS = 20_000

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
    prices: PRECIOS_LISTA.PRO,
  },
  {
    id: 'elite', name: 'ÉLITE', tier: 'elite' as const,
    description: 'PRO + acabado superior con acondicionador de pintura',
    prices: PRECIOS_LISTA.ELITE,
  },
  {
    id: 'signature', name: 'SIGNATURE', tier: 'signature' as const,
    description: 'Experiencia completa con acondicionador de pintura y cera protectora',
    prices: PRECIOS_LISTA.SIGNATURE,
    recommended: true,
  },
]

const ADDON_ASPIRADO = { id: 'aspirado', label: 'Aspirado de interiores', price: 3 }

/**
 * Seguro de lluvia: $2.00 por 48 horas de cobertura.
 *
 * Las 48 horas NO se calculan acá. El servidor emite la póliza con su propio
 * reloj (0039) y devuelve la vigencia; esta pantalla sólo la muestra y la
 * imprime. Si el vencimiento saliera del navegador, dos cajas con la hora
 * corrida emitirían coberturas distintas por el mismo precio.
 */
const ADDON_SEGURO = { id: 'seguro_lluvia', label: 'Seguro de lluvia', price: 2, horas: 48 }
const PAYMENT_METHODS = [
  { id: 'efectivo',      label: 'Efectivo'      },
  { id: 'tarjeta',       label: 'Tarjeta'        },
  { id: 'transferencia', label: 'Transferencia'  },
  { id: 'membresia',     label: 'Membresía'      },
  { id: 'credito',       label: 'Crédito emp.'   },
  // El cupón se paga por adelantado: elegirlo acá reemplaza el teclado del
  // monto por el del número de cupón, y el cobro pasa a ser un canje.
  { id: 'cupon',         label: 'Cupón'          },
]
const KEYPAD_KEYS = ['1','2','3','4','5','6','7','8','9','.','0','⌫']

/**
 * Los tres niveles, en la escala nueva.
 *
 * PRO es tinta, ELITE el lima —el acento de la marca— y SIGNATURE un verde
 * profundo: es el único punto de la interfaz donde hacía falta un tercer
 * color, porque los tres tienen que distinguirse entre sí de un vistazo y el
 * gris no alcanza para el más caro.
 */
const TIER_COLORS = {
  pro:       { accent: 'var(--corsa-green)' },
  elite:     { accent: 'var(--corsa-orange)' },
  signature: { accent: '#2F6B4F' },
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
  'fiscal_departamento,fiscal_municipio,fiscal_complemento,billing_email,business_group_id'

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
  /** Grupo empresarial (0054): placas compartidas, facturar a cualquiera del grupo y sus precios. */
  business_group_id?: string | null
  vehicle?: { id: string; plate: string; brand?: string; model?: string; year?: string; color?: string }
  membership_status?: 'active' | 'expiring' | null
  membership_plan?: string
  lifetime_orders?: number
  days_since_last?: number | null
  ar_overdue?: boolean; ar_amount?: number
}

type ServicioId = 'pro' | 'elite' | 'signature'

interface FleetCompany {
  customer_id: string
  fleet_id: string
  fleet_name: string
  trade_name: string
  nit: string | null
  /**
   * Los servicios que la flotilla negoció, a su precio por tamaño. En modo
   * flotilla el POS ofrece sólo éstos. Una flotilla sin ninguno cargado se
   * cobra como antes de 0050: ÉLITE a tarifa de lista.
   */
  precios: Partial<Record<ServicioId, Record<SizeId, number>>>
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

/** El grupo empresarial del cliente en caja (0054). */
interface GrupoPos {
  id: string
  name: string
  acuerdo: AcuerdoFlotilla
  /** Los clientes del grupo con los datos fiscales (para facturarles) y sus carros. */
  miembros: (CustomerResult & { vehiculos: VehiculoPos[] })[]
}

/** El grupo y sus miembros, con las mismas columnas que el buscador de la caja. */
async function cargarGrupoPos(groupId: string): Promise<GrupoPos | null> {
  const db = supabase as any
  const [{ data: g }, { data: ms }, acuerdo] = await Promise.all([
    db.from('business_groups').select('id, name').eq('id', groupId).maybeSingle(),
    db.from('customers')
      .select(`${CUSTOMER_COLUMNS},vehicles(id,plate,brand,model,color,vehicle_type_id,active)`)
      .eq('business_group_id', groupId).eq('active', true),
    cargarAcuerdoGrupo(groupId),
  ])
  if (!g) return null
  const miembros = (ms ?? []).map((m: any) => ({
    ...m, vehiculos: (m.vehicles ?? []).filter((v: any) => v.active !== false),
  }))
  miembros.sort((a: CustomerResult, b: CustomerResult) => displayName(a).localeCompare(displayName(b)))
  return { id: g.id, name: g.name, acuerdo, miembros }
}

interface BillingInfo {
  docType: 'ticket' | 'ccf'
  fcfMode?: FcfMode
  /** Ticket a nombre de un cliente de la base; null o ausente = genérico. */
  fcfCustomer?: CustomerResult | null
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
  const esMovilModal = useEsMovil()
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
          .select(`id, name, customer_id,
                   customers(id, customer_type, trade_name, legal_name, first_name, last_name, nit)`)
          .eq('organization_id', orgId)
          .eq('active', true)

        // Precios por servicio (0050) y aspirado, de todas las flotillas juntas.
        const acuerdos = await cargarAcuerdos((fleets ?? []).map((f: any) => f.id))

        setCompanies((fleets ?? []).map((f: any) => {
          const c = f.customers ?? {}
          const acuerdo = acuerdos.get(f.id)
          const precios: FleetCompany['precios'] = {}
          for (const codigo of ['PRO', 'ELITE', 'SIGNATURE'] as CodigoServicio[]) {
            const p = acuerdo?.servicios[codigo]
            if (p) precios[codigo.toLowerCase() as ServicioId] = p
          }
          if (Object.keys(precios).length === 0) precios.elite = PRECIOS_LISTA.ELITE

          return {
            customer_id: c.id,
            fleet_id: f.id,
            fleet_name: f.name,
            // Una flotilla puede estar a nombre de una persona natural.
            trade_name: c.customer_type === 'individual'
              ? (c.trade_name || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '—')
              : (c.trade_name ?? c.legal_name ?? '—'),
            nit: c.nit,
            precios,
            aspirado_enabled: acuerdo?.aspirado.activo ?? false,
            aspirado_price: acuerdo?.aspirado.precio ?? null,
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: esMovilModal ? 10 : 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 680, maxHeight: esMovilModal ? '92dvh' : '85vh', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 19, color: 'var(--text-primary)' }}>Seleccionar vehículo de flotilla</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              Se cobran los servicios y precios que negoció la flotilla
            </div>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        {/* En el teléfono las dos columnas del selector se apilan: 260 px de
            empresas dejarían 130 para los vehículos, que es menos que una placa. */}
        <div style={{ display: 'flex', flexDirection: esMovilModal ? 'column' : 'row', flex: 1, overflow: 'hidden' }}>

          {/* Left: Companies */}
          <div style={{
            width: esMovilModal ? '100%' : 260,
            maxHeight: esMovilModal ? '38%' : undefined,
            borderRight: esMovilModal ? 'none' : '1px solid var(--border)',
            borderBottom: esMovilModal ? '1px solid var(--border)' : 'none',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <input
                value={searchC}
                onChange={e => setSearchC(e.target.value)}
                placeholder="Buscar empresa…"
                style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 10, padding: '7px 10px', fontSize: 13, background: 'var(--page-bg)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'var(--font-body)' }}
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
                    background: selectedCompany?.fleet_id === c.fleet_id ? 'rgba(22,25,26,0.06)' : 'transparent',
                    borderLeft: selectedCompany?.fleet_id === c.fleet_id ? '3px solid var(--corsa-green)' : '3px solid transparent',
                    transition: 'all 0.1s',
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{c.trade_name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {c.nit ? `NIT ${c.nit}` : 'Sin NIT'}
                  </div>
                  {SERVICES.filter(sv => c.precios[sv.id as ServicioId]).map(sv => {
                    const p = c.precios[sv.id as ServicioId]!
                    return (
                      <div key={sv.id} style={{ fontSize: 11.5, color: 'var(--corsa-orange)', marginTop: 3, fontWeight: 600 }}>
                        {sv.name}: {p.S === p.M && p.M === p.L ? `$${p.M}` : `S$${p.S} · M$${p.M} · L$${p.L}`}
                      </div>
                    )
                  })}
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
                    style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 10, padding: '7px 10px', fontSize: 13, background: 'var(--page-bg)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'var(--font-body)' }}
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
                      <div style={{ width: 38, height: 38, borderRadius: 12, background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
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

function CustomerSearchPanel({ selected, onSelect, onClear, onNuevo }: {
  selected: CustomerResult | null
  onSelect: (c: CustomerResult) => void
  onClear: () => void
  onNuevo: () => void
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
          // Una empresa puede tener sólo razón social (sin nombre comercial):
          // sin legal_name acá no aparecía en caja. Comas y paréntesis rompen
          // el filtro de PostgREST, así que se quitan del texto.
          const q = debouncedQ.replace(/[,()]/g, ' ').trim()
          const { data: cd } = await (supabase as any)
            .from('customers').select(CUSTOMER_COLUMNS)
            .eq('active', true)
            .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,trade_name.ilike.%${q}%,legal_name.ilike.%${q}%,` +
                `nit.ilike.%${q}%,dui.ilike.%${q}%,phone.ilike.%${q}%`).limit(8)
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
    <div className="card" style={{ padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{displayName(selected)}</div>
          {/* La placa ya no se muestra acá: la eligen los vehículos de abajo, y
              repetirla haría dudar de cuál manda. */}
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            {selected.customer_type === 'company' ? 'Empresa' : 'Persona natural'}
            {selected.phone ? ` · ${selected.phone}` : ''}
          </div>
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
    <div className="card" style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 10, background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>Cliente Genérico</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Por defecto · busca para cambiar</div>
        </div>
      </div>
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 12, padding: '8px 11px', background: 'var(--page-bg)' }}>
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
          <div ref={dropRef} style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 50, overflow: 'hidden', maxHeight: 260, overflowY: 'auto' }}>
            {results.map((c, i) => (
              <button key={c.id + i} onClick={() => { onSelect(c); setQuery(''); setOpen(false) }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none' }}
                onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'var(--subtle-bg)'}
                onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
              >
                <div style={{ width: 26, height: 26, borderRadius: 10, background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>
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

      {/* Dar de alta sin salir del POS. Mandar al cajero a la pantalla de
          Clientes con el cliente esperando enfrente significa, en la práctica,
          que nadie lo registra: se cobra como genérico y el carro no queda. */}
      <button onClick={onNuevo}
        style={{
          width: '100%', marginTop: 8, padding: '9px 12px', borderRadius: 12,
          border: '1.5px dashed var(--border)', background: 'transparent',
          color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600,
          cursor: 'pointer', fontFamily: 'var(--font-body)', minHeight: 40,
        }}>
        + Nuevo cliente
      </button>
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
    <div style={{ border: `1.5px solid ${status.ok ? 'var(--border)' : 'var(--color-danger-text)'}`, borderRadius: 14, overflow: 'hidden' }}>
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

// ─── Buscador de receptor ─────────────────────────────────────

/**
 * Busca en Clientes a quién se le emite el documento. Lo usan el ticket y el
 * CCF: antes el ticket sólo tenía un campo de texto libre, así que el nombre
 * escrito no estaba atado a ninguna ficha y no llevaba documento ni correo.
 */
function BuscadorReceptor({ id, elegido, onElegir, color, placeholder }: {
  id: string
  elegido: CustomerResult | null
  onElegir: (c: CustomerResult | null) => void
  color: string
  placeholder: string
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CustomerResult[]>([])
  const [loading, setLoading] = useState(false)
  const debounced = useDebounce(query, 350)

  useEffect(() => {
    if (debounced.length < 2) { setResults([]); return }
    let vivo = true
    setLoading(true)
    ;(async () => {
      // Las personas se buscan por nombre y apellido; las empresas, por
      // nombre comercial o razón social. Las dos, por NIT o DUI.
      const q = debounced.replace(/[,()]/g, ' ').trim()
      const { data } = await (supabase as any).from('customers')
        .select(CUSTOMER_COLUMNS)
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,trade_name.ilike.%${q}%,legal_name.ilike.%${q}%,nit.ilike.%${q}%,dui.ilike.%${q}%`).limit(8)
      if (!vivo) return
      setResults(data ?? [])
      setLoading(false)
    })()
    return () => { vivo = false }
  }, [debounced])

  if (elegido) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 14, border: `1.5px solid ${color}`, background: 'var(--subtle-bg)' }}>
      <div style={{ width: 32, height: 32, borderRadius: 10, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: color === 'var(--corsa-orange)' ? 'var(--on-accent)' : '#fff' }}>{displayName(elegido).charAt(0)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{displayName(elegido)}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>{elegido.nit ? `NIT: ${elegido.nit}` : elegido.dui ? `DUI: ${elegido.dui}` : 'Sin documento en la ficha'}</div>
      </div>
      <button onClick={() => { onElegir(null); setQuery('') }} aria-label="Quitar cliente" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>×</button>
    </div>
  )

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 12, padding: '9px 12px', background: 'var(--page-bg)' }}>
        {loading ? <div className="spinner" style={{ width: 14, height: 14 }}/> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
        <input id={id} value={query} onChange={e => setQuery(e.target.value)} placeholder={placeholder} autoFocus style={{ border: 'none', outline: 'none', fontSize: 13.5, flex: 1, background: 'transparent', color: 'var(--text-primary)', fontFamily: 'var(--font-body)' }}/>
      </div>
      {debounced.length >= 2 && !loading && results.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>Ningún cliente coincide. Si no existe, créalo con «+ Nuevo cliente» en la caja.</div>
      )}
      {results.length > 0 && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 400, overflow: 'hidden', maxHeight: 280, overflowY: 'auto' }}>
          {results.map((c, i) => (
            <button key={c.id} onClick={() => { onElegir(c); setResults([]) }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none' }}
              onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'var(--subtle-bg)'}
              onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
            >
              <div style={{ width: 28, height: 28, borderRadius: 10, background: 'var(--subtle-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{displayName(c).charAt(0)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName(c)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{c.nit ? `NIT ${c.nit}` : c.dui ? `DUI ${c.dui}` : ''}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Modal de cobro ───────────────────────────────────────────

/**
 * Todo lo que se pide al cobrar, en un solo lugar: cómo paga el cliente (a la
 * izquierda) y a nombre de quién va el documento (a la derecha).
 *
 * Antes el método de pago y el teclado vivían debajo del resumen, y el tipo de
 * documento en un modal aparte que se abría después. En la pantalla de 15" de
 * caja ese bloque empujaba el botón de cobrar fuera de la vista. Ahora el
 * resumen es sólo la orden y su total; el cobro se arma acá entero.
 *
 * El estado del pago (método, monto, cupón) sigue viviendo en la página: el
 * canje y el registro de la venta lo leen, y cerrar el modal para corregir un
 * servicio no debería borrar el cupón que ya se tecleó.
 */
interface CobroModalProps {
  total: number
  /** Cliente ya elegido en la caja; de ahí sale todo lo prellenado. */
  customer: CustomerResult | null
  /** Su grupo empresarial: se le puede facturar a cualquiera de sus miembros. */
  grupo: GrupoPos | null
  /** Método de pago, monto y teclado: lo arma la página. */
  pago: ReactNode
  pagaConCupon: boolean
  cuponValido: boolean
  submitting: boolean
  /** Una tecla física del monto (o del cupón), como si fuera del teclado en pantalla. */
  onTecla: (k: string) => void
  onConfirm: (billing: BillingInfo) => void
  onCanjear: () => void
  onCancel: () => void
}

function CobroModal({
  total, customer, grupo, pago, pagaConCupon, cuponValido, submitting, onTecla, onConfirm, onCanjear, onCancel,
}: CobroModalProps) {
  const esMovil = useEsMovil()
  // Si hay cliente en la caja, el modal abre resuelto: su documento preferido
  // ya elegido y sus datos cargados. El cajero valida o corrige, no transcribe.
  // Sin cliente, el ticket genérico: es la venta de mostrador de todos los días.
  const [docType, setDocType] = useState<DocType>(
    customer ? preferredDocType(customer) : 'ticket'
  )
  const [fcfMode, setFcfMode] = useState<FcfMode>(
    customer && preferredDocType(customer) === 'ticket' ? 'named' : 'generic'
  )
  const [fcfCliente, setFcfCliente] = useState<CustomerResult | null>(
    customer && preferredDocType(customer) === 'ticket' ? customer : null
  )
  const [ccfSelected, setCcfSelected] = useState<CustomerResult | null>(
    customer && preferredDocType(customer) === 'ccf' ? customer : null
  )

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  // La caja tiene teclado: el monto se puede escribir sin tocar la pantalla.
  // Se ignora mientras el foco está en un campo (la búsqueda del cliente),
  // que es donde esas teclas sí tienen que caer.
  const teclaRef = useRef(onTecla)
  useEffect(() => { teclaRef.current = onTecla })
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = /^[0-9]$/.test(e.key) ? e.key
        : e.key === '.' || e.key === ',' ? '.'
        : e.key === 'Backspace' ? '⌫'
        : null
      if (!k) return
      e.preventDefault()
      teclaRef.current(k)
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  // El receptor efectivo es el elegido en el modal; el de la caja sólo lo
  // prellena. Un ticket genérico no tiene receptor.
  const ccfStatus = ccfSelected ? ccfReceptorStatus(ccfSelected) : null
  const fcfReceptor = fcfMode === 'named' ? fcfCliente : null
  const fcfStatus = fcfReceptorStatus(fcfReceptor, total)

  // Antes alcanzaba con haber elegido un cliente para el CCF. Pero un cliente
  // puede tener NIT y aun así no poder recibir un CCF (sin NRC, sin actividad,
  // sin dirección): el DTE se rechazaba al transmitir. Ahora se exige el
  // receptor completo, y el panel de arriba dice exactamente qué falta.
  // Con cupón no hay documento que elegir: basta con que el cupón sirva.
  const canConfirm = submitting ? false
    : pagaConCupon ? cuponValido
    // «A nombre de…» sin cliente elegido sería un genérico disfrazado.
    : docType === 'ticket' ? fcfStatus.ok && (fcfMode === 'generic' || Boolean(fcfCliente))
    : docType === 'ccf'  ? Boolean(ccfSelected && ccfStatus?.ok)
    : false

  const confirmar = () => {
    if (!canConfirm) return
    if (pagaConCupon) { onCanjear(); return }
    if (docType) onConfirm({
      docType,
      fcfMode: docType === 'ticket' ? fcfMode : undefined,
      fcfCustomer: docType === 'ticket' ? fcfReceptor : undefined,
      ccfCustomer: docType === 'ccf' ? ccfSelected : undefined,
    })
  }

  const tituloColumna = (texto: string) => (
    <div className="panel-section-label">{texto}</div>
  )

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: esMovil ? 10 : 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: esMovil ? 520 : 880, maxHeight: esMovil ? '94dvh' : '92vh', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}>Cobrar</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* El total viaja con el modal: es el número que el cajero le dice
                al cliente mientras marca el monto recibido. */}
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(total)}</div>
            <button onClick={onCancel} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
          </div>
        </div>

        <div style={{
          flex: 1, overflowY: 'auto', padding: esMovil ? '14px 14px' : '16px 20px',
          display: 'grid', gridTemplateColumns: esMovil ? '1fr' : '300px 1fr', gap: esMovil ? 18 : 22, alignItems: 'start',
        }}>
          {/* Pago */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pago}
          </div>

          {/* Documento fiscal */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 12,
            ...(esMovil ? {} : { borderLeft: '1px solid var(--border)', paddingLeft: 22 }),
          }}>
          {tituloColumna('Documento fiscal')}
          {pagaConCupon ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '10px 12px', borderRadius: 10 }}>
              El canje no emite documento: el cupón se facturó el día que se vendió. Se imprime un comprobante de canje.
            </div>
          ) : (<>
          {/* Doc type */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              { id: 'ticket', label: 'Ticket', sub: 'Factura consumidor final', color: 'var(--corsa-green)' },
              { id: 'ccf',    label: 'CCF',    sub: 'Comprobante crédito fiscal', color: 'var(--corsa-orange)' },
            ].map(opt => (
              <button
                key={opt.id}
                id={`doctype-${opt.id}`}
                onClick={() => setDocType(opt.id as DocType)}
                style={{
                  padding: '10px 12px', borderRadius: 14, cursor: 'pointer', textAlign: 'left',
                  border: `2px solid ${docType === opt.id ? opt.color : 'var(--border)'}`,
                  background: docType === opt.id ? `${opt.color}10` : 'var(--surface)',
                  transition: 'all 0.12s', display: 'flex', alignItems: 'center', gap: 10,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16, color: docType === opt.id ? opt.color : 'var(--text-primary)' }}>{opt.label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>{opt.sub}</div>
                </div>
                {docType === opt.id && (
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: opt.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* Facturar a alguien del grupo: un toque elige al receptor. */}
          {grupo && grupo.miembros.length > 1 && (
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Facturar a alguien de {grupo.name}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {grupo.miembros.map(m => {
                  const sel = docType === 'ccf' ? ccfSelected?.id === m.id : fcfMode === 'named' && fcfCliente?.id === m.id
                  return (
                    <button key={m.id} type="button"
                      onClick={() => {
                        if (docType === 'ccf') setCcfSelected(m)
                        else { setFcfMode('named'); setFcfCliente(m) }
                      }}
                      style={{
                        padding: '6px 10px', borderRadius: 10, cursor: 'pointer', fontFamily: 'var(--font-body)',
                        fontSize: 12.5, fontWeight: 600, textAlign: 'left',
                        border: `1.5px solid ${sel ? 'var(--corsa-orange)' : 'var(--border)'}`,
                        background: sel ? 'rgba(223,245,107,0.35)' : 'var(--surface)', color: 'var(--text-primary)',
                      }}>
                      {displayName(m)}
                      <div style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--text-secondary)' }}>
                        {m.nit ? `NIT ${m.nit}` : m.dui ? `DUI ${m.dui}` : 'Sin documento'}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* FCF options */}
          {docType === 'ticket' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>¿A nombre de quién?</div>
              {[
                { id: 'generic', label: 'Consumidor final (Genérico)', sub: 'Sin datos fiscales · opción por defecto' },
                { id: 'named',   label: 'A nombre de un cliente', sub: 'Búscalo en Clientes por nombre, DUI o NIT' },
              ].map(opt => (
                <label key={opt.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', borderRadius: 14, cursor: 'pointer', border: `1.5px solid ${fcfMode === opt.id ? 'var(--corsa-green)' : 'var(--border)'}`, background: fcfMode === opt.id ? 'rgba(22,25,26,0.05)' : 'var(--surface)', transition: 'all 0.12s' }}>
                  <input type="radio" name="fcf" checked={fcfMode === opt.id as FcfMode} onChange={() => setFcfMode(opt.id as FcfMode)} style={{ accentColor: 'var(--corsa-green)', marginTop: 2 }}/>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{opt.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>{opt.sub}</div>
                  </div>
                </label>
              ))}

              {fcfMode === 'named' && (
                <BuscadorReceptor id="fcf-search" elegido={fcfCliente} onElegir={setFcfCliente}
                  color="var(--corsa-green)" placeholder="Nombre, DUI o NIT…"/>
              )}

              {/* El cajero confirma los datos con el cliente antes de cobrar.
                  Sobre el umbral del MH, además, bloquean. */}
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
              <BuscadorReceptor id="ccf-search" elegido={ccfSelected} onElegir={setCcfSelected}
                color="var(--corsa-orange)" placeholder="Nombre, NIT o DUI…"/>
              {ccfSelected && ccfStatus && (
                <ReceptorPanel status={ccfStatus} title="Datos con los que se emitirá el CCF"/>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '8px 12px', borderRadius: 10 }}>
                {ccfStatus && !ccfStatus.ok
                  ? `Faltan datos en la ficha: ${ccfStatus.missing.join(', ')}. Completalos en Clientes y volvé a intentar.`
                  : 'El CCF requiere el receptor completo. Si el cliente no existe, créalo en Clientes primero.'}
              </div>
            </div>
          )}
          </>)}
          </div>
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0 }}>
          <button onClick={onCancel} className="btn btn-ghost">Cancelar</button>
          <div className="clip-btn-wrap" style={{ opacity: canConfirm ? 1 : 0.5, pointerEvents: canConfirm ? 'auto' : 'none' }}>
            <div className="clip-btn-corner"/>
            <button id="billing-confirm" className="clip-btn" onClick={confirmar} disabled={!canConfirm}>
              {submitting ? 'Procesando…'
                : pagaConCupon ? 'Canjear cupón e imprimir'
                : `Confirmar y cobrar ${fmt(total)}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Placas del grupo empresarial ─────────────────────────────

/** Los carros de los otros clientes del grupo, con su dueño. */
function PlacasDelGrupo({ grupo, clienteId, elegido, onElegir }: {
  grupo: GrupoPos
  clienteId: string
  elegido: VehiculoPos | null
  onElegir: (v: VehiculoPos) => void
}) {
  const otros = grupo.miembros.filter(m => m.id !== clienteId && m.vehiculos.length > 0)
  if (otros.length === 0) return null
  return (
    <div className="card" style={{ padding: 12, marginTop: 10 }}>
      <div className="panel-section-label" style={{ marginBottom: 6 }}>Placas de {grupo.name}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {otros.map(m => (
          <div key={m.id}>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>{displayName(m)}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {m.vehiculos.map(v => {
                const sel = elegido?.id === v.id
                return (
                  <button key={v.id} onClick={() => onElegir(v)}
                    style={{
                      padding: '6px 10px', borderRadius: 12, cursor: 'pointer', minHeight: 40, textAlign: 'left',
                      border: `2px solid ${sel ? 'var(--corsa-green)' : 'var(--border)'}`,
                      background: sel ? 'rgba(22,25,26,0.05)' : 'var(--surface)', fontFamily: 'var(--font-body)',
                    }}>
                    <div className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{v.plate}</div>
                    {(v.brand || v.model) && (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{[v.brand, v.model].filter(Boolean).join(' ')}</div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main POS Page ────────────────────────────────────────────

export function POSPage() {
  const { profile, currentBranch, hasPermission } = useAuth()
  const esMovil = useEsMovil()
  const puedeCanjearCupon = hasPermission('vouchers.redeem')
  const metodosPago = PAYMENT_METHODS.filter(
    pm => pm.id !== 'cupon' || puedeCanjearCupon
  )
  const branchId = (currentBranch as any)?.id ?? null
  // El alta rápida necesita la organización: los clientes y los vehículos se
  // crean dentro de la del usuario, nunca en otra.
  const orgId = (profile as any)?.organization_id ?? null

  // Mode
  const [mode, setMode] = useState<OrderMode>('normal')

  // Normal mode
  const [customer, setCustomer] = useState<CustomerResult | null>(null)
  const [selectedService, setSelectedService] = useState('elite')
  const [selectedSize, setSelectedSize] = useState<SizeId>('M')
  const [withAspirado, setWithAspirado] = useState(false)
  const [conSeguro, setConSeguro] = useState(false)
  // Seguro de lluvia de cortesía (0053). Arranca sin marcar: con una orden
  // armada se agrega al cobrar; sin orden, el botón abre el modal.
  const [conCortesia, setConCortesia] = useState(false)
  // Grupo empresarial del cliente en caja (0054). Se pide al elegir el cliente.
  const [grupo, setGrupo] = useState<GrupoPos | null>(null)
  const [modalCortesia, setModalCortesia] = useState(false)
  // Póliza viva del vehículo elegido, si tiene una. La trae el servidor.
  const [polizaVigente, setPolizaVigente] = useState<RainPolicy | null>(null)
  // Los vehículos del cliente elegido, y con cuál entra. Un cliente con tres
  // carros cobrado siempre sobre el primero deja un historial inservible.
  const [vehiculos, setVehiculos] = useState<VehiculoPos[]>([])
  const [vehiculoElegido, setVehiculoElegido] = useState<VehiculoPos | null>(null)
  // Tipo de vehículo → tamaño (S/M/L). Se carga una vez: son tres filas, y
  // es lo que permite que elegir el carro deje elegida la tarifa.
  const [mapaTamanos, setMapaTamanos] = useState<Record<string, TamanoVehiculo>>({})
  const [altaCliente, setAltaCliente] = useState(false)
  const [altaVehiculo, setAltaVehiculo] = useState(false)
  // Cuando el cajero decide cobrar el lavado CON el seguro, en lugar de cobrarlo.
  const [canjeandoSeguro, setCanjeandoSeguro] = useState(false)

  // Fleet mode
  const [showFleetModal, setShowFleetModal] = useState(false)
  const [fleetCompany, setFleetCompany] = useState<FleetCompany | null>(null)
  const [fleetVehicle, setFleetVehicle] = useState<FleetVehicle | null>(null)

  // Payment
  const [selectedPayment, setSelectedPayment] = useState('efectivo')
  const [keypadValue, setKeypadValue] = useState('')
  const [showBillingModal, setShowBillingModal] = useState(false)

  /**
   * Si esta sucursal emite el DTE con cada cobro. Se pregunta al cambiar de
   * sucursal y no en cada venta: el interruptor cambia una vez, cuando el
   * circuito con Hacienda queda listo.
   */
  const [emiteDte, setEmiteDte] = useState(false)
  // El emisor del ticket se pide al abrir la caja: al cobrar ya está en
  // memoria y la impresión no espera a la red. Un fallo acá no importa: la
  // impresión lo vuelve a pedir.
  useEffect(() => { cargarEmisor(branchId).catch(() => {}) }, [branchId])
  useEffect(() => {
    if (!branchId) { setEmiteDte(false); return }
    let vivo = true
    posEmiteDte(branchId).then(v => { if (vivo) setEmiteDte(v) }).catch(() => { if (vivo) setEmiteDte(false) })
    return () => { vivo = false }
  }, [branchId])
  const [voucherCode, setVoucherCode] = useState('')
  const [voucherFound, setVoucherFound] = useState<VoucherLookup | null>(null)
  const [voucherChecking, setVoucherChecking] = useState(false)
  const [voucherMiss, setVoucherMiss] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Derived prices
  // En flotilla sólo se ofrecen los servicios negociados; si el elegido no
  // está entre ellos (se cambió de flotilla), manda el primero que sí.
  const serviciosFlotilla = SERVICES.filter(s => fleetCompany?.precios[s.id as ServicioId])
  const servicioEfectivo = mode === 'flotilla' && !serviciosFlotilla.some(s => s.id === selectedService)
    ? (serviciosFlotilla[0]?.id ?? 'elite')
    : selectedService
  const svc = SERVICES.find(s => s.id === servicioEfectivo)!
  const fleetPrices: Record<SizeId, number> = fleetCompany?.precios[svc.id as ServicioId] ?? svc.prices
  // Con un cliente de grupo en caja (modo normal), el precio negociado del
  // grupo para ese servicio; lo que el grupo no negoció va a tarifa de lista.
  const acuerdoGrupo = mode === 'normal' ? grupo?.acuerdo ?? null : null
  const preciosDe = (s: { id: string; prices: Record<SizeId, number> }): Record<SizeId, number> =>
    acuerdoGrupo?.servicios[s.id.toUpperCase() as CodigoServicio] ?? s.prices
  const servicePrice = mode === 'flotilla' ? fleetPrices[selectedSize] : preciosDe(svc)[selectedSize]
  // En flotilla manda el precio negociado; si no hay acuerdo, la tarifa de lista.
  const usaAspiradoFlotilla = mode === 'flotilla'
    && Boolean(fleetCompany?.aspirado_enabled)
    && fleetCompany?.aspirado_price != null
  const usaAspiradoGrupo = Boolean(acuerdoGrupo?.aspirado.activo && acuerdoGrupo.aspirado.precio != null)
  const aspiradoUnit = usaAspiradoFlotilla
    ? Number(fleetCompany!.aspirado_price)
    : usaAspiradoGrupo ? Number(acuerdoGrupo!.aspirado.precio)
    : ADDON_ASPIRADO.price
  const aspiradoPrice = withAspirado ? aspiradoUnit : 0

  /**
   * A quién se le puede vender el seguro.
   *
   * Cliente identificado y vehículo con placa. La misma regla la hace cumplir
   * el servidor; acá se repite para poder explicar POR QUÉ está deshabilitado
   * en lugar de mostrar un error después de que el cajero ya lo intentó. Nunca
   * al revés: esta comprobación es cortesía, la del servidor es la que manda.
   */
  const vehiculoDelCliente = mode === 'flotilla' ? fleetVehicle : vehiculoElegido
  // Las dos formas de vehículo del POS no comparten el nombre del id: el de
  // flotilla lo llama vehicle_id. Se normaliza acá y no en cada uso.
  const vehiculoId = mode === 'flotilla'
    ? fleetVehicle?.vehicle_id ?? null
    : vehiculoElegido?.id ?? null
  const puedeVenderSeguro = Boolean(
    (mode === 'flotilla' ? fleetCompany?.customer_id : customer?.id)
    && vehiculoDelCliente?.plate
  )
  /**
   * Que la casilla esté marcada no alcanza para cobrar el seguro.
   *
   * Se deriva en lugar de corregir el estado con un efecto: si el cliente se
   * quita del POS, o se pasa a canjear, el seguro deja de estar activo en el
   * mismo render. Con un efecto que lo desmarcara después existiría un render
   * —uno solo, pero existe— mostrando un total con un seguro que ya no se
   * puede vender.
   */
  const seguroActivo = conSeguro && puedeVenderSeguro && !canjeandoSeguro
  // La cortesía, igual: derivada. Sin cliente con placa no hay orden a la que
  // agregarla, y el botón pasa a abrir el modal de cortesía suelta.
  const puedeDarCortesia = hasPermission('rain.courtesy')
  const cortesiaActiva = conCortesia && puedeVenderSeguro && !canjeandoSeguro && !seguroActivo && puedeDarCortesia
  const seguroPrice = seguroActivo ? ADDON_SEGURO.price : 0

  // Un lavado cobrado con el seguro no se cobra: es el derecho que ya se pagó.
  const total = canjeandoSeguro ? 0 : servicePrice + aspiradoPrice + seguroPrice
  const received = parseFloat(keypadValue) || 0
  const change = Math.max(0, received - total)

  const pagaConCupon = selectedPayment === 'cupon'
  // Sólo el efectivo se cuenta y da cambio. Tarjeta, transferencia, membresía
  // y crédito cobran el total exacto: pedir un monto recibido ahí es un paso
  // de más que el cajero llenaba con cualquier cosa.
  const pagaEnEfectivo = selectedPayment === 'efectivo'
  const usaTeclado = pagaEnEfectivo || pagaConCupon

  const elegirPago = (id: string) => {
    setSelectedPayment(id)
    if (id !== 'efectivo') setKeypadValue('')
  }

  const handleKeypad = (k: string) => {
    if (!usaTeclado) return
    // Con cupón el mismo teclado escribe el número: el cajero no tiene que
    // cambiar de dispositivo ni de zona de la pantalla.
    if (pagaConCupon) {
      if (k === '⌫') { setVoucherCode(v => v.slice(0, -1)); setVoucherFound(null); setVoucherMiss(false); return }
      if (k === '.') return
      if (voucherCode.length >= 6) return
      setVoucherCode(v => v + k)
      setVoucherFound(null); setVoucherMiss(false)
      return
    }
    if (k === '⌫') { setKeypadValue(v => v.slice(0, -1)); return }
    if (k === '.' && keypadValue.includes('.')) return
    setKeypadValue(v => v + k)
  }

  const validarCupon = useCallback(async () => {
    if (voucherCode.length < 6) return
    setVoucherChecking(true); setVoucherFound(null); setVoucherMiss(false)
    try {
      const v = await lookupVoucher(voucherCode)
      if (v) setVoucherFound(v); else setVoucherMiss(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo consultar el cupón')
    }
    setVoucherChecking(false)
  }, [voucherCode])

  // Al completar los 6 dígitos se valida solo: es lo que el cajero va a hacer
  // igual, y ahorra un clic con el cliente esperando.
  useEffect(() => {
    if (pagaConCupon && voucherCode.length === 6) validarCupon()
  }, [pagaConCupon, voucherCode, validarCupon])

  const handleFleetVehicleSelected = (company: FleetCompany, vehicle: FleetVehicle) => {
    setFleetCompany(company)
    setFleetVehicle(vehicle)
    // ÉLITE si la flotilla lo negoció (es lo habitual); si no, su primer servicio.
    setSelectedService(company.precios.elite ? 'elite' : (SERVICES.find(s => company.precios[s.id as ServicioId])?.id ?? 'elite'))
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
   * Canje. No pasa por pos_register_sale: el cobro ocurrió el día que se
   * vendió el cupón, así que acá sólo se registra el servicio prestado — el
   * RPC marca el cupón como usado con su fecha y hora — y se imprime un
   * comprobante sin contenido tributario.
   */
  const canjearCupon = useCallback(async () => {
    if (!branchId || !voucherFound || voucherFound.status !== 'active') return
    setShowBillingModal(false)
    setSubmitting(true)
    try {
      const r = await redeemVoucher(voucherFound.code, branchId, {
        vehicleId: customer?.vehicle?.id,
        plate: customer?.vehicle?.plate,
      })
      try {
        await imprimirTicketEnSegundoPlano({
          // El canje no tiene contenido tributario: sólo la marca.
          emisor: MARCA,
          operacion: {
            servicio: r.service_name,
            aspirado: r.includes_aspirado,
            placa: customer?.vehicle?.plate,
            ordenNumero: r.order_number,
          },
          venta: { id: r.order_id, fecha: r.redeemed_at, lineas: [], total: 0 },
          redencion: {
            codigoCupon: r.code,
            clienteNombre: voucherFound.customer_name,
            valor: Number(r.unit_value || 0),
            fecha: formatearFechaHora(r.redeemed_at),
          },
        })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'El canje se registró, pero no se pudo abrir el ticket')
      }
      toast.success(`Cupón ${r.code} canjeado · orden ${r.order_number}`)
      setVoucherCode(''); setVoucherFound(null); setVoucherMiss(false)
      setCustomer(null); setSelectedPayment('efectivo')
      setWithAspirado(false); setKeypadValue('')
      setConSeguro(false); setCanjeandoSeguro(false); setPolizaVigente(null)
      setVehiculos([]); setVehiculoElegido(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo canjear el cupón')
    }
    setSubmitting(false)
  }, [branchId, voucherFound, customer])

  const handleBillingConfirm = useCallback(async (billing: BillingInfo) => {
    setShowBillingModal(false)
    setSubmitting(true)

    // FCF y CCF esperan igual: el Worker emite el que corresponda según la
    // factura que registró el cobro.
    const esperarDte = emiteDte

    // El ticket se imprime en segundo plano (iframe invisible), así que ya no
    // hace falta abrir una ventana en el clic para esquivar el bloqueo de
    // ventanas emergentes.

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
        p_vehicle_id:      mode === 'flotilla' ? (fleetVehicle?.vehicle_id ?? null) : (vehiculoElegido?.id ?? null),
        p_doc_type:        billing.docType,
        p_fcf_name:        billing.fcfCustomer ? displayName(billing.fcfCustomer) : null,
        // La factura queda a nombre del receptor elegido en el modal: el del
        // CCF o el del ticket nominado (la RPC lo antepone al de la caja).
        p_ccf_customer_id: (billing.ccfCustomer ?? billing.fcfCustomer)?.id ?? null,
        p_order_type:      mode,
        p_rain_insurance:  seguroActivo,
        p_rain_price:      seguroPrice,
        p_rain_policy_id:  canjeandoSeguro ? (polizaVigente?.id ?? null) : null,
      })
      if (error) throw error

      let sale = data as PosSaleResult

      // La cortesía va después del cobro y no adentro: no mueve plata, y si
      // falla la venta ya está bien registrada. Se avisa y se puede dar suelta.
      if (cortesiaActiva && vehiculoId) {
        try {
          const p = await darCortesia({
            branchId, workOrderId: sale.order_id, vehicleId: vehiculoId,
            customerId: (mode === 'flotilla' ? fleetCompany?.customer_id : customer?.id) as string,
          })
          sale = { ...sale, rain_policy: { id: p.id, plate: p.plate, price: 0, issued_at: p.issued_at, valid_until: p.valid_until, courtesy: true } }
        } catch (e) {
          toast.error(`La venta se registró, pero la cortesía no: ${e instanceof Error ? e.message : 'error'}. Dala desde el botón Cortesía.`,
            { duration: 10000 })
        }
      }
      // Un ticket genérico no lleva datos del cliente aunque haya uno en la caja.
      const receptor = billing.ccfCustomer ?? billing.fcfCustomer ?? null

      // Con la sucursal emitiendo, el ticket espera el sello de Hacienda para
      // imprimir número de control, código de generación, sello y QR. El
      // cobro ya quedó registrado: si Hacienda no contesta o rechaza, el
      // ticket sale igual —es la orden del equipo en piso y el cliente está
      // esperando— con el DTE pendiente, y se reintenta desde Contabilidad.
      let dte: DteDeVenta | null = null
      if (esperarDte && sale.invoice_id) {
        const espera = toast.loading('Firmando y emitiendo el DTE con Hacienda…')
        try {
          // Firma LOCAL: el Worker arma, la estación fiscal de esta PC firma con
          // el firmador de Hacienda, el Worker transmite. El ticket espera el sello.
          const r = await emitirConFirmaLocal(sale.invoice_id, { timeoutMs: ESPERA_DTE_MS })
          if (r.estado === 'ACCEPTED') {
            dte = await fetchDteDeVenta(sale.invoice_id)
            // Un CCF cuyo total no tiene base sin IVA exacta sale un centavo
            // abajo de lo cobrado; el Worker lo explica en `mensaje`.
            if (r.mensaje) toast(r.mensaje, { duration: 8000 })
            toast.success('DTE sellado por Hacienda', { id: espera })
          } else {
            toast.error(`DTE ${r.estado === 'REJECTED' ? 'rechazado' : 'pendiente'}: ${r.mensaje ?? 'revisalo en Contabilidad'}. El ticket sale sin sello.`,
              { id: espera, duration: 8000 })
          }
        } catch (e) {
          toast.error(`${e instanceof Error ? e.message : 'No se pudo emitir el DTE'} El ticket sale sin sello.`,
            { id: espera, duration: 8000 })
        }
      }

      // El ticket se imprime solo, sin ventanas: es el comprobante y a la vez la
      // orden que lee el equipo en piso. Con DTE sale DESPUÉS del sello de
      // Hacienda. Si la impresión falla, el cobro ya quedó registrado: sólo se
      // avisa, no se revierte.
      try {
        // Con DTE es un documento fiscal y exige el emisor completo; sin él,
        // el ticket sale aunque falte configuración, rotulado sin validez.
        const emisor = await emisorParaTicket(branchId, !!dte)
        await imprimirTicketEnSegundoPlano(buildTicketArgsFromPos(sale, emisor, {
          clienteNombre: receptor ? displayName(receptor) : undefined,
          clienteDoc: receptor
            ? { tipo: receptor.nit ? 'NIT' : 'DUI', numero: receptor.nit ?? receptor.dui, nrc: receptor.nrc }
            : undefined,
          placa: mode === 'flotilla' ? fleetVehicle?.plate : vehiculoElegido?.plate,
          vehiculo: vehiculoElegido
            ? [vehiculoElegido.brand, vehiculoElegido.model, vehiculoElegido.color].filter(Boolean).join(' ') || undefined
            : undefined,
          metodoPago: PAYMENT_METHODS.find(p => p.id === selectedPayment)?.label,
          aspiradoPrecio: aspiradoPrice,
          branchName: (currentBranch as any)?.name,
        }, dte))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'La venta se guardó, pero no se pudo abrir el ticket')
      }

      // Con seguro de lluvia (pagado o de cortesía) sale además su propio
      // ticket, aparte del de facturación: es el que el cliente guarda y
      // presenta si llueve. El de facturación no cambia.
      if (sale.rain_policy) {
        try {
          const titular = mode === 'flotilla' ? (fleetCompany?.trade_name ?? 'Cliente') : displayName(customer)
          const args = buildTicketSeguroDeVenta(sale, await emisorParaTicket(branchId, false), titular)
          if (args) await imprimirTicketEnSegundoPlano(args)
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'No se pudo imprimir el ticket del seguro de lluvia')
        }
      }

      toast.success(`Venta ${sale.order_number} registrada ✓`)
      setCustomer(null); setFleetCompany(null); setFleetVehicle(null)
      setMode('normal'); setSelectedService('elite'); setSelectedSize('M')
      setWithAspirado(false); setKeypadValue(''); setConCortesia(false)
    } catch (err: any) {
      toast.error(err?.message ?? 'Error al crear la orden')
    }
    setSubmitting(false)
  }, [branchId, emiteDte, mode, fleetCompany, fleetVehicle, customer, svc, selectedSize, total, selectedPayment,
      withAspirado, aspiradoPrice, currentBranch, seguroActivo, seguroPrice,
      canjeandoSeguro, polizaVigente, vehiculoElegido, cortesiaActiva, vehiculoId])

  // Con cupón el botón sólo se habilita si el cupón existe y está sin usar:
  // canjear uno ya utilizado o inexistente falla en el servidor, y es mejor
  // no dejar que el cajero lo intente delante del cliente.
  useEffect(() => {
    if (!orgId) return
    let vivo = true
    fetchMapaTamanos(orgId).then(m => { if (vivo) setMapaTamanos(m) })
    return () => { vivo = false }
  }, [orgId])

  /**
   * La tarifa sale del carro.
   *
   * Desde la 0040 el tipo de vehículo ES el tamaño que cobra el POS, así que
   * elegir el vehículo ya dice qué se cobra. Se preselecciona en lugar de
   * imponerse: el cajero puede corregirlo —un pickup cargado, una camioneta
   * que entra como mediana— y su corrección no se pisa, porque esto sólo
   * corre cuando cambia el vehículo elegido.
   */
  useEffect(() => {
    const tipo = vehiculoElegido?.vehicle_type_id
    if (!tipo) return
    const tamano = mapaTamanos[tipo]
    if (tamano) setSelectedSize(tamano)
  }, [vehiculoElegido, mapaTamanos])

  /**
   * Los carros del cliente.
   *
   * Se piden al elegir el cliente y no al vender: el cajero tiene que ver las
   * placas ANTES de cobrar, porque de ahí sale sobre cuál se emite el seguro y
   * a qué vehículo queda asociada la orden. El que trae la búsqueda por placa
   * queda preseleccionado, que es el caso normal: se buscó por esa placa.
   */
  useEffect(() => {
    if (!customer?.id) { setVehiculos([]); setVehiculoElegido(null); return }
    let vivo = true
    getCustomerVehicles(customer.id)
      .then(vs => {
        if (!vivo) return
        const lista = (vs ?? []) as VehiculoPos[]
        setVehiculos(lista)
        setVehiculoElegido(prev => {
          const buscado = customer.vehicle?.id
          return lista.find(v => v.id === (prev?.id ?? buscado)) ?? lista[0] ?? null
        })
      })
      .catch(() => { if (vivo) { setVehiculos([]); setVehiculoElegido(null) } })
    return () => { vivo = false }
  }, [customer])

  /**
   * El grupo empresarial del cliente (0054): sus precios, las placas de los
   * demás miembros y a quiénes se les puede facturar. Si falla, la caja sigue
   * como con cualquier cliente: tarifa de lista y sus propios carros.
   */
  const grupoId = mode === 'normal' ? customer?.business_group_id ?? null : null
  useEffect(() => {
    if (!grupoId) { setGrupo(null); return }
    let vivo = true
    cargarGrupoPos(grupoId)
      .then(g => { if (vivo) setGrupo(g) })
      .catch(() => { if (vivo) setGrupo(null) })
    return () => { vivo = false }
  }, [grupoId])

  /**
   * ¿Este carro ya tiene seguro vigente?
   *
   * Se pregunta al servidor cada vez que cambia el vehículo. Que el cajero se
   * entere ANTES de cobrar es la mitad del valor del producto: un cliente que
   * pagó su seguro y vuelve bajo la lluvia no debería tener que acordarse de
   * mencionarlo.
   */
  useEffect(() => {
    if (!vehiculoId) { setPolizaVigente(null); setCanjeandoSeguro(false); return }
    let vivo = true
    fetchPolizaVigente(vehiculoId).then(p => { if (vivo) setPolizaVigente(p) })
    return () => { vivo = false }
  }, [vehiculoId])

  // La validez del cupón se resuelve dentro del modal de cobro; para abrirlo
  // basta con que la orden esté armada.
  const canCharge = mode === 'flotilla' ? !!fleetVehicle : true

  const abrirCobro = () => {
    // Cada cobro empieza con el monto en blanco: el de la venta anterior no
    // tiene nada que ver con éste.
    setKeypadValue('')
    setShowBillingModal(true)
  }

  /**
   * El bloque de pago del modal de cobro: método, monto y teclado.
   *
   * Lo arma la página y no el modal porque el estado es de la página: el canje
   * y el registro de la venta lo leen, y cerrar el modal para corregir un
   * servicio no tiene que borrar el cupón ya tecleado.
   */
  const bloqueDeCobro = (
    <>
          {/* Pago */}
          <div>
            <div className="panel-section-label" style={{ marginBottom: 10 }}>Método de pago</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
              {metodosPago.map(pm => (
                <button key={pm.id} id={`pay-${pm.id}`} onClick={() => elegirPago(pm.id)}
                  style={{ padding: '8px 4px', borderRadius: 10, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', border: `1px solid ${selectedPayment === pm.id ? 'var(--corsa-green)' : 'var(--border)'}`, background: selectedPayment === pm.id ? 'var(--corsa-green)' : 'var(--surface)', color: selectedPayment === pm.id ? '#fff' : 'var(--text-primary)', cursor: 'pointer', transition: 'all 0.12s' }}>
                  {pm.label}
                </button>
              ))}
            </div>
          </div>

          {/* Teclado: el monto recibido en efectivo, o el número del cupón. */}
          {usaTeclado && (
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              {pagaConCupon ? 'Número de cupón (6 dígitos)' : 'Monto recibido'}
            </div>
            <div style={{ border: `1.5px solid ${pagaConCupon && voucherFound ? (voucherFound.status === 'active' ? 'var(--corsa-green)' : 'var(--color-danger-text)') : 'var(--border)'}`, borderRadius: 12, padding: '6px 12px', marginBottom: 8, fontFamily: pagaConCupon ? "'SF Mono', monospace" : 'var(--font-heading)', fontSize: pagaConCupon ? 22 : 32, fontWeight: 800, letterSpacing: pagaConCupon ? 3 : 0, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2, minHeight: 50, color: 'var(--text-primary)', textAlign: pagaConCupon ? 'center' : 'right' }}>
              {pagaConCupon
                ? (voucherCode || <span style={{ color: 'var(--border)' }}>------</span>)
                : (keypadValue ? `$${keypadValue}` : <span style={{ color: 'var(--border)' }}>$0.00</span>)}
            </div>

            {/* El cambio, grande y pegado al monto: es lo que el cajero lee en
                voz alta mientras cuenta los billetes. Si el monto no alcanza,
                dice cuánto falta en lugar de un cambio de cero. */}
            {pagaEnEfectivo && (() => {
              const falta = received > 0 && received < total
              return (
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  borderRadius: 12, padding: '8px 12px', marginBottom: 8,
                  background: falta ? 'var(--color-danger-tint)' : received > 0 ? 'var(--color-success-tint)' : 'var(--subtle-bg)',
                  color: falta ? 'var(--color-danger-text)' : received > 0 ? 'var(--color-success-text)' : 'var(--text-secondary)',
                }}>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{falta ? 'Falta' : 'Cambio'}</span>
                  <span style={{ fontFamily: 'var(--font-heading)', fontSize: 32, fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
                    {received > 0 ? fmt(falta ? total - received : change) : '—'}
                  </span>
                </div>
              )
            })()}

            {pagaConCupon && (
              <div style={{ marginBottom: 8 }}>
                {voucherChecking && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Validando…</div>
                )}
                {voucherMiss && (
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-danger-text)' }}>
                    No existe ningún cupón con ese número.
                  </div>
                )}
                {voucherFound && (
                  <div style={{
                    border: `1.5px solid ${voucherFound.status === 'active' ? 'var(--corsa-green)' : 'var(--color-danger-text)'}`,
                    borderRadius: 12, padding: '8px 10px',
                    background: voucherFound.status === 'active' ? 'rgba(22,25,26,0.05)' : 'var(--color-danger-bg, #FBE7E7)',
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 3 }}>
                      {voucherFound.status === 'active' ? 'Cupón válido'
                        : voucherFound.status === 'redeemed' ? 'Ya fue canjeado' : 'Cupón anulado'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                      {voucherFound.service_name} {voucherFound.size} ·{' '}
                      {voucherFound.includes_aspirado ? 'con aspirado' : 'sin aspirado'}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{voucherFound.customer_name}</div>
                    {voucherFound.status === 'redeemed' && voucherFound.redeemed_at && (
                      <div style={{ fontSize: 11.5, color: 'var(--color-danger-text)', marginTop: 3 }}>
                        Usado el {formatearFechaHora(voucherFound.redeemed_at)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="keypad">
              {KEYPAD_KEYS.map(k => (
                <button key={k} id={`kp-${k}`} className="keypad-key" onClick={() => handleKeypad(k)}>{k}</button>
              ))}
            </div>
          </div>
          )}

          {!usaTeclado && (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '10px 12px', borderRadius: 10 }}>
              Se cobra el total exacto: {fmt(total)}.
            </div>
          )}

    </>
  )

  return (
    <div className="pos-inner">

      {/* Title */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 24, letterSpacing: '-0.025em', margin: 0, color: 'var(--text-primary)' }}>Nueva orden</h1>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Selecciona el tipo de servicio para continuar</div>
      </div>

      {/* ── Mode selector (3 cards) ── */}
      {/* En el teléfono las tres van en una línea, cuadradas, como el selector
          de tamaño: apiladas se comían media pantalla de alto para elegir algo
          que se elige una vez por orden. Lo que se sacrifica es la línea
          explicativa de cada modo — el icono y el nombre alcanzan, y el alto
          que se gana es el que hace falta para ver el servicio sin scrollear. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: esMovil ? 8 : 10 }}>
        {[
          {
            id: 'normal' as const,
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="2" y="7" width="20" height="13" rx="1.5"/><path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><line x1="2" y1="12" x2="22" y2="12"/></svg>,
            label: 'Normal',
            corto: 'Normal',
            sub: 'Cliente que paga servicio completo',
            color: 'var(--corsa-green)',
          },
          {
            id: 'flotilla' as const,
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="1" y="7" width="14" height="10"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></svg>,
            label: 'Flotilla Corp.',
            corto: 'Flotilla',
            sub: 'Servicios a precio negociado',
            color: 'var(--corsa-orange)',
          },
          {
            id: 'membresia' as const,
            icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="8" r="5"/><polyline points="8.5 13 7 22 12 19 17 22 15.5 13"/></svg>,
            label: 'Membresía',
            corto: 'Membresía',
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
              padding: esMovil ? '10px 6px' : '9px 12px', borderRadius: 14,
              cursor: opt.disabled ? 'not-allowed' : 'pointer',
              textAlign: esMovil ? 'center' : 'left',
              border: `2px solid ${mode === opt.id ? opt.color : 'var(--border)'}`,
              background: mode === opt.id ? `${opt.color}0D` : 'var(--surface)',
              opacity: opt.disabled ? 0.5 : 1,
              transition: 'all 0.12s', display: 'flex',
              flexDirection: esMovil ? 'column' : 'row',
              alignItems: esMovil ? 'center' : 'flex-start',
              justifyContent: esMovil ? 'center' : undefined,
              aspectRatio: esMovil ? '1 / 1' : undefined,
              gap: esMovil ? 6 : 10,
            }}
          >
            <div style={{ color: mode === opt.id ? opt.color : 'var(--text-secondary)', marginTop: esMovil ? 0 : 2, flexShrink: 0 }}>{opt.icon}</div>
            <div>
              <div style={{
                fontFamily: 'var(--font-heading)', fontWeight: 700,
                fontSize: esMovil ? 12.5 : 14, lineHeight: 1.15,
                color: mode === opt.id ? opt.color : 'var(--text-primary)',
              }}>
                {esMovil ? opt.corto : opt.label}
                {mode === opt.id && !esMovil && <span style={{ marginLeft: 6, fontSize: 11, color: opt.color }}>●</span>}
              </div>
              {/* La explicación de cada modo sólo cabe en computadora. */}
              {!esMovil && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>{opt.sub}</div>}
            </div>
          </button>
        ))}
      </div>

      {/* ── Fleet selected info ── */}
      {mode === 'flotilla' && fleetVehicle && fleetCompany && (
        <div style={{ background: 'rgba(223,245,107,0.35)', border: '1.5px solid var(--corsa-orange)', borderRadius: 16, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ width: 42, height: 42, borderRadius: 14, background: 'var(--corsa-orange)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" strokeWidth="1.8" strokeLinecap="round"><path d="M5 17H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1l2-4h10l2 4h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', letterSpacing: 0.5 }}>{fleetVehicle.plate}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              {[fleetVehicle.brand, fleetVehicle.model, fleetVehicle.year, fleetVehicle.color].filter(Boolean).join(' · ')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--corsa-orange)', fontWeight: 600, marginTop: 2 }}>{fleetCompany.trade_name}</div>
          </div>
          <button onClick={() => setShowFleetModal(true)} className="btn btn-ghost" style={{ fontSize: 12.5 }}>Cambiar vehículo</button>
        </div>
      )}

      {mode === 'flotilla' && !fleetVehicle && (
        <div style={{ border: '1.5px dashed var(--border)', borderRadius: 16, padding: '20px', textAlign: 'center' }}>
          <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 10 }}>Selecciona el vehículo de la flotilla corporativa</div>
          <button className="btn btn-primary" onClick={() => setShowFleetModal(true)}>Seleccionar vehículo</button>
        </div>
      )}

      {/* ── Main layout (only when ready) ── */}
      {(mode === 'normal' || (mode === 'flotilla' && fleetVehicle)) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>

          {/* Col 1: Customer (only normal mode) */}
          {mode === 'normal' && (
            <div style={{ flex: esMovil ? '1 1 100%' : '0 0 250px' }}>
              <CustomerSearchPanel
                selected={customer}
                onSelect={setCustomer}
                onClear={() => setCustomer(null)}
                onNuevo={() => setAltaCliente(true)}
              />

              {/* Los carros del cliente, para elegir con cuál entra. Con
                  ninguno registrado, el botón de agregar es lo único que se ve
                  — y es lo que habilita el seguro de lluvia. */}
              {customer && (
                <div className="card" style={{ padding: 12, marginTop: 10 }}>
                  <SelectorVehiculos
                    vehiculos={vehiculos}
                    elegido={vehiculoElegido}
                    onElegir={setVehiculoElegido}
                    onAgregar={() => setAltaVehiculo(true)}
                    tamanoDe={v => (v.vehicle_type_id ? mapaTamanos[v.vehicle_type_id] ?? null : null)}
                  />
                </div>
              )}

              {/* Las placas de los demás clientes del grupo: el carro de la
                  empresa hermana entra con el cliente que está en caja. */}
              {customer && grupo && (
                <PlacasDelGrupo grupo={grupo} clienteId={customer.id}
                  elegido={vehiculoElegido} onElegir={setVehiculoElegido}/>
              )}
            </div>
          )}

          {/* Col 2: Services */}
          <div style={{ flex: '1 1 360px', display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* Size */}
            <div className="card" style={{ padding: 10 }}>
              <div className="panel-section-label" style={{ marginBottom: 6 }}>Tamaño del vehículo</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {SIZES.map(sz => (
                  <button key={sz.id} id={`size-${sz.id}`} onClick={() => setSelectedSize(sz.id)}
                    style={{ flex: 1, padding: '6px 6px', borderRadius: 12, cursor: 'pointer', textAlign: 'center', border: `2px solid ${selectedSize === sz.id ? 'var(--corsa-green)' : 'var(--border)'}`, background: selectedSize === sz.id ? 'var(--corsa-green)' : 'var(--surface)', color: selectedSize === sz.id ? '#fff' : 'var(--text-primary)', transition: 'all 0.12s' }}>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 17, lineHeight: 1.2 }}>{sz.label}</div>
                    <div style={{ fontSize: 10.5, opacity: 0.8 }}>{sz.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Servicios: en flotilla, sólo los negociados y a su precio */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(mode === 'flotilla' ? serviciosFlotilla : SERVICES).map(s => {
                const tc2 = TIER_COLORS[s.tier]
                const isSel = servicioEfectivo === s.id
                const isFleet = mode === 'flotilla'
                const displayPrices = isFleet ? (fleetCompany?.precios[s.id as ServicioId] ?? s.prices) : preciosDe(s)
                const isGrupo = !isFleet && Boolean(acuerdoGrupo?.servicios[s.id.toUpperCase() as CodigoServicio])
                return (
                  <div key={s.id} id={`svc-${s.id}`}
                    onClick={() => setSelectedService(s.id)}
                    role="button" tabIndex={0}
                    style={{ border: `2px solid ${isSel ? tc2.accent : 'var(--border)'}`, borderRadius: 14, padding: '10px 12px', background: isSel ? `${tc2.accent}09` : 'var(--surface)', cursor: 'pointer', transition: 'all 0.12s', position: 'relative' }}
                  >
                    {isGrupo && (
                      <div style={{ position: 'absolute', top: -8, right: 12, background: 'var(--corsa-orange)', color: 'var(--on-accent)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 7px', borderRadius: 6 }}>PRECIO GRUPO</div>
                    )}
                    {s.recommended && mode !== 'flotilla' && (
                      <div style={{ position: 'absolute', top: -8, left: 12, background: '#8B5A2B', color: '#fff', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 7px', borderRadius: 6 }}>RECOMENDADO</div>
                    )}
                    {isFleet && (
                      <div style={{ position: 'absolute', top: -8, left: 12, background: 'var(--corsa-orange)', color: 'var(--on-accent)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 7px', borderRadius: 6 }}>PRECIO FLOTILLA</div>
                    )}
                    {isSel && <div style={{ position: 'absolute', top: 12, left: -2, width: 4, height: 'calc(100% - 24px)', background: tc2.accent, borderRadius: '0 2px 2px 0' }}/>}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 16, color: isSel ? tc2.accent : 'var(--text-primary)' }}>{s.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, maxWidth: 260 }}>{s.description}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginLeft: 12 }}>
                        {SIZES.map(sz => (
                          <div key={sz.id} style={{ textAlign: 'center', opacity: selectedSize === sz.id ? 1 : 0.38, transition: 'opacity 0.12s' }}>
                            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: selectedSize === sz.id ? 800 : 600, fontSize: selectedSize === sz.id ? 18 : 13.5, color: isSel && selectedSize === sz.id ? tc2.accent : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
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
            <div className="card" style={{ padding: 10 }}>
              <div className="panel-section-label" style={{ marginBottom: 6 }}>Servicios adicionales</div>
              <button id="addon-aspirado" onClick={() => setWithAspirado(v => !v)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderRadius: 12, border: `2px solid ${withAspirado ? 'var(--corsa-orange)' : 'var(--border)'}`, background: withAspirado ? 'rgba(223,245,107,0.35)' : 'var(--surface)', cursor: 'pointer', transition: 'all 0.12s', textAlign: 'left' }}>
                <div style={{ width: 20, height: 20, borderRadius: 4, flexShrink: 0, border: `2px solid ${withAspirado ? 'var(--corsa-orange)' : 'var(--border)'}`, background: withAspirado ? 'var(--corsa-orange)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {withAspirado && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{ADDON_ASPIRADO.label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>
                    Sin importar tamaño del vehículo
                    {usaAspiradoFlotilla && (
                      <span style={{ color: 'var(--corsa-orange)' }}> · Incluido en el plan de la flotilla</span>
                    )}
                    {!usaAspiradoFlotilla && mode === 'normal' && usaAspiradoGrupo && (
                      <span style={{ color: 'var(--corsa-orange)' }}> · Precio del grupo</span>
                    )}
                  </div>
                </div>
                {/* El importe estaba escrito a mano como "+$3": la tarjeta
                    mostraba la tarifa de lista aunque la flotilla tuviera otra
                    negociada, y sólo el resumen reflejaba el precio real. */}
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, color: withAspirado ? 'var(--corsa-orange)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                  +{fmt(aspiradoUnit)}
                </div>
              </button>

              {/* ── Seguro de lluvia ── */}
              <button id="addon-seguro"
                onClick={() => { if (puedeVenderSeguro && !canjeandoSeguro) { setConSeguro(v => !v); setConCortesia(false) } }}
                disabled={!puedeVenderSeguro || canjeandoSeguro}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 12px', borderRadius: 12, marginTop: 6,
                  border: `2px solid ${seguroActivo ? 'var(--corsa-green)' : 'var(--border)'}`,
                  background: seguroActivo ? 'rgba(22,25,26,0.05)' : 'var(--surface)',
                  cursor: puedeVenderSeguro && !canjeandoSeguro ? 'pointer' : 'not-allowed',
                  opacity: puedeVenderSeguro && !canjeandoSeguro ? 1 : 0.55,
                  transition: 'all 0.12s', textAlign: 'left',
                }}>
                <div style={{ width: 20, height: 20, borderRadius: 4, flexShrink: 0, border: `2px solid ${seguroActivo ? 'var(--corsa-green)' : 'var(--border)'}`, background: seguroActivo ? 'var(--corsa-green)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {seguroActivo && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {ADDON_SEGURO.label}
                  </div>
                  {/* Cuando no se puede vender, la tarjeta dice qué falta. Un
                      control deshabilitado sin explicación hace que el cajero
                      lo intente tres veces antes de preguntar. */}
                  <div style={{ fontSize: 11.5, color: puedeVenderSeguro ? 'var(--text-secondary)' : 'var(--color-warning-text, #9A6510)', marginTop: 1 }}>
                    {!puedeVenderSeguro
                      ? 'Requiere cliente registrado con placa'
                      : `${ADDON_SEGURO.horas} h de cobertura · si llueve, vuelve por un PRO sin costo`}
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, color: seguroActivo ? 'var(--corsa-green)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                  +{fmt(ADDON_SEGURO.price)}
                </div>
              </button>

              {/* ── Cortesía: seguro de lluvia sin costo ──
                  Con una orden armada (cliente con placa) es una casilla, sin
                  marcar por defecto, que lo agrega al cobro. Fuera de orden
                  abre el modal que emite la cortesía suelta con su ticket. */}
              {(() => {
                const enOrden = puedeVenderSeguro && !canjeandoSeguro
                const habilitado = puedeDarCortesia && (enOrden || !canjeandoSeguro)
                return (
                  <button id="addon-cortesia"
                    onClick={() => {
                      if (!habilitado) return
                      if (enOrden) { setConCortesia(v => !v); setConSeguro(false) }
                      else setModalCortesia(true)
                    }}
                    disabled={!habilitado}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                      padding: '7px 12px', borderRadius: 12, marginTop: 6,
                      border: `2px solid ${cortesiaActiva ? 'var(--corsa-green)' : 'var(--border)'}`,
                      background: cortesiaActiva ? 'rgba(22,25,26,0.05)' : 'var(--surface)',
                      cursor: habilitado ? 'pointer' : 'not-allowed',
                      opacity: habilitado ? 1 : 0.55,
                      transition: 'all 0.12s', textAlign: 'left',
                    }}>
                    <div style={{ width: 20, height: 20, borderRadius: 4, flexShrink: 0, border: `2px solid ${cortesiaActiva ? 'var(--corsa-green)' : 'var(--border)'}`, background: cortesiaActiva ? 'var(--corsa-green)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {cortesiaActiva && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Cortesía</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>
                        {!puedeDarCortesia ? 'Tu rol no puede dar cortesías'
                          : enOrden ? 'Seguro de lluvia sin costo con esta orden'
                          : 'Sin orden: genera un ticket de cortesía'}
                      </div>
                    </div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 13, color: cortesiaActiva ? 'var(--corsa-green)' : 'var(--text-secondary)' }}>
                      $0
                    </div>
                  </button>
                )
              })()}

              {/* ── Este carro ya tiene seguro vivo ── */}
              {polizaVigente && (
                <div style={{
                  marginTop: 10, padding: '11px 14px', borderRadius: 12,
                  border: `2px solid ${canjeandoSeguro ? 'var(--corsa-green)' : 'var(--corsa-orange)'}`,
                  background: canjeandoSeguro ? 'rgba(22,25,26,0.05)' : 'rgba(223,245,107,0.35)',
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    Seguro de lluvia vigente · {polizaVigente.plate}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Le quedan {tiempoRestante(polizaVigente.horas_restantes)} — vence el{' '}
                    {formatearFechaHora(polizaVigente.valid_until)}
                  </div>
                  <button
                    onClick={() => setCanjeandoSeguro(v => !v)}
                    className={canjeandoSeguro ? 'btn btn-ghost' : 'btn btn-primary'}
                    style={{ marginTop: 9, width: '100%', justifyContent: 'center' }}>
                    {canjeandoSeguro ? 'Cancelar el canje' : 'Canjear: lavado PRO sin costo'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Col 3: Cobro */}
          {/* El resumen y el cobro: de columna fija a bloque de ancho completo,
              que en el teléfono queda al final del recorrido — mirar el total y
              cobrar es lo último que se hace. */}
          <div className="card" style={{ flex: esMovil ? '1 1 100%' : '0 0 250px', display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
            <div className="panel-section-label">Resumen</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{svc.name} · {selectedSize}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {SIZES.find(s => s.id === selectedSize)?.sub}
                    {mode === 'flotilla' && <span style={{ color: 'var(--corsa-orange)', marginLeft: 5 }}>· Precio flotilla</span>}
                    {mode === 'normal' && acuerdoGrupo?.servicios[svc.id.toUpperCase() as CodigoServicio] && (
                      <span style={{ color: 'var(--corsa-orange)', marginLeft: 5 }}>· Precio {grupo?.name}</span>
                    )}
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 17, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(servicePrice)}</div>
              </div>
              {withAspirado && (
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>Aspirado</div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--corsa-orange)', fontVariantNumeric: 'tabular-nums' }}>+{fmt(aspiradoPrice)}</div>
                </div>
              )}
              {seguroPrice > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>Seguro de lluvia</div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--corsa-green)', fontVariantNumeric: 'tabular-nums' }}>+{fmt(seguroPrice)}</div>
                </div>
              )}
              {cortesiaActiva && (
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 13, color: 'var(--corsa-green)', fontWeight: 600 }}>Seguro de lluvia · cortesía</div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--corsa-green)' }}>sin costo</div>
                </div>
              )}
              {canjeandoSeguro && (
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 13, color: 'var(--corsa-green)', fontWeight: 600 }}>Canje de seguro de lluvia</div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--corsa-green)' }}>sin costo</div>
                </div>
              )}
            </div>

            <div className="divider"/>

            {/* Cliente */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 10, background: 'var(--subtle-bg)', fontSize: 12, color: 'var(--text-secondary)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {mode === 'flotilla' ? (fleetCompany?.trade_name ?? 'Flotilla') : displayName(customer)}
              </span>
            </div>

            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 14 }}>Total</span>
              {fmt(total)}
            </div>

            {/* El pago y el documento se piden en el modal de cobro: acá sólo
                la orden y su total, para que el botón quede siempre a la vista. */}
            <div className="clip-btn-wrap" style={{ opacity: (!canCharge || submitting) ? 0.55 : 1, pointerEvents: (!canCharge || submitting) ? 'none' : 'auto' }}>
              <div className="clip-btn-corner"/>
              <button id="btn-charge" className="clip-btn large" style={{ width: '100%' }}
                      onClick={abrirCobro}
                      disabled={!canCharge || submitting}>
                {submitting ? 'Procesando…' : `Cobrar ${fmt(total)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Alta rápida ── */}
      {altaCliente && orgId && (
        <ModalNuevoCliente
          orgId={orgId}
          onCancelar={() => setAltaCliente(false)}
          onCreado={cliente => {
            setAltaCliente(false)
            setCustomer(cliente as any)
            // El efecto de arriba carga los vehículos; si vino con uno, queda
            // elegido de una vez.
            if (cliente.vehicle) setVehiculoElegido(cliente.vehicle)
          }}
        />
      )}

      {modalCortesia && branchId && (
        <ModalCortesiaSeguro branchId={branchId} orgId={orgId} onCerrar={() => setModalCortesia(false)}/>
      )}
      {altaVehiculo && orgId && customer?.id && (
        <ModalNuevoVehiculo
          orgId={orgId}
          clienteId={customer.id}
          onCancelar={() => setAltaVehiculo(false)}
          onCreado={v => {
            setAltaVehiculo(false)
            setVehiculos(prev => [...prev, v])
            setVehiculoElegido(v)
          }}
        />
      )}

      {/* Fleet Modal */}
      {showFleetModal && (
        <FleetModal
          onVehicleSelected={handleFleetVehicleSelected}
          onCancel={() => { setShowFleetModal(false); if (!fleetVehicle) setMode('normal') }}
        />
      )}

      {/* Modal de cobro */}
      {showBillingModal && (
        <CobroModal
          customer={customer}
          grupo={mode === 'normal' ? grupo : null}
          total={total}
          pago={bloqueDeCobro}
          pagaConCupon={pagaConCupon}
          cuponValido={voucherFound?.status === 'active'}
          submitting={submitting}
          onTecla={handleKeypad}
          onConfirm={handleBillingConfirm}
          onCanjear={canjearCupon}
          onCancel={() => setShowBillingModal(false)}
        />
      )}
    </div>
  )
}
