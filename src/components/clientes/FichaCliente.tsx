/**
 * CORSA Carwash — ficha del cliente.
 *
 * Reemplaza el panel lateral de Clientes: una tarjeta propia, ordenada por
 * secciones, con todo lo que se hace con un cliente —contacto, información
 * fiscal, vehículos, crédito, membresía— en un solo lugar.
 *
 * Lo que la ficha muestra en rojo es lo que impide facturarle: a toda persona
 * jurídica se le emite CCF, y si le falta un dato del CCF se dice cuál.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import {
  getCustomerVehicles, getCustomerMetrics, getMembershipPlans, updateCustomer, type CustomerWithStats,
} from '../../services/customers.service'
import {
  cambiarLimite, deshabilitarCredito, fetchCuentaCredito, habilitarCredito, type CuentaCredito,
} from '../../services/credito.service'
import { ccfReceptorStatus, requiereCcf } from '../../lib/fiscal/receptor'
import { VehiculosClienteModal } from '../VehiculosClienteModal'
import { CustomerFormPanel } from '../CustomerFormPanel'
import type { Vehicle } from '../../types'

function money(n: number) { return 'US$' + (Number(n) || 0).toFixed(2) }

export function nombreCliente(c: CustomerWithStats): string {
  if (c.customer_type === 'individual') return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '—'
  return c.trade_name || c.legal_name || '—'
}

function Seccion({ titulo, accion, children }: { titulo: string; accion?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 16, padding: 16, background: 'var(--surface)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{titulo}</div>
        {accion}
      </div>
      {children}
    </section>
  )
}

function Dato({ label, valor, fuerte }: { label: string; valor: React.ReactNode; fuerte?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: fuerte ? 20 : 14, fontWeight: fuerte ? 800 : 600, fontFamily: fuerte ? 'var(--font-heading)' : undefined, color: 'var(--text-primary)', marginTop: 2, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' }}>{valor}</div>
    </div>
  )
}

export function FichaCliente({ customer, orgId, onCerrar, onActualizado }: {
  customer: CustomerWithStats
  orgId: string
  onCerrar: () => void
  onActualizado: () => void
}) {
  const { hasPermission } = useAuth()
  const navigate = useNavigate()
  const verCredito = hasPermission('corporate.read') || hasPermission('corporate.manage')
  const adminCredito = hasPermission('corporate.manage')
  const verCxc = hasPermission('screens.receivables')

  const [vehiculos, setVehiculos] = useState<Vehicle[]>([])
  const [metricas, setMetricas] = useState<any>(null)
  const [planes, setPlanes] = useState<any[]>([])
  const [grupo, setGrupo] = useState<string | null>(null)
  const [cuenta, setCuenta] = useState<CuentaCredito | null>(null)
  const [modalVehiculos, setModalVehiculos] = useState(false)
  // Formulario de crédito: 'activar' o 'limite'.
  const [formCredito, setFormCredito] = useState<null | 'activar' | 'limite'>(null)
  const [limite, setLimite] = useState('')
  const [dias, setDias] = useState('30')
  const [guardando, setGuardando] = useState(false)
  // Editar la ficha pasa adentro de la misma tarjeta, no en otro panel.
  const [editando, setEditando] = useState(false)
  const onEditar = () => setEditando(true)

  const nombre = nombreCliente(customer)
  const esEmpresa = customer.customer_type === 'company'
  const ccf = requiereCcf(customer)
  const estadoFiscal = ccfReceptorStatus(customer)
  const pendiente = ccf && !estadoFiscal.ok

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || modalVehiculos) return
      if (editando) setEditando(false); else onCerrar()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar, modalVehiculos, editando])

  const cargarCredito = useCallback(async () => {
    if (!verCredito) return
    setCuenta(await fetchCuentaCredito(customer.id).catch(() => null))
  }, [customer.id, verCredito])

  useEffect(() => {
    Promise.all([
      getCustomerVehicles(customer.id).catch(() => []),
      getCustomerMetrics(customer.id).catch(() => null),
      getMembershipPlans(orgId).catch(() => []),
    ]).then(([v, m, p]) => { setVehiculos(v as Vehicle[]); setMetricas(m); setPlanes(p as any[]) })
    cargarCredito()
    const gid = (customer as any).business_group_id
    if (gid) {
      ;(supabase as any).from('business_groups').select('name').eq('id', gid).maybeSingle()
        .then(({ data }: any) => setGrupo(data?.name ?? null))
    } else setGrupo(null)
  }, [customer, orgId, cargarCredito])

  const quickEdit = async (campo: 'email' | 'phone', valor: string, input: HTMLInputElement) => {
    const actual = customer[campo] ?? ''
    if (valor === actual) return
    try {
      await updateCustomer(customer.id, { [campo]: valor || null })
      toast.success('Guardado')
      onActualizado()
    } catch (err) {
      const m = err instanceof Error ? err.message : ''
      toast.error(/ccf_requires_fiscal_data/.test(m)
        ? 'Este cliente emite CCF: no puede quedarse sin teléfono ni correo'
        : 'No se pudo guardar el cambio')
      input.value = actual
    }
  }

  const guardarCredito = async () => {
    const monto = Math.round(parseFloat(limite) * 100) / 100
    if (!Number.isFinite(monto) || monto <= 0) { toast.error('Ingresá un límite mayor que cero'); return }
    setGuardando(true)
    try {
      if (formCredito === 'activar') {
        const d = parseInt(dias, 10)
        await habilitarCredito(customer.id, monto, Number.isFinite(d) && d > 0 ? d : 30)
        toast.success(`Crédito activado · límite ${money(monto)}`)
      } else {
        await cambiarLimite(customer.id, monto)
        toast.success(`Límite actualizado a ${money(monto)}`)
      }
      setFormCredito(null)
      await cargarCredito()
      onActualizado()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar el crédito')
    }
    setGuardando(false)
  }

  const desactivar = async () => {
    const motivo = window.prompt('¿Por qué se desactiva el crédito? (el saldo pendiente se sigue cobrando)')
    if (!motivo?.trim()) return
    try {
      await deshabilitarCredito(customer.id, motivo.trim())
      toast.success('Crédito desactivado')
      await cargarCredito(); onActualizado()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo desactivar')
    }
  }

  const iniciales = nombre.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase()
  const ultimaVisita = metricas?.days_since_last_visit == null ? 'Sin visitas'
    : metricas.days_since_last_visit === 0 ? 'Hoy'
    : metricas.days_since_last_visit === 1 ? 'Hace 1 día'
    : `Hace ${metricas.days_since_last_visit} días`
  const creditoActivo = Boolean(cuenta?.credit_enabled)
  const usado = cuenta && cuenta.credit_limit > 0 ? Math.min(100, (cuenta.current_balance / cuenta.credit_limit) * 100) : 0

  return createPortal(
    <div className="ficha-fondo" onClick={e => { if (e.target === e.currentTarget) onCerrar() }}>
      <div className="ficha" role="dialog" aria-label={`Ficha de ${nombre}`}>
        {/* ── Encabezado ── */}
        <header className="ficha-cabecera">
          <div className="ficha-avatar">{iniciales || '·'}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ficha-nombre">{nombre}</div>
            {esEmpresa && customer.trade_name && customer.legal_name && customer.trade_name !== customer.legal_name && (
              <div style={{ fontSize: 12.5, opacity: 0.75 }}>{customer.legal_name}</div>
            )}
            <div className="ficha-etiquetas">
              <span className="ficha-etiqueta">{esEmpresa ? 'Persona jurídica' : 'Persona natural'}</span>
              <span className="ficha-etiqueta lima">{ccf ? 'Crédito fiscal (CCF)' : 'Consumidor final'}</span>
              {pendiente && <span className="ficha-etiqueta roja">Información fiscal pendiente</span>}
              {grupo && <span className="ficha-etiqueta">Grupo {grupo}</span>}
              {creditoActivo && <span className="ficha-etiqueta">Crédito activo</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            {editando
              ? <button className="ficha-btn-claro" onClick={() => setEditando(false)}>← Volver a la ficha</button>
              : <button id="btn-editar-ficha" className="ficha-btn-claro" onClick={onEditar}>Editar ficha</button>}
            <button className="ficha-cerrar" onClick={onCerrar} aria-label="Cerrar">×</button>
          </div>
        </header>

        {editando ? (
          <div className="ficha-edicion">
            <CustomerFormPanel customer={customer as any} orgId={orgId} embebido
              onClose={() => setEditando(false)}
              onSaved={() => { setEditando(false); onActualizado() }}/>
          </div>
        ) : (<>

        {/* ── Indicadores ── */}
        <div className="ficha-indicadores">
          <Dato label="Visitas" valor={metricas?.total_orders ?? '—'} fuerte/>
          <Dato label="Acumulado" valor={metricas?.lifetime_value ? money(parseFloat(metricas.lifetime_value)) : '—'} fuerte/>
          <Dato label="Última visita" valor={ultimaVisita} fuerte/>
          <Dato label="Vehículos" valor={vehiculos.length} fuerte/>
          {creditoActivo && <Dato label="Saldo por cobrar" valor={money(cuenta!.current_balance)} fuerte/>}
        </div>

        <div className="ficha-cuerpo">
          <div className="ficha-columna">
            <Seccion titulo="Contacto">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="ficha-campo">
                  <span>Correo</span>
                  <input className="corsa-input" defaultValue={customer.email ?? ''} placeholder="correo@cliente.com"
                         onBlur={e => quickEdit('email', e.target.value, e.target)}/>
                </label>
                <label className="ficha-campo">
                  <span>Teléfono</span>
                  <input className="corsa-input" defaultValue={customer.phone ?? ''} placeholder="7777-8888"
                         onBlur={e => quickEdit('phone', e.target.value, e.target)}/>
                </label>
              </div>
            </Seccion>

            <Seccion titulo="Información fiscal"
              accion={<button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={onEditar}>{pendiente ? 'Completar' : 'Editar'}</button>}>
              {pendiente && (
                <div className="ficha-alerta">
                  <strong>Información fiscal pendiente.</strong> Para emitirle CCF falta: {estadoFiscal.missing.join(', ')}.
                </div>
              )}
              {ccf ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {estadoFiscal.fields.map(f => (
                    <div key={f.label} className="ficha-fila-fiscal">
                      <span className={`ficha-marca ${f.ok ? 'ok' : 'mal'}`}>{f.ok ? '✓' : '!'}</span>
                      <span style={{ width: 92, flexShrink: 0, color: 'var(--text-secondary)' }}>{f.label}</span>
                      <span style={{ fontWeight: 600, minWidth: 0, wordBreak: 'break-word' }}>{f.value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Dato label="Documento" valor="Consumidor final"/>
                  <Dato label="DUI" valor={customer.dui || '—'}/>
                  <Dato label="NIT" valor={customer.nit || '—'}/>
                  <Dato label="Correo de facturación" valor={customer.billing_email || customer.email || '—'}/>
                </div>
              )}
            </Seccion>

            <Seccion titulo="Membresía">
              {customer.membership_status && customer.membership_status !== 'none' ? (
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {customer.membership_plan ?? 'Membresía'} · {customer.membership_status === 'active' ? 'activa' : 'por vencer'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin membresía. Planes disponibles:</div>
                  {planes.slice(0, 3).map(p => (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{p.name}</span><strong>{money(parseFloat(p.price))}/mes</strong>
                    </div>
                  ))}
                </div>
              )}
            </Seccion>
          </div>

          <div className="ficha-columna">
            <Seccion titulo={`Vehículos (${vehiculos.length})`}
              accion={<button id="btn-vehiculos-cliente" className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => setModalVehiculos(true)}>Agregar vehículo</button>}>
              {vehiculos.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Sin vehículos registrados.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {vehiculos.map(v => (
                    <div key={v.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 10 }}>
                      <span className="font-mono" style={{ fontWeight: 800, fontSize: 13.5 }}>{v.plate ?? '—'}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {[v.brand, v.model, v.color].filter(Boolean).join(' · ') || '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Seccion>

            {verCredito && (
              <Seccion titulo="Crédito"
                accion={creditoActivo && verCxc
                  ? <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => navigate(`/receivables?cliente=${customer.id}`)}>Estado de cuenta</button>
                  : undefined}>
                {!creditoActivo && !formCredito && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      {cuenta && cuenta.current_balance > 0
                        ? `Crédito desactivado. Saldo pendiente: ${money(cuenta.current_balance)}.`
                        : 'Este cliente paga al momento. Con crédito, en caja puede pagar con «Crédito emp.» hasta su límite.'}
                    </div>
                    {adminCredito && (
                      <button id="btn-activar-credito" className="btn btn-primary" style={{ justifyContent: 'center' }}
                              onClick={() => { setFormCredito('activar'); setLimite(''); setDias(String(cuenta?.credit_days || 30)) }}>
                        Activar crédito
                      </button>
                    )}
                  </div>
                )}

                {creditoActivo && !formCredito && cuenta && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                      <Dato label="Límite" valor={money(cuenta.credit_limit)}/>
                      <Dato label="Saldo" valor={money(cuenta.current_balance)}/>
                      <Dato label="Disponible" valor={money(Math.max(0, cuenta.credit_limit - cuenta.current_balance))}/>
                    </div>
                    <div className="ficha-barra"><div style={{ width: `${usado}%`, background: usado >= 90 ? 'var(--color-danger-text)' : 'var(--corsa-green)' }}/></div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {Math.round(usado)}% usado · cada venta vence a {cuenta.credit_days} días{cuenta.blocked ? ' · CUENTA BLOQUEADA' : ''}
                    </div>
                    {adminCredito && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }}
                                onClick={() => { setFormCredito('limite'); setLimite(String(cuenta.credit_limit)) }}>Cambiar límite</button>
                        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center', color: 'var(--color-danger-text)' }}
                                onClick={desactivar}>Desactivar</button>
                      </div>
                    )}
                  </div>
                )}

                {formCredito && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: formCredito === 'activar' ? '1fr 1fr' : '1fr', gap: 10 }}>
                      <label className="ficha-campo">
                        <span>Crédito máximo (US$)</span>
                        <input id="credito-limite" className="corsa-input" type="number" min="1" step="10" autoFocus
                               value={limite} onChange={e => setLimite(e.target.value)} placeholder="500.00"/>
                      </label>
                      {formCredito === 'activar' && (
                        <label className="ficha-campo">
                          <span>Días para pagar</span>
                          <input id="credito-dias" className="corsa-input" type="number" min="1" step="1"
                                 value={dias} onChange={e => setDias(e.target.value)}/>
                        </label>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setFormCredito(null)}>Cancelar</button>
                      <button id="credito-guardar" className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}
                              onClick={guardarCredito} disabled={guardando}>
                        {guardando ? 'Guardando…' : formCredito === 'activar' ? 'Activar crédito' : 'Guardar límite'}
                      </button>
                    </div>
                  </div>
                )}
              </Seccion>
            )}
          </div>
        </div>
        </>)}
      </div>

      {modalVehiculos && (
        <VehiculosClienteModal orgId={orgId} customerId={customer.id} customerName={nombre}
          onCerrar={() => setModalVehiculos(false)}
          onCambio={async () => { setVehiculos(await getCustomerVehicles(customer.id).catch(() => [])); onActualizado() }}/>
      )}
    </div>,
    document.body,
  )
}
