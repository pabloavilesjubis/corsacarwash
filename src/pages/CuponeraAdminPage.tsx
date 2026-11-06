/**
 * CORSA Carwash — Cuponera digital (administración, 0083)
 *
 * Los clientes que entregan sus propios cupones desde el portal /cuponera.
 * Acá CORSA:
 *   · habilita o suspende la cuponera de un cliente;
 *   · crea sus usuarios, les restablece la contraseña o les corta el acceso;
 *   · decide qué lotes vendidos ve el cliente (el POS Administrativo carga el
 *     lote solo al vender; los anteriores se cargan desde acá);
 *   · consulta las entregas y reenvía un correo si hace falta.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { Modal } from '../components/ui/Modal'
import { BuscadorCliente } from '../components/posAdmin/BuscadorCliente'
import type { ClienteAdmin } from '../lib/posAdmin/cliente'
import { formatearFecha, formatearFechaHora } from '../utils/fecha'
import {
  accesoCuponera, cargarLoteCuponera, clientesCuponera, crearUsuarioCuponera, entregasCuponera, habilitarCuponera,
  lotesCuponera, reenviarCorreoEntrega, restablecerClaveCuponera, urlPortal, usuariosCuponera,
  type ClienteCuponera, type EntregaCuponera, type LoteCuponera, type RespuestaUsuario, type UsuarioCuponera,
} from '../services/cuponera.service'

function money(n: number) { return 'US$' + (Number(n) || 0).toFixed(2) }
function fecha(iso: string | null) { return iso ? formatearFecha(iso, { day: '2-digit', month: 'short', year: '2-digit' }) : '—' }

export function CuponeraAdminPage() {
  const { hasPermission } = useAuth()
  const [clientes, setClientes] = useState<ClienteCuponera[]>([])
  const [cargando, setCargando] = useState(true)
  const [elegido, setElegido] = useState<string | null>(null)
  const [habilitar, setHabilitar] = useState(false)

  const cargar = useCallback(async () => {
    try {
      const r = await clientesCuponera()
      setClientes(r)
      setElegido(e => e ?? r[0]?.customer_id ?? null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar la cuponera')
    }
    setCargando(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  if (!hasPermission('cuponera.manage')) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso a la Cuponera digital</div>
          <div className="empty-state-sub">Se requiere el permiso <strong>cuponera.manage</strong>.</div>
        </div>
      </div>
    )
  }

  const copiarEnlace = () => {
    navigator.clipboard.writeText(urlPortal())
      .then(() => toast.success('Enlace del portal copiado'))
      .catch(() => toast.error('No se pudo copiar'))
  }

  const actual = clientes.find(c => c.customer_id === elegido) ?? null

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>Cuponera digital</h1>
          <div className="page-header-sub">Clientes que entregan sus propios cupones desde el portal</div>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-ghost" onClick={copiarEnlace} title={urlPortal()}>Copiar enlace del portal</button>
          <button className="btn btn-primary" onClick={() => setHabilitar(true)}>+ Habilitar cliente</button>
        </div>
      </div>

      {cargando ? (
        <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
      ) : clientes.length === 0 ? (
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', padding: 28 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20 }}>Ningún cliente tiene cuponera todavía</div>
          <ol style={{ margin: '12px 0 0 18px', fontSize: 13.5, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
            <li><strong style={{ color: 'var(--text-primary)' }}>Habilitá el cliente</strong> que compró cupones.</li>
            <li><strong style={{ color: 'var(--text-primary)' }}>Creá sus usuarios</strong>: reciben por correo el enlace y una contraseña temporal.</li>
            <li><strong style={{ color: 'var(--text-primary)' }}>Facturá los cupones</strong> en POS Administrativo → Cupones: el lote se carga solo a su cuponera.</li>
          </ol>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setHabilitar(true)}>+ Habilitar cliente</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '0 1 320px', minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {clientes.map(c => (
              <button key={c.customer_id} onClick={() => setElegido(c.customer_id)}
                style={{
                  textAlign: 'left', cursor: 'pointer', background: 'var(--surface)', borderRadius: 16, padding: '14px 16px',
                  border: `1.5px solid ${elegido === c.customer_id ? 'var(--corsa-green)' : 'transparent'}`, color: 'var(--text-primary)',
                  fontFamily: 'var(--font-body)',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }} className="truncate">{c.nombre}</span>
                  <span className={`badge ${c.activa ? 'badge-success' : 'badge-neutral'}`}>{c.activa ? 'Activa' : 'Suspendida'}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {c.totales.pendientes} pendientes · {c.totales.entregados} entregados · {c.totales.redimidos} redimidos
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {c.usuarios_activos} {c.usuarios_activos === 1 ? 'usuario activo' : 'usuarios activos'}
                </div>
              </button>
            ))}
          </div>
          <div style={{ flex: '1 1 560px', minWidth: 0 }}>
            {actual && <DetalleCliente key={actual.customer_id} cliente={actual} onCambio={cargar}/>}
          </div>
        </div>
      )}

      {habilitar && (
        <ModalHabilitar onCerrar={() => setHabilitar(false)}
          onListo={async id => { setHabilitar(false); setElegido(id); await cargar() }}/>
      )}
    </div>
  )
}

function ModalHabilitar({ onCerrar, onListo }: { onCerrar: () => void; onListo: (customerId: string) => void }) {
  const [cliente, setCliente] = useState<ClienteAdmin | null>(null)
  const [guardando, setGuardando] = useState(false)
  const guardar = async () => {
    if (!cliente) return
    setGuardando(true)
    try {
      await habilitarCuponera(cliente.id, true)
      toast.success('Cuponera habilitada')
      onListo(cliente.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo habilitar')
    }
    setGuardando(false)
  }
  return (
    <Modal open onClose={onCerrar} title="Habilitar cuponera digital" maxWidth={520}>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        El cliente podrá entrar al portal con los usuarios que le crees y entregar los cupones de los lotes cargados a su cuponera.
      </div>
      <BuscadorCliente cliente={cliente} onElegir={setCliente}/>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
        <button className="btn btn-primary" disabled={!cliente || guardando} onClick={guardar}>{guardando ? 'Habilitando…' : 'Habilitar'}</button>
      </div>
    </Modal>
  )
}

function DetalleCliente({ cliente, onCambio }: { cliente: ClienteCuponera; onCambio: () => void }) {
  const [pestana, setPestana] = useState<'usuarios' | 'lotes' | 'entregas'>('usuarios')
  const [usuarios, setUsuarios] = useState<UsuarioCuponera[]>([])
  const [lotes, setLotes] = useState<LoteCuponera[]>([])
  const [entregas, setEntregas] = useState<EntregaCuponera[]>([])
  const [cargando, setCargando] = useState(true)
  const [nuevo, setNuevo] = useState(false)
  const [restablecer, setRestablecer] = useState<UsuarioCuponera | null>(null)
  const [clave, setClave] = useState<{ titulo: string; r: RespuestaUsuario } | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const [u, l, e] = await Promise.all([
        usuariosCuponera(cliente.customer_id), lotesCuponera(cliente.customer_id), entregasCuponera(cliente.customer_id),
      ])
      setUsuarios(u); setLotes(l); setEntregas(e)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar el cliente')
    }
    setCargando(false)
  }, [cliente.customer_id])

  useEffect(() => { cargar() }, [cargar])

  const refrescar = async () => { await cargar(); onCambio() }

  const alternarCuponera = async () => {
    try {
      await habilitarCuponera(cliente.customer_id, !cliente.activa)
      toast.success(cliente.activa ? 'Cuponera suspendida: sus usuarios ya no pueden entrar' : 'Cuponera reactivada')
      onCambio()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo cambiar') }
  }

  const alternarUsuario = async (u: UsuarioCuponera) => {
    const r = await accesoCuponera(u.user_id, !u.activo)
    if (!r.ok) { toast.error(r.error ?? 'No se pudo cambiar el acceso'); return }
    toast.success(u.activo ? `${u.nombre} ya no puede entrar` : `${u.nombre} puede volver a entrar`)
    refrescar()
  }

  const alternarLote = async (l: LoteCuponera) => {
    try {
      await cargarLoteCuponera(l.batch_id, !l.cuponera)
      toast.success(l.cuponera ? 'Lote quitado de la cuponera' : `${l.quantity} cupones cargados a la cuponera`)
      refrescar()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo cambiar el lote') }
  }

  const reenviar = async (e: EntregaCuponera) => {
    const id = toast.loading(`Enviando a ${e.destinatario_correo}…`)
    const r = await reenviarCorreoEntrega(e.id)
    toast.dismiss(id)
    if (r.ok) toast.success('Correo enviado'); else toast.error(r.error ?? 'No se pudo enviar')
    cargar()
  }

  const t = cliente.totales
  const sinCargar = lotes.filter(l => !l.cuponera && !l.anulado).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 22 }}>{cliente.nombre}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              {[cliente.nit ? `NIT ${cliente.nit}` : null, cliente.correo, `Habilitada el ${fecha(cliente.created_at)}`].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button className={`btn ${cliente.activa ? 'btn-ghost' : 'btn-primary'}`} onClick={alternarCuponera}>
            {cliente.activa ? 'Suspender cuponera' : 'Reactivar cuponera'}
          </button>
        </div>
        <div className="kpi-grid" style={{ marginTop: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
          {[['Comprados', t.comprados], ['Entregados', t.entregados], ['Pendientes', t.pendientes], ['Redimidos', t.redimidos]].map(([l, v]) => (
            <div key={l} className="kpi-card" style={{ background: 'var(--page-bg)', padding: 14 }}>
              <div className="kpi-label" style={{ fontSize: 12.5 }}>{l}</div>
              <div className="kpi-value" style={{ fontSize: 24 }}>{v}</div>
            </div>
          ))}
        </div>
        {sinCargar > 0 && (
          <div style={{ marginTop: 12, fontSize: 12.5, background: 'var(--color-warning-tint)', color: 'var(--color-warning-text)', padding: '9px 12px', borderRadius: 12 }}>
            {sinCargar === 1 ? 'Hay 1 lote vendido a este cliente' : `Hay ${sinCargar} lotes vendidos a este cliente`} que no está en su cuponera. Cargalo desde la pestaña Lotes.
          </div>
        )}
      </div>

      <div className="filter-pills">
        {([['usuarios', `Usuarios (${usuarios.length})`], ['lotes', `Lotes (${lotes.length})`], ['entregas', `Entregas (${entregas.length})`]] as const).map(([id, label]) => (
          <button key={id} className={`filter-pill${pestana === id ? ' active' : ''}`} onClick={() => setPestana(id)}>{label}</button>
        ))}
      </div>

      <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {cargando ? (
          <div className="loading-center"><div className="spinner"/></div>
        ) : pestana === 'usuarios' ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Personas del cliente con acceso al portal. Sólo ven los cupones de este cliente.</div>
              <button className="btn btn-primary" onClick={() => setNuevo(true)}>+ Nuevo usuario</button>
            </div>
            {usuarios.length === 0 ? (
              <div className="empty-state" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="empty-state-title">Sin usuarios</div>
                <div className="empty-state-sub">Creá el primero para que el cliente pueda entrar.</div>
              </div>
            ) : (
              <div className="table-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                <table className="corsa-table">
                  <thead><tr><th>Usuario</th><th>Estado</th><th>Último ingreso</th><th style={{ textAlign: 'right' }}>Acciones</th></tr></thead>
                  <tbody>
                    {usuarios.map(u => (
                      <tr key={u.user_id} style={{ cursor: 'default' }}>
                        <td><div style={{ fontWeight: 600, fontSize: 13.5 }}>{u.nombre}</div><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{u.correo}</div></td>
                        <td>
                          <span className={`badge ${u.activo ? 'badge-success' : 'badge-neutral'}`}>{u.activo ? 'Activo' : 'Sin acceso'}</span>
                          {u.activo && u.debe_cambiar_clave && <span className="badge badge-warning" style={{ marginLeft: 6 }}>Clave temporal</span>}
                        </td>
                        <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{u.ultimo_ingreso ? formatearFechaHora(u.ultimo_ingreso) : 'Nunca'}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12, marginRight: 4 }} onClick={() => setRestablecer(u)}>Restablecer contraseña</button>
                          <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => alternarUsuario(u)}>{u.activo ? 'Quitar acceso' : 'Dar acceso'}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : pestana === 'lotes' ? (
          lotes.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">Este cliente no tiene cupones vendidos</div>
              <div className="empty-state-sub">Se facturan en POS Administrativo → Cupones.</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="corsa-table">
                <thead><tr><th>Venta</th><th>Servicio</th><th style={{ textAlign: 'right' }}>Cupones</th><th>Uso</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Cuponera</th></tr></thead>
                <tbody>
                  {lotes.map(l => (
                    <tr key={l.batch_id} style={{ cursor: 'default', opacity: l.anulado ? 0.55 : 1 }}>
                      <td><div style={{ fontWeight: 600, fontSize: 13 }}>{l.order_number ?? '—'}</div><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fecha(l.created_at)}</div>{l.facturado_a && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Facturado a {l.facturado_a}</div>}</td>
                      <td style={{ fontSize: 13 }}>{l.service_name} {l.size}{l.includes_aspirado && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>+ aspirado</span>}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{l.quantity}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{l.entregados} entregados · {l.redimidos} redimidos</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(l.total)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {l.anulado ? <span className="badge badge-danger">Venta anulada</span> : (
                          <button className={`btn ${l.cuponera ? 'btn-ghost' : 'btn-primary'}`} style={{ padding: '5px 12px', fontSize: 12 }}
                                  disabled={!cliente.activa && !l.cuponera} onClick={() => alternarLote(l)}
                                  title={l.cuponera ? 'Sólo se puede quitar si no tiene cupones entregados' : 'El cliente lo verá y podrá entregar sus cupones'}>
                            {l.cuponera ? 'En cuponera · quitar' : 'Cargar a cuponera'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : entregas.length === 0 ? (
          <div className="empty-state"><div className="empty-state-title">El cliente todavía no entregó cupones</div></div>
        ) : (
          <div className="table-wrap">
            <table className="corsa-table">
              <thead><tr><th>Fecha</th><th>Para</th><th>Cupones</th><th>Entregó</th><th>Correo</th><th/></tr></thead>
              <tbody>
                {entregas.map(e => (
                  <tr key={e.id} style={{ cursor: 'default' }}>
                    <td style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{formatearFechaHora(e.created_at)}</td>
                    <td><div style={{ fontWeight: 600, fontSize: 13 }}>{e.destinatario_nombre}</div><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{e.destinatario_correo ?? 'Sólo PDF'}</div></td>
                    <td style={{ fontSize: 12.5 }}>
                      <div style={{ fontWeight: 600 }}>{e.cantidad} · {e.servicios}</div>
                      <div className="font-mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{e.codigos.slice(0, 5).join(' · ')}{e.codigos.length > 5 ? ` +${e.codigos.length - 5}` : ''}</div>
                    </td>
                    <td style={{ fontSize: 12.5 }}>{e.entregado_por}</td>
                    <td>
                      {!e.destinatario_correo ? <span className="badge badge-neutral">—</span>
                        : e.correo_estado === 'sent' ? <span className="badge badge-success">Enviado</span>
                        : e.correo_estado === 'failed' ? <span className="badge badge-danger" title={e.correo_error ?? ''}>Falló</span>
                        : <span className="badge badge-warning">Sin enviar</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {e.destinatario_correo && (
                        <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => reenviar(e)}>Reenviar</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {nuevo && (
        <ModalNuevoUsuario cliente={cliente} onCerrar={() => setNuevo(false)}
          onCreado={r => { setNuevo(false); setClave({ titulo: 'Usuario creado', r }); refrescar() }}/>
      )}
      {restablecer && (
        <ModalRestablecer usuario={restablecer} onCerrar={() => setRestablecer(null)}
          onListo={r => { setRestablecer(null); setClave({ titulo: 'Contraseña restablecida', r }); refrescar() }}/>
      )}
      {clave && <ModalClave titulo={clave.titulo} r={clave.r} onCerrar={() => setClave(null)}/>}
    </div>
  )
}

function ModalNuevoUsuario({ cliente, onCerrar, onCreado }: {
  cliente: ClienteCuponera; onCerrar: () => void; onCreado: (r: RespuestaUsuario) => void
}) {
  const [nombre, setNombre] = useState('')
  const [correo, setCorreo] = useState('')
  const [enviar, setEnviar] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const ok = nombre.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo.trim())

  const crear = async () => {
    setGuardando(true)
    const r = await crearUsuarioCuponera(cliente.customer_id, nombre.trim(), correo.trim(), enviar)
    setGuardando(false)
    if (!r.ok) { toast.error(r.error ?? 'No se pudo crear el usuario'); return }
    onCreado(r)
  }

  return (
    <Modal open onClose={onCerrar} title={`Nuevo usuario · ${cliente.nombre}`} maxWidth={480}>
      <div className="field"><label>Nombre</label>
        <input className="corsa-input" value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Nombre y apellido" autoFocus/></div>
      <div className="field"><label>Correo (será su usuario)</label>
        <input className="corsa-input" type="email" value={correo} onChange={e => setCorreo(e.target.value)} placeholder="persona@empresa.com"/></div>
      <label style={{ display: 'flex', gap: 9, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" checked={enviar} onChange={e => setEnviar(e.target.checked)} style={{ accentColor: 'var(--corsa-green)' }}/>
        Enviarle por correo el enlace al portal y la contraseña temporal
      </label>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        La contraseña la genera el sistema y se cambia obligatoriamente al primer ingreso. El usuario sólo ve los cupones de {cliente.nombre}.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
        <button className="btn btn-primary" disabled={!ok || guardando} onClick={crear}>{guardando ? 'Creando…' : 'Crear usuario'}</button>
      </div>
    </Modal>
  )
}

function ModalRestablecer({ usuario, onCerrar, onListo }: {
  usuario: UsuarioCuponera; onCerrar: () => void; onListo: (r: RespuestaUsuario) => void
}) {
  const [enviar, setEnviar] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const confirmar = async () => {
    setGuardando(true)
    const r = await restablecerClaveCuponera(usuario.user_id, enviar)
    setGuardando(false)
    if (!r.ok) { toast.error(r.error ?? 'No se pudo restablecer'); return }
    onListo(r)
  }
  return (
    <Modal open onClose={onCerrar} title="Restablecer contraseña" maxWidth={440}>
      <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
        Se genera una contraseña temporal nueva para <strong>{usuario.nombre}</strong> ({usuario.correo}). La actual deja de funcionar.
      </div>
      <label style={{ display: 'flex', gap: 9, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" checked={enviar} onChange={e => setEnviar(e.target.checked)} style={{ accentColor: 'var(--corsa-green)' }}/>
        Enviársela por correo
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
        <button className="btn btn-primary" disabled={guardando} onClick={confirmar}>{guardando ? 'Restableciendo…' : 'Restablecer'}</button>
      </div>
    </Modal>
  )
}

function ModalClave({ titulo, r, onCerrar }: { titulo: string; r: RespuestaUsuario; onCerrar: () => void }) {
  const copiar = () => {
    navigator.clipboard.writeText(`Portal: ${urlPortal()}\nUsuario: ${r.correo}\nContraseña temporal: ${r.clave}`)
      .then(() => toast.success('Datos de acceso copiados')).catch(() => toast.error('No se pudo copiar'))
  }
  return (
    <Modal open onClose={onCerrar} title={titulo} maxWidth={460}>
      <div style={{ background: 'var(--subtle-bg)', borderRadius: 14, padding: 16, display: 'grid', gap: 8, fontSize: 13 }}>
        <div><span style={{ color: 'var(--text-secondary)' }}>Portal</span><div style={{ fontWeight: 600 }}>{urlPortal()}</div></div>
        <div><span style={{ color: 'var(--text-secondary)' }}>Usuario</span><div style={{ fontWeight: 600 }}>{r.correo}</div></div>
        <div><span style={{ color: 'var(--text-secondary)' }}>Contraseña temporal</span>
          <div className="font-mono" style={{ fontWeight: 800, fontSize: 20, letterSpacing: '0.06em' }}>{r.clave}</div></div>
      </div>
      {r.correoEnviado ? (
        r.correoEnviado.enviado
          ? <div className="badge badge-success" style={{ padding: '9px 12px', borderRadius: 12, whiteSpace: 'normal' }}>Se le envió por correo a {r.correo}.</div>
          : <div className="badge badge-danger" style={{ padding: '9px 12px', borderRadius: 12, whiteSpace: 'normal' }}>El correo no salió: {r.correoEnviado.error}. Compartile los datos por otro medio.</div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>No se envió correo: compartile estos datos. La contraseña no se vuelve a mostrar.</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-ghost" onClick={copiar}>Copiar datos</button>
        <button className="btn btn-primary" onClick={onCerrar}>Listo</button>
      </div>
    </Modal>
  )
}
