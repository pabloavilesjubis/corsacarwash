/**
 * CORSA Carwash — ficha del cliente.
 *
 * Reemplaza el panel lateral de Clientes: una tarjeta propia, ordenada por
 * secciones, con todo lo que se hace con un cliente —contacto, información
 * fiscal, vehículos, crédito, tarifario especial, membresía— en un solo lugar.
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
  cambiarLimite, deshabilitarCredito, fetchCuentaCredito, habilitarCredito, setFacturacionConsolidada, type CuentaCredito,
} from '../../services/credito.service'
import { ccfReceptorStatus, requiereCcf } from '../../lib/fiscal/receptor'
import { VehiculosClienteModal } from '../VehiculosClienteModal'
import { EditorPrecios } from '../EditorPrecios'
import { lineasDesde, SERVICIOS_FLOTILLA, type LineasEditables } from '../../lib/flotillas/precios'
import {
  cargarTarifario, guardarTarifario, habilitarTarifario, problemaDeTarifario, type Tarifario,
} from '../../lib/clientes/tarifario'
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
  // Los precios negociados (flotillas, grupos, tarifario especial) los fija quien tiene corporate.manage.
  const adminPrecios = adminCredito
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
  // Tarifario especial (0071). undefined: cargando o sin la migración.
  const [tarifario, setTarifario] = useState<Tarifario | null | undefined>(undefined)
  const [editandoTarifa, setEditandoTarifa] = useState(false)
  const [lineas, setLineas] = useState<LineasEditables>(() => lineasDesde(null))
  const [aspirado, setAspirado] = useState({ activo: false, precio: '' })
  const [guardandoTarifa, setGuardandoTarifa] = useState(false)
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

  const recargarTarifario = useCallback(() => {
    cargarTarifario(customer.id).then(setTarifario).catch(() => setTarifario(undefined))
  }, [customer.id])
  useEffect(() => { setEditandoTarifa(false); recargarTarifario() }, [recargarTarifario])

  const abrirEditorTarifa = () => {
    const a = tarifario?.acuerdo ?? null
    setLineas(lineasDesde(a))
    setAspirado({ activo: Boolean(a?.aspirado.activo), precio: a?.aspirado.precio != null ? a.aspirado.precio.toFixed(2) : '3.00' })
    setEditandoTarifa(true)
  }

  const guardarTarifa = async () => {
    const problema = problemaDeTarifario(lineas, aspirado)
    if (problema) { toast.error(problema); return }
    setGuardandoTarifa(true)
    try {
      await guardarTarifario(customer.id, orgId, lineas, aspirado)
      toast.success('Tarifario especial guardado')
      setEditandoTarifa(false)
      recargarTarifario()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar el tarifario')
    }
    setGuardandoTarifa(false)
  }

  const cambiarHabilitadoTarifa = async (habilitado: boolean) => {
    if (!habilitado && !window.confirm('¿Desactivar el tarifario especial? El cliente vuelve a pagar tarifa de lista; los precios quedan guardados.')) return
    try {
      await habilitarTarifario(customer.id, habilitado)
      toast.success(habilitado ? 'Tarifario especial activado' : 'Tarifario especial desactivado')
      recargarTarifario()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cambiar el tarifario')
    }
  }

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

  const cambiarConsolidada = async (activa: boolean) => {
    const msg = activa
      ? 'Con facturación consolidada, las ventas al crédito de este cliente NO emiten DTE en caja: quedan en CxC y se facturan juntas en un CCF desde Cuentas por cobrar. ¿Activar?'
      : 'Las próximas ventas al crédito volverán a emitir su DTE en caja. Los lavados pendientes se siguen facturando desde CxC. ¿Desactivar?'
    if (!window.confirm(msg)) return
    try {
      await setFacturacionConsolidada(customer.id, activa)
      toast.success(activa ? 'Facturación consolidada activada' : 'Facturación consolidada desactivada')
      await cargarCredito(); onActualizado()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cambiar')
    }
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
              {creditoActivo && <span className="ficha-etiqueta">Crédito activo{cuenta?.consolidated_billing ? ' · CCF consolidado' : ''}</span>}
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
                {/* A donde van los DTE y los estados de cuenta (0059). */}
                <div className="ficha-campo">
                  <span>Correo de facturación</span>
                  <div style={{ fontSize: 13.5, fontWeight: 600, padding: '4px 0' }}>
                    {customer.billing_email || customer.email || '—'}
                    <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-secondary)', marginLeft: 6 }}>
                      {(customer as any).billing_email_same === false ? '· distinto del general' : '· el mismo que el general'}
                    </span>
                  </div>
                </div>
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
                    {/* Facturación consolidada (0060): un CCF por período en vez de uno por venta. */}
                    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 12,
                                    border: `1.5px solid ${cuenta.consolidated_billing ? 'var(--corsa-green)' : 'var(--border)'}`,
                                    cursor: adminCredito ? 'pointer' : 'default' }}>
                      <input id="credito-consolidado" type="checkbox" checked={cuenta.consolidated_billing} disabled={!adminCredito}
                             onChange={e => cambiarConsolidada(e.target.checked)}
                             style={{ accentColor: 'var(--corsa-green)', width: 16, height: 16, marginTop: 2 }}/>
                      <span>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>Facturación consolidada</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                          Las ventas al crédito no emiten DTE en caja: se juntan en un solo CCF, con el detalle de cada placa, desde Cuentas por cobrar.
                        </span>
                      </span>
                    </label>
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

            {tarifario !== undefined && (
              <Seccion titulo="Tarifario especial"
                accion={tarifario?.habilitado && !editandoTarifa
                  ? <span className="badge badge-green">Activo</span>
                  : undefined}>
                {editandoTarifa ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      Marcá los servicios con precio especial. Lo que no marques se cobra a tarifa de lista.
                    </div>
                    <EditorPrecios lineas={lineas} setLineas={setLineas} aspirado={aspirado} setAspirado={setAspirado}/>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }}
                              onClick={() => setEditandoTarifa(false)} disabled={guardandoTarifa}>Cancelar</button>
                      <button id="tarifa-guardar" className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}
                              onClick={guardarTarifa} disabled={guardandoTarifa}>
                        {guardandoTarifa ? 'Guardando…' : 'Guardar tarifario'}
                      </button>
                    </div>
                  </div>
                ) : tarifario?.habilitado ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {SERVICIOS_FLOTILLA.filter(s => tarifario.acuerdo.servicios[s.codigo]).map(({ codigo, nombre }) => {
                        const p = tarifario.acuerdo.servicios[codigo]!
                        return (
                          <Dato key={codigo} label={nombre} valor={tarifario.acuerdo.porTamano[codigo]
                            ? `S ${money(p.S)} · M ${money(p.M)} · L ${money(p.L)}`
                            : money(p.M)}/>
                        )
                      })}
                      {tarifario.acuerdo.aspirado.activo && tarifario.acuerdo.aspirado.precio != null && (
                        <Dato label="Aspirado" valor={money(tarifario.acuerdo.aspirado.precio)}/>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      En caja, al elegir a este cliente, se cobran estos precios. Lo demás, a tarifa de lista.
                    </div>
                    {adminPrecios && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={abrirEditorTarifa}>Editar precios</button>
                        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center', color: 'var(--color-danger-text)' }}
                                onClick={() => cambiarHabilitadoTarifa(false)}>Desactivar</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      {tarifario
                        ? 'Tarifario especial desactivado: paga tarifa de lista. Los precios cargados quedan guardados.'
                        : 'Paga tarifa de lista. Con un tarifario especial, la caja le cobra los precios que fijes acá.'}
                    </div>
                    {adminPrecios && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        {tarifario && (
                          <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => cambiarHabilitadoTarifa(true)}>Reactivar</button>
                        )}
                        <button id="btn-habilitar-tarifario" className={tarifario ? 'btn btn-ghost' : 'btn btn-primary'}
                                style={{ flex: 1, justifyContent: 'center' }} onClick={abrirEditorTarifa}>
                          {tarifario ? 'Editar y reactivar' : 'Habilitar tarifario especial'}
                        </button>
                      </div>
                    )}
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
