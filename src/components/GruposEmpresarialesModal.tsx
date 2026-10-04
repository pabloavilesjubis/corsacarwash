/**
 * CORSA Carwash — Grupos empresariales (0054), desde Clientes.
 *
 * Ver cada grupo con sus clientes y sus placas, sumar o quitar clientes,
 * renombrarlo y negociar sus precios. Unir un cliente también se puede desde
 * su ficha; acá se ve el grupo entero, que es lo que el cajero va a ver en caja.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { EditorPrecios } from './EditorPrecios'
import { lineasDesde, SERVICIOS_FLOTILLA, type AcuerdoFlotilla, type LineasEditables } from '../lib/flotillas/precios'
import {
  asignarGrupo, asignarVehiculo, cargarAcuerdoGrupo, cargarMiembros, cargarVehiculosSinCliente, crearGrupo, guardarAcuerdoGrupo, listarGrupos,
  nombreMiembro, problemaDeLineasGrupo, renombrarGrupo, type GrupoEmpresarial, type MiembroGrupo, type VehiculoSinCliente,
} from '../lib/grupos/grupos'

function fmt(n: number) { return 'US$' + n.toFixed(2) }

/** Resumen de una línea negociada: «$12» o «S $10 · M $12 · L $14». */
function resumenPrecio(a: AcuerdoFlotilla, codigo: keyof AcuerdoFlotilla['servicios']): string | null {
  const p = a.servicios[codigo]
  if (!p) return null
  return a.porTamano[codigo] ? `S ${fmt(p.S)} · M ${fmt(p.M)} · L ${fmt(p.L)}` : fmt(p.M)
}

export function GruposEmpresarialesModal({ orgId, onCerrar, onCambio }: {
  orgId: string
  onCerrar: () => void
  /** Algo cambió la membresía: la lista de clientes de atrás se recarga. */
  onCambio: () => void
}) {
  const { hasPermission } = useAuth()
  const puedeEditar = hasPermission('customers.update')
  const puedePrecios = hasPermission('corporate.manage')

  const [grupos, setGrupos] = useState<GrupoEmpresarial[]>([])
  const [elegido, setElegido] = useState<string | null>(null)
  const [miembros, setMiembros] = useState<MiembroGrupo[]>([])
  const [sinCliente, setSinCliente] = useState<VehiculoSinCliente[]>([])
  const [asignando, setAsignando] = useState<string | null>(null)
  const [verClientes, setVerClientes] = useState(false)
  const [verVehiculos, setVerVehiculos] = useState(false)
  const [acuerdo, setAcuerdo] = useState<AcuerdoFlotilla | null>(null)
  const [cargando, setCargando] = useState(false)
  const [nuevo, setNuevo] = useState('')
  const [renombrando, setRenombrando] = useState<string | null>(null)
  const [editandoPrecios, setEditandoPrecios] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar])

  const cargarGrupos = useCallback(async () => {
    try {
      const gs = await listarGrupos()
      setGrupos(gs)
      setElegido(e => e ?? gs[0]?.id ?? null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudieron cargar los grupos')
    }
  }, [])
  useEffect(() => { cargarGrupos() }, [cargarGrupos])

  const cargarDetalle = useCallback(async (id: string) => {
    setCargando(true)
    try {
      const [ms, ac, sc] = await Promise.all([cargarMiembros(id), cargarAcuerdoGrupo(id), cargarVehiculosSinCliente(id)])
      setMiembros(ms); setAcuerdo(ac); setSinCliente(sc)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar el grupo')
    }
    setCargando(false)
  }, [])
  useEffect(() => {
    if (elegido) cargarDetalle(elegido)
    else { setMiembros([]); setAcuerdo(null); setSinCliente([]) }
  }, [elegido, cargarDetalle])

  const grupo = grupos.find(g => g.id === elegido) ?? null
  const totalVehiculos = sinCliente.length + miembros.reduce((t, m) => t + m.vehiculos.length, 0)

  const crear = async () => {
    if (!nuevo.trim()) return
    try {
      const g = await crearGrupo(orgId, nuevo)
      setNuevo('')
      await cargarGrupos()
      setElegido(g.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo crear el grupo')
    }
  }

  const guardarNombre = async () => {
    if (!grupo || renombrando == null || !renombrando.trim()) return
    try {
      await renombrarGrupo(grupo.id, renombrando)
      setRenombrando(null)
      await cargarGrupos()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo renombrar')
    }
  }

  /** Le da dueño a un carro que quedó del grupo sin cliente. */
  const asignar = async (v: VehiculoSinCliente, customerId: string) => {
    const m = miembros.find(x => x.id === customerId)
    if (!m || !window.confirm(`¿Asignar la placa ${v.plate} a ${nombreMiembro(m)}?`)) return
    setAsignando(v.id)
    try {
      await asignarVehiculo(v.id, customerId)
      toast.success(`${v.plate} asignada a ${nombreMiembro(m)}`)
      if (elegido) await cargarDetalle(elegido)
      onCambio()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo asignar el vehículo')
    }
    setAsignando(null)
  }

  const cambiarMiembro = async (customerId: string, groupId: string | null, aviso: string) => {
    try {
      await asignarGrupo(customerId, groupId)
      toast.success(aviso)
      if (elegido) await cargarDetalle(elegido)
      await cargarGrupos()
      onCambio()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo actualizar el cliente')
    }
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onCerrar() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 920, maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>Grupos empresariales</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
              Clientes hermanos: en caja comparten placas, se facturan entre sí y usan los precios del grupo.
            </div>
          </div>
          <button onClick={onCerrar} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', flex: 1, overflow: 'hidden' }}>
          {/* Lista de grupos */}
          <div style={{ flex: '0 0 240px', maxWidth: '100%', borderRight: '1px solid var(--border)', padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {grupos.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Todavía no hay grupos.</div>
            )}
            {grupos.map(g => (
              <button key={g.id} onClick={() => { setElegido(g.id); setRenombrando(null) }}
                style={{
                  textAlign: 'left', padding: '9px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'var(--font-body)',
                  border: `1.5px solid ${elegido === g.id ? 'var(--corsa-green)' : 'var(--border)'}`,
                  background: elegido === g.id ? 'rgba(22,25,26,0.05)' : 'var(--surface)',
                }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>{g.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{g.miembros} cliente{g.miembros === 1 ? '' : 's'}</div>
              </button>
            ))}
            {puedeEditar && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input id="grupo-crear-nombre" className="corsa-input" value={nuevo} onChange={e => setNuevo(e.target.value)}
                       placeholder="Nuevo grupo…" onKeyDown={e => { if (e.key === 'Enter') crear() }}/>
                <button className="btn btn-primary" onClick={crear} disabled={!nuevo.trim()}>Crear</button>
              </div>
            )}
          </div>

          {/* Detalle */}
          <div style={{ flex: '1 1 380px', padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {!grupo ? (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Creá un grupo para empezar.</div>
            ) : (<>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {renombrando != null ? (<>
                  <input className="corsa-input" autoFocus value={renombrando} onChange={e => setRenombrando(e.target.value)}
                         onKeyDown={e => { if (e.key === 'Enter') guardarNombre() }}/>
                  <button className="btn btn-primary" onClick={guardarNombre}>Guardar</button>
                  <button className="btn btn-ghost" onClick={() => setRenombrando(null)}>Cancelar</button>
                </>) : (<>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, flex: 1 }}>{grupo.name}</div>
                  {puedeEditar && <button className="btn btn-ghost" onClick={() => setRenombrando(grupo.name)}>Renombrar</button>}
                </>)}
              </div>

              {/* Precios */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div className="panel-section-label">Precios negociados</div>
                  {puedePrecios && acuerdo && (
                    <button className="btn btn-ghost" onClick={() => setEditandoPrecios(true)}>Editar precios</button>
                  )}
                </div>
                {acuerdo && (
                  <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {SERVICIOS_FLOTILLA.map(s => (
                      <div key={s.codigo} style={{ display: 'flex', gap: 8 }}>
                        <span style={{ width: 90, fontWeight: 700 }}>{s.nombre}</span>
                        <span style={{ color: resumenPrecio(acuerdo, s.codigo) ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                          {resumenPrecio(acuerdo, s.codigo) ?? 'tarifa de lista'}
                        </span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 90, fontWeight: 700 }}>Aspirado</span>
                      <span style={{ color: acuerdo.aspirado.activo ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                        {acuerdo.aspirado.activo && acuerdo.aspirado.precio != null ? fmt(acuerdo.aspirado.precio) : 'tarifa de lista'}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Clientes del grupo: desplegable */}
              <div>
                <button type="button" className="grupo-desplegable" onClick={() => setVerClientes(v => !v)} aria-expanded={verClientes}>
                  <span className="flecha">{verClientes ? '▾' : '▸'}</span>
                  Clientes del grupo ({miembros.length})
                </button>
                {verClientes && (<>
                  {cargando && <div className="spinner" style={{ width: 16, height: 16 }}/>}
                  {!cargando && miembros.length === 0 && (
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin clientes todavía. Agregalos abajo o desde la ficha de cada cliente.</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {miembros.map(m => (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }} className="truncate">{nombreMiembro(m)}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                            {m.nit ? `NIT ${m.nit}` : m.dui ? `DUI ${m.dui}` : 'Sin documento'} · {m.vehiculos.length} {m.vehiculos.length === 1 ? 'vehículo' : 'vehículos'}
                          </div>
                        </div>
                        {puedeEditar && (
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--color-danger-text)' }}
                                  onClick={() => cambiarMiembro(m.id, null, `${nombreMiembro(m)} salió del grupo`)}>
                            Quitar
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {puedeEditar && (
                    <AgregarMiembro excluir={miembros.map(m => m.id)}
                      onElegir={(c, grupoActual) => {
                        if (grupoActual && grupoActual !== grupo.id &&
                            !window.confirm(`${c} ya está en otro grupo. Un cliente sólo puede estar en uno: ¿moverlo a ${grupo.name}?`)) return
                        return true
                      }}
                      onAgregar={(id, nombre) => cambiarMiembro(id, grupo.id, `${nombre} se unió a ${grupo.name}`)}/>
                  )}
                </>)}
              </div>

              {/* Vehículos del grupo: desplegable con el detalle y el dueño */}
              <div>
                <button type="button" className="grupo-desplegable" onClick={() => setVerVehiculos(v => !v)} aria-expanded={verVehiculos}>
                  <span className="flecha">{verVehiculos ? '▾' : '▸'}</span>
                  Vehículos ({totalVehiculos})
                  {sinCliente.length > 0 && <span className="badge badge-warning" style={{ marginLeft: 8 }}>{sinCliente.length} sin cliente</span>}
                </button>
                {verVehiculos && (
                  totalVehiculos === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>El grupo no tiene vehículos registrados.</div>
                  ) : (
                    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: 360 }}>
                      <table className="corsa-table ventas-tabla" style={{ border: 'none' }}>
                        <thead><tr><th>Placa</th><th>Vehículo</th><th>Color</th><th>Cliente</th></tr></thead>
                        <tbody>
                          {sinCliente.map(v => (
                            <tr key={v.id}>
                              <td className="font-mono" style={{ fontWeight: 700 }}>{v.plate}</td>
                              <td>{[v.brand, v.model].filter(Boolean).join(' ') || '—'}</td>
                              <td>{v.color || '—'}</td>
                              <td>
                                {puedeEditar ? (
                                  <select className="corsa-input" style={{ width: 210, padding: '3px 8px', fontSize: 12, color: 'var(--color-warning-text)' }} value=""
                                          disabled={asignando === v.id || miembros.length === 0}
                                          onChange={e => { if (e.target.value) asignar(v, e.target.value) }}>
                                    <option value="">{miembros.length ? 'Sin cliente · asignar a…' : 'Agregá clientes al grupo'}</option>
                                    {miembros.map(m => <option key={m.id} value={m.id}>{nombreMiembro(m)}</option>)}
                                  </select>
                                ) : <span style={{ color: 'var(--color-warning-text)' }}>Sin cliente</span>}
                              </td>
                            </tr>
                          ))}
                          {miembros.flatMap(m => m.vehiculos.map(v => (
                            <tr key={v.id}>
                              <td className="font-mono" style={{ fontWeight: 700 }}>{v.plate}</td>
                              <td>{[v.brand, v.model].filter(Boolean).join(' ') || '—'}</td>
                              <td>{v.color || '—'}</td>
                              <td className="cliente" title={nombreMiembro(m)}>{nombreMiembro(m)}</td>
                            </tr>
                          )))}
                        </tbody>
                      </table>
                    </div>
                  )
                )}
              </div>
            </>)}
          </div>
        </div>
      </div>

      {editandoPrecios && grupo && acuerdo && (
        <PreciosGrupoModal grupoId={grupo.id} titulo={grupo.name} acuerdo={acuerdo}
          onCancel={() => setEditandoPrecios(false)}
          onGuardado={() => { setEditandoPrecios(false); cargarDetalle(grupo.id) }}/>
      )}
    </div>,
    document.body
  )
}

/** Buscar un cliente por nombre, NIT, DUI o placa para sumarlo al grupo. */
function AgregarMiembro({ excluir, onElegir, onAgregar }: {
  excluir: string[]
  /** Confirma el movimiento si el cliente ya estaba en otro grupo. */
  onElegir: (nombre: string, grupoActual: string | null) => boolean | undefined
  onAgregar: (id: string, nombre: string) => void
}) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<any[]>([])

  useEffect(() => {
    const t = q.replace(/[,()]/g, ' ').trim()
    if (t.length < 2) { setRes([]); return }
    let vivo = true
    const timer = setTimeout(async () => {
      const cols = 'id, customer_type, first_name, last_name, trade_name, legal_name, nit, dui, business_group_id'
      const esPlaca = /^[a-zA-Z]\s?\d/.test(t)
      let filas: any[] = []
      if (esPlaca) {
        const { data } = await (supabase as any).from('vehicles').select(`plate, customers(${cols})`)
          .ilike('plate', `%${t.replace(/\s/g, '')}%`).limit(6)
        filas = (data ?? []).map((v: any) => v.customers).filter(Boolean)
      } else {
        const { data } = await (supabase as any).from('customers').select(cols)
          .or(`first_name.ilike.%${t}%,last_name.ilike.%${t}%,trade_name.ilike.%${t}%,legal_name.ilike.%${t}%,nit.ilike.%${t}%,dui.ilike.%${t}%`)
          .limit(8)
        filas = data ?? []
      }
      if (vivo) setRes(filas.filter((c, i, a) => !excluir.includes(c.id) && a.findIndex(x => x.id === c.id) === i))
    }, 300)
    return () => { vivo = false; clearTimeout(timer) }
  }, [q, excluir])

  return (
    <div style={{ marginTop: 10, position: 'relative' }}>
      <input id="grupo-agregar-cliente" className="corsa-input" value={q} onChange={e => setQ(e.target.value)}
             placeholder="+ Agregar cliente: nombre, NIT, DUI o placa…"/>
      {res.length > 0 && (
        <div style={{ marginTop: 4, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          {res.map((c, i) => (
            <button key={c.id} onClick={() => {
                const nombre = nombreMiembro(c)
                if (onElegir(nombre, c.business_group_id ?? null) !== true) return
                onAgregar(c.id, nombre); setQ(''); setRes([])
              }}
              style={{ width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', borderBottom: i < res.length - 1 ? '1px solid var(--border)' : 'none', background: 'var(--surface)', cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{nombreMiembro(c)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                {c.nit ? `NIT ${c.nit}` : c.dui ? `DUI ${c.dui}` : ''}{c.business_group_id ? ' · ya está en otro grupo' : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function PreciosGrupoModal({ grupoId, titulo, acuerdo, onGuardado, onCancel }: {
  grupoId: string
  titulo: string
  acuerdo: AcuerdoFlotilla
  onGuardado: () => void
  onCancel: () => void
}) {
  const [lineas, setLineas] = useState<LineasEditables>(() => lineasDesde(acuerdo))
  const [aspirado, setAspirado] = useState({
    activo: acuerdo.aspirado.activo,
    precio: (acuerdo.aspirado.precio ?? 2.5).toFixed(2),
  })
  const [saving, setSaving] = useState(false)

  const guardar = async () => {
    const problema = problemaDeLineasGrupo(lineas, aspirado)
    if (problema) { toast.error(problema); return }
    setSaving(true)
    try {
      await guardarAcuerdoGrupo(grupoId, lineas, aspirado)
      toast.success('Precios del grupo actualizados ✓')
      onGuardado()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudieron guardar los precios')
      setSaving(false)
    }
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 210, padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>Precios negociados</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            {titulo} · lo que no se marque se cobra a tarifa de lista
          </div>
        </div>
        <div style={{ padding: '18px 22px' }}>
          <EditorPrecios lineas={lineas} setLineas={setLineas} aspirado={aspirado} setAspirado={setAspirado}/>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="btn btn-ghost">Cancelar</button>
          <button className="btn btn-primary" onClick={guardar} disabled={saving}>{saving ? 'Guardando…' : 'Guardar precios'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
