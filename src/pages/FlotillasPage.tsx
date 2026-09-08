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
  address: string | null
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
  aspirado_enabled: boolean
  aspirado_price: number | null
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

/** Cliente existente que puede convertirse en flotilla. */
interface ExistingCustomer {
  id: string
  customer_type: string
  trade_name: string | null
  legal_name: string | null
  nit: string | null
  email: string | null
  phone: string | null
  address: string | null
}

function customerLabel(c: ExistingCustomer): string {
  return c.trade_name || c.legal_name || '(sin nombre)'
}

function CreateCompanyModal({ orgId, onCreated, onCancel }: CreateCompanyModalProps) {
  // Origen del cliente: buscarlo en el sistema o darlo de alta acá.
  // Antes sólo existía la segunda opción, así que una empresa que ya era
  // cliente terminaba duplicada al convertirla en flotilla.
  const [origen, setOrigen] = useState<'existente' | 'nuevo'>('existente')

  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState<ExistingCustomer[]>([])
  const [buscando, setBuscando] = useState(false)
  const [elegido, setElegido] = useState<ExistingCustomer | null>(null)

  const [form, setForm] = useState({
    trade_name: '', legal_name: '', nit: '',
    email: '', phone: '', address: '',
    fleet_name: '', fleet_code: '',
  })
  const [elitePerSize, setElitePerSize] = useState(false)
  const [elitePrice, setElitePrice] = useState('10.00')
  const [eliteS, setEliteS] = useState('8.00')
  const [eliteM, setEliteM] = useState('10.00')
  const [eliteL, setEliteL] = useState('11.00')
  const [aspirado, setAspirado] = useState(false)
  const [aspiradoPrice, setAspiradoPrice] = useState('2.50')
  const [saving, setSaving] = useState(false)

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  // Búsqueda de clientes ya registrados (empresas y personas: una flotilla
  // puede estar a nombre de una persona natural).
  useEffect(() => {
    if (origen !== 'existente' || elegido || query.trim().length < 2) {
      setResultados([])
      return
    }
    const t = setTimeout(async () => {
      setBuscando(true)
      const term = query.trim()
      const { data } = await (supabase as any)
        .from('customers')
        .select('id, customer_type, trade_name, legal_name, nit, email, phone, address')
        .or(`trade_name.ilike.%${term}%,legal_name.ilike.%${term}%,nit.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`)
        .eq('active', true)
        .limit(8)
      setResultados(data ?? [])
      setBuscando(false)
    }, 300)
    return () => clearTimeout(t)
  }, [query, origen, elegido])

  const nombreEmpresa = elegido ? customerLabel(elegido) : form.trade_name.trim()

  const handleSave = async () => {
    if (origen === 'existente' && !elegido) {
      toast.error('Elegí el cliente o creá uno nuevo')
      return
    }
    if (origen === 'nuevo' && !form.trade_name.trim() && !form.legal_name.trim()) {
      toast.error('Ingresá el nombre de la empresa')
      return
    }
    const precioUnico = parseFloat(elitePrice)
    if (!elitePerSize && !(precioUnico >= 0)) {
      toast.error('Ingresá el precio ÉLITE negociado')
      return
    }
    if (elitePerSize && [eliteS, eliteM, eliteL].some(v => !(parseFloat(v) >= 0))) {
      toast.error('Completá los tres precios por tamaño')
      return
    }
    if (aspirado && !(parseFloat(aspiradoPrice) >= 0)) {
      toast.error('Ingresá el precio del aspirado')
      return
    }

    setSaving(true)
    try {
      const db = supabase as any
      let customerId = elegido?.id

      if (!customerId) {
        // Las columnas son `address` y `active`: antes se insertaba
        // address_line1 y status, que no existen en customers, y el alta
        // fallaba entera.
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
            address: form.address.trim() || null,
            active: true,
          })
          .select('id')
          .single()
        if (custErr) throw custErr
        customerId = cust.id
      }

      // Cuenta corporativa sin crédito: la flotilla paga al momento. La cuenta
      // se crea igual porque es lo que marca al cliente como corporativo.
      const { data: cuenta } = await db
        .from('corporate_accounts')
        .select('id').eq('customer_id', customerId).maybeSingle()

      if (!cuenta) {
        const { error: accErr } = await db.from('corporate_accounts').insert({
          customer_id: customerId,
          credit_limit: 0,
          credit_days: 0,
          credit_status: 'active',
          current_balance: 0,
          blocked: false,
        })
        if (accErr) throw accErr
      }

      const baseNombre = nombreEmpresa || 'FLOTILLA'
      const fleetCode = form.fleet_code.trim()
        || baseNombre.replace(/\s+/g, '-').toUpperCase().slice(0, 10)

      const { data: fleet, error: fleetErr } = await db
        .from('fleets')
        .insert({
          organization_id: orgId,
          customer_id: customerId,
          name: form.fleet_name.trim() || baseNombre,
          code: fleetCode,
          active: true,
        })
        .select('id')
        .single()
      if (fleetErr) throw fleetErr

      // El error se revisa: antes se ignoraba y la RLS faltante lo rechazaba
      // en silencio, dejando flotillas sin contrato.
      const { error: contractErr } = await db.from('fleet_contracts').insert({
        fleet_id: fleet.id,
        starts_at: new Date().toISOString().split('T')[0],
        billing_frequency: 'monthly',
        credit_limit: 0,
        credit_days: 0,
        active: true,
      })
      if (contractErr) throw contractErr

      // Los precios van a fleet_pricing (0031), no serializados en terms.
      const { error: priceErr } = await db.from('fleet_pricing').insert({
        fleet_id: fleet.id,
        elite_per_size: elitePerSize,
        elite_price: elitePerSize ? null : parseFloat(elitePrice),
        elite_price_s: elitePerSize ? parseFloat(eliteS) : null,
        elite_price_m: elitePerSize ? parseFloat(eliteM) : null,
        elite_price_l: elitePerSize ? parseFloat(eliteL) : null,
        aspirado_enabled: aspirado,
        aspirado_price: aspirado ? parseFloat(aspiradoPrice) : null,
      })
      if (priceErr) throw priceErr

      toast.success(`Flotilla ${baseNombre} creada ✓`)
      onCreated()
    } catch (err: any) {
      toast.error(err?.message ?? 'Error al crear la flotilla')
    }
    setSaving(false)
  }

  const seccion = (t: string, color = 'var(--corsa-green)') => (
    <div style={{ fontSize: 12, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>{t}</div>
  )

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 700, fontSize: 20, color: 'var(--text-primary)' }}>Nueva flotilla</div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ── Cliente ── */}
          <div>
            {seccion('Cliente')}
            <div className="filter-pills" style={{ marginBottom: 12 }}>
              <button className={`filter-pill${origen === 'existente' ? ' active' : ''}`}
                      onClick={() => setOrigen('existente')}>Ya es cliente</button>
              <button className={`filter-pill${origen === 'nuevo' ? ' active' : ''}`}
                      onClick={() => { setOrigen('nuevo'); setElegido(null) }}>Registrar uno nuevo</button>
            </div>

            {origen === 'existente' ? (
              elegido ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 7, border: '1.5px solid var(--corsa-green)', background: 'rgba(2,53,48,0.05)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{customerLabel(elegido)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>
                      {[elegido.nit ? `NIT ${elegido.nit}` : null, elegido.phone, elegido.email]
                        .filter(Boolean).join(' · ') || 'Sin datos de contacto'}
                    </div>
                  </div>
                  <button onClick={() => { setElegido(null); setQuery('') }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>×</button>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <input className="corsa-input" value={query} onChange={e => setQuery(e.target.value)}
                         placeholder="Buscá por nombre, razón social o NIT…" autoFocus/>
                  {buscando && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>Buscando…</div>}
                  {resultados.length > 0 && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 300, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', maxHeight: 220, overflowY: 'auto' }}>
                      {resultados.map(c => (
                        <button key={c.id} onClick={() => { setElegido(c); setResultados([]) }}
                          style={{ width: '100%', textAlign: 'left', padding: '9px 13px', border: 'none', background: 'transparent', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{customerLabel(c)}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                            {c.nit ? `NIT ${c.nit}` : c.customer_type === 'company' ? 'Empresa' : 'Persona'}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {query.trim().length >= 2 && !buscando && resultados.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                      Sin coincidencias. Podés registrarlo como cliente nuevo.
                    </div>
                  )}
                </div>
              )
            ) : (
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
                  <input className="corsa-input" value={form.address} onChange={e => set('address', e.target.value)} placeholder="Calle Principal #123, San Salvador"/>
                </div>
                <div style={{ gridColumn: '1/-1', fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  Para emitir CCF hacen falta más datos fiscales; se completan en Clientes.
                </div>
              </div>
            )}
          </div>

          <div className="divider"/>

          {/* ── Flotilla ── */}
          <div>
            {seccion('Datos de la flotilla')}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>Nombre de la flotilla</label>
                <input className="corsa-input" value={form.fleet_name} onChange={e => set('fleet_name', e.target.value)}
                       placeholder={nombreEmpresa || 'Flotilla principal'}/>
              </div>
              <div className="field">
                <label>Código</label>
                <input className="corsa-input" value={form.fleet_code} onChange={e => set('fleet_code', e.target.value.toUpperCase())} placeholder="DIST-CENTRAL"/>
              </div>
            </div>
          </div>

          <div className="divider"/>

          {/* ── Precios ── */}
          <div>
            {seccion('Precio negociado ÉLITE', 'var(--corsa-orange)')}

            <label style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={elitePerSize}
                     onChange={e => setElitePerSize(e.target.checked)}
                     style={{ accentColor: 'var(--corsa-green)' }}/>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                Valor personalizado por tamaño
              </span>
            </label>

            {elitePerSize ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                {[
                  { label: 'S · Pequeño', v: eliteS, set: setEliteS },
                  { label: 'M · Mediano', v: eliteM, set: setEliteM },
                  { label: 'L · Grande',  v: eliteL, set: setEliteL },
                ].map(f => (
                  <div key={f.label} className="field">
                    <label>{f.label}</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>$</span>
                      <input className="corsa-input" type="number" step="0.50" min="0"
                             value={f.v} onChange={e => f.set(e.target.value)}/>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="field">
                <label>Precio para cualquier tamaño</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: 200 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>$</span>
                  <input className="corsa-input" type="number" step="0.50" min="0"
                         value={elitePrice} onChange={e => setElitePrice(e.target.value)}/>
                </div>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
                <input type="checkbox" checked={aspirado}
                       onChange={e => setAspirado(e.target.checked)}
                       style={{ accentColor: 'var(--corsa-green)' }}/>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  Incluir aspirado de interiores
                </span>
              </label>
              {aspirado && (
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Precio del aspirado · cualquier tamaño</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: 200 }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>$</span>
                    <input className="corsa-input" type="number" step="0.50" min="0"
                           value={aspiradoPrice} onChange={e => setAspiradoPrice(e.target.value)}/>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="btn btn-ghost">Cancelar</button>
          <div className="clip-btn-wrap" style={{ opacity: saving ? 0.6 : 1 }}>
            <div className="clip-btn-corner"/>
            <button id="fleet-save" className="clip-btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Guardando…' : 'Crear flotilla'}
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

function AddVehicleModal({ fleetId, customerId, orgId, onAdded, onCancel }: AddVehicleModalProps) {
  const [form, setForm] = useState({ plate: '', brand: '', model: '', year: '', color: '', cost_center: '' })
  const [tipos, setTipos] = useState<{ id: string; code: string; name: string }[]>([])
  const [tipoId, setTipoId] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  // vehicles.vehicle_type_id es NOT NULL: sin elegir tipo no se puede dar de
  // alta el vehículo, así que el selector es obligatorio.
  useEffect(() => {
    if (!orgId) return
    ;(async () => {
      const { data } = await (supabase as any)
        .from('vehicle_types')
        .select('id, code, name')
        .eq('organization_id', orgId)
        .eq('active', true)
        .order('sort_order')
      setTipos(data ?? [])
      // Sedán es el caso más común en flotillas administrativas.
      const sedan = (data ?? []).find((t: any) => t.code === 'SEDAN')
      setTipoId(sedan?.id ?? data?.[0]?.id ?? '')
    })()
  }, [orgId])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  const handleSave = async () => {
    const plate = form.plate.trim().toUpperCase()
    if (!plate) { toast.error('La placa es requerida'); return }
    if (!tipoId) { toast.error('Elegí el tipo de vehículo'); return }

    setSaving(true)
    try {
      const db = supabase as any
      const normalizada = plate.replace(/[^A-Z0-9]/g, '')

      // Un auto puede estar ya registrado como vehículo de un cliente y recién
      // ahora sumarse a la flotilla. Antes se creaba uno nuevo con la misma
      // placa y quedaban dos fichas del mismo carro.
      const { data: existente } = await db
        .from('vehicles')
        .select('id, plate')
        .eq('organization_id', orgId)
        .eq('normalized_plate', normalizada)
        .maybeSingle()

      let vehicleId = existente?.id

      if (!vehicleId) {
        // El insert fallaba por tres motivos a la vez: mandaba `status`, que
        // no existe (es `active`), y omitía organization_id y vehicle_type_id,
        // ambos NOT NULL.
        const { data: veh, error: vehErr } = await db
          .from('vehicles')
          .insert({
            organization_id: orgId,
            customer_id: customerId,
            vehicle_type_id: tipoId,
            plate,
            brand: form.brand.trim() || null,
            model: form.model.trim() || null,
            year: form.year ? parseInt(form.year) : null,
            color: form.color.trim() || null,
            active: true,
          })
          .select('id')
          .single()
        if (vehErr) throw vehErr
        vehicleId = veh.id
      }

      // Si ya estaba en la flotilla se reactiva en vez de duplicar la fila.
      const { error: fvErr } = await db
        .from('fleet_vehicles')
        .upsert({
          fleet_id: fleetId,
          vehicle_id: vehicleId,
          cost_center: form.cost_center.trim() || null,
          active: true,
        }, { onConflict: 'fleet_id,vehicle_id' })
      if (fvErr) throw fvErr

      toast.success(existente
        ? `${plate} ya estaba registrado y se sumó a la flotilla ✓`
        : `Vehículo ${plate} agregado ✓`)
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
            <div className="field" style={{ gridColumn: '1/-1' }}>
              <label>Tipo de vehículo *</label>
              <select className="corsa-input" value={tipoId} onChange={e => setTipoId(e.target.value)}>
                {tipos.length === 0 && <option value="">Cargando…</option>}
                {tipos.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
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
      // Se consulta desde `fleets`, no desde `customers`.
      // Antes se pedía la columna address_line1, que no existe en customers:
      // la consulta fallaba entera y la pantalla quedaba vacía. Además
      // filtraba customer_type='company', así que una flotilla a nombre de
      // una persona nunca aparecía.
      const { data: rows, error } = await (supabase as any)
        .from('fleets')
        .select(`
          id, name, code, active, customer_id,
          customers!inner(
            id, customer_type, trade_name, legal_name, nit, email, phone, address,
            corporate_accounts(id, credit_limit, credit_status, current_balance, blocked)
          )
        `)
        .eq('organization_id', orgId)
        .eq('active', true)

      if (error) throw error
      if (!rows) { setLoading(false); return }

      const result: FleetCompany[] = await Promise.all(
        rows.map(async (row: any) => {
          const c = row.customers ?? {}
          const acc = c.corporate_accounts?.[0]
          const fleet = { id: row.id, name: row.name, code: row.code }
          let vehicleCount = 0
          let prices = { s: null as number | null, m: null as number | null, l: null as number | null }
          let aspiradoEnabled = false
          let aspiradoPrice: number | null = null

          if (fleet) {
            const { count } = await (supabase as any)
              .from('fleet_vehicles')
              .select('*', { count: 'exact', head: true })
              .eq('fleet_id', fleet.id)
              .eq('active', true)
            vehicleCount = count ?? 0

            // Precios desde fleet_pricing (0031). Antes había que parsear el
            // JSON guardado en fleet_contracts.terms, un campo de texto libre.
            const { data: fp } = await (supabase as any)
              .from('fleet_pricing')
              .select('elite_per_size, elite_price, elite_price_s, elite_price_m, elite_price_l, aspirado_enabled, aspirado_price')
              .eq('fleet_id', fleet.id)
              .maybeSingle()

            if (fp) {
              prices = fp.elite_per_size
                ? { s: fp.elite_price_s, m: fp.elite_price_m, l: fp.elite_price_l }
                // Precio único: el mismo para los tres tamaños.
                : { s: fp.elite_price, m: fp.elite_price, l: fp.elite_price }
              aspiradoEnabled = fp.aspirado_enabled
              aspiradoPrice = fp.aspirado_price
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
            address: c.address ?? null,
            account_id: acc?.id ?? null,
            credit_limit: acc?.credit_limit ?? 0,
            credit_status: acc?.credit_status ?? 'active',
            current_balance: acc?.current_balance ?? 0,
            blocked: acc?.blocked ?? false,
            fleet_id: fleet?.id ?? null,
            fleet_name: fleet?.name ?? null,
            fleet_code: fleet?.code ?? null,
            aspirado_enabled: aspiradoEnabled,
            aspirado_price: aspiradoPrice,
            elite_price_s: prices.s,
            elite_price_m: prices.m,
            elite_price_l: prices.l,
            vehicle_count: vehicleCount,
          } as FleetCompany
        })
      )

      setCompanies(result)
    } catch (err: any) {
      // Antes el catch era mudo: la consulta rota no dejaba rastro y la
      // pantalla simplemente aparecía vacía.
      toast.error(err?.message ?? 'No se pudieron cargar las flotillas')
    }
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
                    ) : c.aspirado_enabled ? (
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '2px 6px', borderRadius: 4 }}>
                        + aspirado {c.aspirado_price != null ? fmt(c.aspirado_price) : ''}
                      </span>
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
                  {selected.address && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>📍 {selected.address}</div>}
                </div>

                {/* El bloque de crédito disponible se retira: hoy las flotillas
                    pagan al momento. Las columnas de corporate_accounts siguen
                    ahí para cuando se habilite el crédito. */}
              </div>

              {/* Special prices */}
              {(selected.elite_price_s || selected.elite_price_m || selected.elite_price_l || selected.aspirado_enabled) && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--corsa-orange)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Precio especial ÉLITE</div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    {/* Con precio único los tres tamaños coinciden: mostrar tres
                        veces la misma cifra sugeriría una tarifa escalonada que
                        no existe. */}
                    {(selected.elite_price_s === selected.elite_price_m
                      && selected.elite_price_m === selected.elite_price_l)
                      ? (
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 22, color: 'var(--corsa-orange)', fontVariantNumeric: 'tabular-nums' }}>
                            {selected.elite_price_s != null ? `$${selected.elite_price_s}` : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Cualquier tamaño</div>
                        </div>
                      )
                      : [['S · Pequeños', selected.elite_price_s], ['M · Medianos', selected.elite_price_m], ['L · Grandes', selected.elite_price_l]].map(([label, price]) => (
                        <div key={String(label)} style={{ textAlign: 'center' }}>
                          <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 22, color: 'var(--corsa-orange)', fontVariantNumeric: 'tabular-nums' }}>
                            {price ? `$${price}` : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</div>
                        </div>
                      ))}

                    {selected.aspirado_enabled && (
                      <div style={{ textAlign: 'center', paddingLeft: 16, borderLeft: '1px solid var(--border)' }}>
                        <div style={{ fontFamily: "'Archivo',sans-serif", fontWeight: 800, fontSize: 22, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                          {selected.aspirado_price != null ? `$${selected.aspirado_price}` : '—'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Aspirado · cualquier tamaño</div>
                      </div>
                    )}
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
