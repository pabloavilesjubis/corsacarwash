/**
 * CORSA — Cuponera Digital: el portal del cliente (/cuponera, 0083).
 *
 * Quien compró cupones entra con su propio usuario y:
 *   · ve cuántos compró, cuántos entregó, cuántos le quedan y cuántos ya se
 *     canjearon;
 *   · entrega cupones a una persona: por correo (sale del buzón de CORSA), en
 *     PDF, o las dos cosas;
 *   · consulta los cupones y las entregas, y reimprime o reenvía.
 *
 * No toca nada de CORSA: todo pasa por `api` (PortalApi), que en producción
 * son las RPC cuponera_portal_* y en /dev/cuponera una demostración en
 * memoria. El cupón impreso es exactamente el de siempre (voucherDocument).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { CorsaLogoCompleto } from '../components/ui/CorsaLogoCompleto'
import { Modal } from '../components/ui/Modal'
import { escribirCupones, printVouchers } from '../lib/vouchers/voucherDocument'
import { formatearFecha, formatearFechaHora } from '../utils/fecha'
import {
  nombreTipo,
  type CuponPortal, type EntregaCuponera, type EstadoCupon, type PortalApi, type ResumenPortal, type TipoCupon,
} from '../services/cuponera.service'
import './cuponera.css'

type Fase = 'cargando' | 'login' | 'clave' | 'app'

export function CuponeraPortal({ api }: { api: PortalApi }) {
  const [fase, setFase] = useState<Fase>('cargando')
  const [resumen, setResumen] = useState<ResumenPortal | null>(null)

  const entrar = useCallback(async () => {
    try {
      const r = await api.resumen()
      setResumen(r)
      setFase(r.usuario.debe_cambiar_clave ? 'clave' : 'app')
    } catch {
      await api.salir()
      setFase('login')
    }
  }, [api])

  useEffect(() => {
    document.title = 'Cuponera Digital · CORSA Carwash'
    api.haySesion().then(s => (s ? entrar() : setFase('login')))
  }, [api, entrar])

  const salir = async () => {
    await api.salir()
    setResumen(null)
    setFase('login')
  }

  if (fase === 'cargando') {
    return <div className="login-page"><div className="spinner" style={{ borderTopColor: 'var(--lima)' }}/></div>
  }
  if (fase === 'login') return <Ingreso api={api} onListo={entrar}/>
  if (fase === 'clave') return <CrearClave api={api} nombre={resumen?.usuario.nombre ?? ''} onListo={entrar} onSalir={salir}/>
  return <Tablero api={api} resumen={resumen!} onRecargar={entrar} onSalir={salir}/>
}

// ─── Ingreso ──────────────────────────────────────────────────

function Ingreso({ api, onListo }: { api: PortalApi; onListo: () => void }) {
  const [correo, setCorreo] = useState('')
  const [clave, setClave] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setEnviando(true)
    const err = await api.ingresar(correo, clave)
    setEnviando(false)
    if (err) { setError(err); return }
    onListo()
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo"><CorsaLogoCompleto width={180}/></div>
        <div style={{ display: 'flex' }}>
          <span className="cpn-login-badge"><span className="cpn-dot"/>Cuponera Digital</span>
        </div>
        <p className="cpn-login-intro">Entrega los cupones de lavado de tu empresa por correo o en PDF, y lleva el control de cada uno.</p>

        {error && <div className="login-error" role="alert">{error}</div>}

        <form onSubmit={enviar} noValidate>
          <label htmlFor="cpn-correo" className="login-label">Correo electrónico</label>
          <input id="cpn-correo" type="email" autoComplete="username" className="login-input"
                 value={correo} onChange={e => setCorreo(e.target.value)} placeholder="tu@empresa.com" disabled={enviando}/>
          <label htmlFor="cpn-clave" className="login-label">Contraseña</label>
          <input id="cpn-clave" type="password" autoComplete="current-password" className="login-input"
                 value={clave} onChange={e => setClave(e.target.value)} placeholder="••••••••" disabled={enviando}/>
          <button type="submit" className="login-btn" disabled={enviando || !correo || !clave}>
            {enviando ? <><div className="spinner" style={{ width: 16, height: 16, borderTopColor: '#fff' }}/>Ingresando…</> : 'Ingresar'}
          </button>
        </form>

        <p className="login-footer">¿Olvidaste tu contraseña? Pídele a CORSA Carwash que la restablezca.</p>
      </div>
    </div>
  )
}

function CrearClave({ api, nombre, onListo, onSalir }: { api: PortalApi; nombre: string; onListo: () => void; onSalir: () => void }) {
  const [clave, setClave] = useState('')
  const [repite, setRepite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [guardando, setGuardando] = useState(false)
  const valida = clave.length >= 8 && clave === repite

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (clave.length < 8) { setError('Usa al menos 8 caracteres'); return }
    if (clave !== repite) { setError('Las contraseñas no coinciden'); return }
    setGuardando(true)
    const err = await api.cambiarClave(clave)
    setGuardando(false)
    if (err) { setError(err); return }
    toast.success('Contraseña guardada')
    onListo()
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo"><CorsaLogoCompleto width={160}/></div>
        <div style={{ display: 'flex' }}>
          <span className="cpn-login-badge"><span className="cpn-dot"/>Cuponera Digital</span>
        </div>
        <p className="cpn-login-intro">
          Hola{nombre ? `, ${nombre.split(' ')[0]}` : ''}. Antes de empezar, crea tu propia contraseña: la que recibiste es temporal.
        </p>
        {error && <div className="login-error" role="alert">{error}</div>}
        <form onSubmit={guardar} noValidate>
          <label htmlFor="cpn-n1" className="login-label">Contraseña nueva</label>
          <input id="cpn-n1" type="password" autoComplete="new-password" className="login-input"
                 value={clave} onChange={e => setClave(e.target.value)} placeholder="Mínimo 8 caracteres"/>
          <label htmlFor="cpn-n2" className="login-label">Repítela</label>
          <input id="cpn-n2" type="password" autoComplete="new-password" className="login-input"
                 value={repite} onChange={e => setRepite(e.target.value)} placeholder="••••••••"/>
          <button type="submit" className="login-btn" disabled={guardando || !valida}>
            {guardando ? 'Guardando…' : 'Guardar y entrar'}
          </button>
        </form>
        <p className="login-footer">
          <button onClick={onSalir} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline', font: 'inherit' }}>
            Salir
          </button>
        </p>
      </div>
    </div>
  )
}

// ─── Tablero ──────────────────────────────────────────────────

const ESTADOS: { id: EstadoCupon | null; label: string }[] = [
  { id: 'pendiente', label: 'Pendientes' },
  { id: 'entregado', label: 'Entregados' },
  { id: 'redimido', label: 'Redimidos' },
  { id: null, label: 'Todos' },
]

const POR_PAGINA = 25

function fecha(iso: string | null): string {
  return iso ? formatearFecha(iso, { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
}

function iniciales(nombre: string): string {
  return nombre.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join('') || '·'
}

function pct(a: number, b: number): number {
  return b > 0 ? Math.round((a / b) * 100) : 0
}

function Tablero({ api, resumen, onRecargar, onSalir }: {
  api: PortalApi; resumen: ResumenPortal; onRecargar: () => Promise<void> | void; onSalir: () => void
}) {
  const [vista, setVista] = useState<'cupones' | 'entregas'>('cupones')
  const [estado, setEstado] = useState<EstadoCupon | null>('pendiente')
  const [buscar, setBuscar] = useState('')
  const [cupones, setCupones] = useState<CuponPortal[]>([])
  const [entregas, setEntregas] = useState<EntregaCuponera[]>([])
  const [cargando, setCargando] = useState(true)
  const [pagina, setPagina] = useState(1)
  const [entregar, setEntregar] = useState<{ tipo: TipoCupon | null } | null>(null)
  const [menu, setMenu] = useState(false)
  const [cambiarClave, setCambiarClave] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const t = resumen.totales
  const disponibles = resumen.tipos.filter(x => x.pendientes > 0)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      if (vista === 'cupones') setCupones(await api.cupones(estado, buscar))
      else setEntregas(await api.entregas())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar')
    }
    setCargando(false)
  }, [api, vista, estado, buscar])

  useEffect(() => {
    const id = setTimeout(cargar, buscar ? 300 : 0)
    return () => clearTimeout(id)
  }, [cargar, buscar])

  useEffect(() => { setPagina(1) }, [vista, estado, buscar])

  useEffect(() => {
    if (!menu) return
    const cerrar = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    document.addEventListener('mousedown', cerrar)
    return () => document.removeEventListener('mousedown', cerrar)
  }, [menu])

  const alTerminarEntrega = async () => {
    setEntregar(null)
    await onRecargar()
    await cargar()
  }

  const pdfDeEntrega = async (entregaId: string) => {
    // La ventana se abre en el clic: abrirla después de la consulta la bloquearía el navegador.
    const w = window.open('', '_blank', 'width=900,height=1000')
    try {
      const filas = await api.cuponesDeEntrega(entregaId)
      if (!w) { printVouchers(filas, filas.length === 1); return }
      escribirCupones(w, filas)
    } catch (e) {
      w?.close()
      toast.error(e instanceof Error ? e.message : 'No se pudo generar el PDF')
    }
  }

  const reenviar = async (e: EntregaCuponera) => {
    const id = toast.loading(`Enviando a ${e.destinatario_correo}…`)
    const r = await api.enviarCorreo(e.id)
    toast.dismiss(id)
    if (r.ok) toast.success(`Correo enviado a ${e.destinatario_correo}`)
    else toast.error(r.error ?? 'No se pudo enviar el correo')
    cargar()
  }

  const visibles = cupones.slice(0, pagina * POR_PAGINA)

  return (
    <div className="cpn-shell">
      <header className="cpn-top">
        <div className="cpn-top-brand">
          <CorsaLogoCompleto width={112} color="#fff"/>
          <span className="cpn-top-sep"/>
          <span className="cpn-top-product"><span className="cpn-dot"/>Cuponera Digital</span>
        </div>
        <div className="cpn-top-right">
          <span className="cpn-top-client" title={resumen.cliente.nombre}>{resumen.cliente.nombre}</span>
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button className="cpn-avatar" onClick={() => setMenu(m => !m)} aria-label="Mi cuenta" aria-expanded={menu}>
              {iniciales(resumen.usuario.nombre)}
            </button>
            {menu && (
              <div className="cpn-menu" role="menu">
                <div className="cpn-menu-head">
                  <strong>{resumen.usuario.nombre}</strong>
                  <span>{resumen.usuario.correo}</span>
                </div>
                <button role="menuitem" onClick={() => { setMenu(false); setCambiarClave(true) }}>Cambiar contraseña</button>
                <button role="menuitem" onClick={onSalir}>Cerrar sesión</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="cpn-main">
        <div className="cpn-inner">
          <div className="cpn-hero">
            <div>
              <h1>Hola, {resumen.usuario.nombre.split(' ')[0]}</h1>
              <div className="cpn-hero-sub">Cuponera Digital de {resumen.cliente.nombre}</div>
            </div>
            <button className="btn btn-primary cpn-btn-xl" onClick={() => setEntregar({ tipo: null })} disabled={t.pendientes === 0}>
              <IconoEnviar/> Entregar cupones
            </button>
          </div>

          <div className="kpi-grid cpn-kpis">
            <div className="kpi-card primary">
              <span className="kpi-corner"/>
              <div className="kpi-label">Cupones comprados</div>
              <div className="kpi-value">{t.comprados.toLocaleString('es-SV')}</div>
              <div className="kpi-sub" style={{ color: 'color-mix(in srgb, var(--on-primary) 65%, transparent)' }}>
                {resumen.tipos.length === 1 ? nombreTipo(resumen.tipos[0]) : `${resumen.tipos.length} tipos de servicio`}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Entregados</div>
              <div className="kpi-value">{t.entregados.toLocaleString('es-SV')}</div>
              <div className="kpi-sub">{pct(t.entregados, t.comprados)}% del total</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Pendientes de entregar</div>
              <div className="kpi-value">{t.pendientes.toLocaleString('es-SV')}</div>
              <div className="kpi-sub">Disponibles para entregar</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Redimidos</div>
              <div className="kpi-value">{t.redimidos.toLocaleString('es-SV')}</div>
              <div className="kpi-sub">Ya usados en CORSA</div>
            </div>
          </div>

          {t.comprados > 0 && (
            <div className="cpn-card">
              <div className="cpn-card-title">Avance de la cuponera</div>
              <div className="cpn-card-sub">
                Se ha entregado el {pct(t.entregados, t.comprados)}% y se ha usado el {pct(t.redimidos, t.comprados)}% de los cupones.
              </div>
              <div className="cpn-bar" role="img" aria-label={`${t.redimidos} redimidos, ${Math.max(0, t.comprados - t.pendientes - t.redimidos)} entregados sin usar, ${t.pendientes} pendientes`}>
                <span className="cpn-bar-redimido" style={{ width: `${(t.redimidos / t.comprados) * 100}%` }}/>
                <span className="cpn-bar-entregado" style={{ width: `${(Math.max(0, t.comprados - t.pendientes - t.redimidos) / t.comprados) * 100}%` }}/>
              </div>
              <div className="cpn-legend">
                <span><i style={{ background: 'var(--corsa-orange)' }}/>Redimidos · {t.redimidos}</span>
                <span><i style={{ background: 'var(--corsa-green)' }}/>Entregados sin usar · {Math.max(0, t.comprados - t.pendientes - t.redimidos)}</span>
                <span><i style={{ background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}/>Pendientes · {t.pendientes}</span>
              </div>
            </div>
          )}

          {resumen.tipos.length > 0 && (
            <div>
              <div className="cpn-card-title" style={{ marginBottom: 10 }}>Disponibles por servicio</div>
              <div className="cpn-tipos">
                {resumen.tipos.map(tp => (
                  <div key={`${tp.service_code}-${tp.size}-${tp.includes_aspirado}`} className="cpn-tipo">
                    <div className="cpn-tipo-name">{tp.service_name}{tp.size ? ` ${tp.size}` : ''}</div>
                    <div className="cpn-tipo-meta">
                      <span className="badge badge-neutral">Lavado {tp.service_name}</span>
                      {tp.includes_aspirado && <span className="badge badge-success">+ aspirado de interiores</span>}
                    </div>
                    <div className="cpn-tipo-count"><strong>{tp.pendientes}</strong>pendientes de {tp.comprados}</div>
                    <div className="cpn-mini-bar"><span style={{ width: `${pct(tp.comprados - tp.pendientes, tp.comprados)}%` }}/></div>
                    <button className="btn btn-ghost" style={{ justifyContent: 'center' }} disabled={tp.pendientes === 0}
                            onClick={() => setEntregar({ tipo: tp })}>
                      {tp.pendientes === 0 ? 'Todos entregados' : 'Entregar'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="cpn-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '18px 20px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="cpn-toolbar">
                <div className="filter-pills">
                  <button className={`filter-pill${vista === 'cupones' ? ' active' : ''}`} onClick={() => setVista('cupones')}>Cupones</button>
                  <button className={`filter-pill${vista === 'entregas' ? ' active' : ''}`} onClick={() => setVista('entregas')}>Entregas</button>
                </div>
                {vista === 'cupones' && (
                  <input className="corsa-input" style={{ flex: '0 1 300px', minWidth: 0 }} value={buscar}
                         onChange={e => setBuscar(e.target.value)} placeholder="Buscar por número, nombre o correo…"/>
                )}
              </div>
              {vista === 'cupones' && (
                <div className="filter-pills">
                  {ESTADOS.map(e => (
                    <button key={e.label} className={`filter-pill${estado === e.id ? ' active' : ''}`}
                            style={{ padding: '6px 14px', fontSize: 12.5, background: estado === e.id ? undefined : 'var(--page-bg)' }}
                            onClick={() => setEstado(e.id)}>{e.label}</button>
                  ))}
                </div>
              )}
            </div>

            {cargando ? (
              <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
            ) : vista === 'cupones' ? (
              cupones.length === 0 ? (
                <div className="empty-state" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="empty-state-title">Sin cupones en este filtro</div>
                  <div className="empty-state-sub">
                    {estado === 'entregado' ? 'Cuando entregues cupones aparecerán aquí.' : estado === 'redimido' ? 'Los cupones que se usen en CORSA aparecerán aquí.' : 'Prueba con otro filtro.'}
                  </div>
                </div>
              ) : (
                <>
                  <div className="table-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                    <table className="corsa-table cpn-table">
                      <thead>
                        <tr>
                          <th>N° de cupón</th><th>Servicio</th><th>Estado</th><th>Entregado a</th>
                          <th className="cpn-hide-sm">Fecha</th><th style={{ textAlign: 'right' }}>PDF</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibles.map(c => (
                          <tr key={c.id}>
                            <td>
                              <div className="cpn-code">{c.code}</div>
                              <div className="cpn-muted" style={{ fontSize: 11 }}>Corr. {String(c.sequence_number).padStart(6, '0')}</div>
                            </td>
                            <td>{nombreTipo(c)}</td>
                            <td><BadgeEstado estado={c.estado}/></td>
                            <td>
                              {c.entregado_a
                                ? <><div style={{ fontWeight: 600 }}>{c.entregado_a}</div><div className="cpn-muted">{c.entregado_correo ?? 'Sin correo'}</div></>
                                : <span className="cpn-muted">—</span>}
                            </td>
                            <td className="cpn-hide-sm cpn-muted">
                              {c.estado === 'redimido' ? `Usado ${fecha(c.redeemed_at)}` : c.entregado_at ? `Entregado ${fecha(c.entregado_at)}` : `Comprado ${fecha(c.created_at)}`}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {/* Sólo lo entregado se imprime: un pendiente impreso
                                  circularía sin saber a quién se le dio. */}
                              {c.entrega_id
                                ? <button className="btn btn-ghost cpn-btn-sm" onClick={() => printVouchers([c], true)}>Descargar</button>
                                : <span className="cpn-muted">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {cupones.length > visibles.length && (
                    <div style={{ padding: 14, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
                      <button className="btn btn-ghost" onClick={() => setPagina(p => p + 1)}>
                        Mostrar más ({cupones.length - visibles.length} restantes)
                      </button>
                    </div>
                  )}
                </>
              )
            ) : entregas.length === 0 ? (
              <div className="empty-state" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="empty-state-title">Todavía no has entregado cupones</div>
                <div className="empty-state-sub">Usa «Entregar cupones» para enviar el primero.</div>
              </div>
            ) : (
              <div className="table-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                <table className="corsa-table cpn-table">
                  <thead>
                    <tr>
                      <th>Fecha</th><th>Para</th><th>Cupones</th><th className="cpn-hide-sm">Entregó</th>
                      <th>Correo</th><th style={{ textAlign: 'right' }}>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entregas.map(e => (
                      <tr key={e.id}>
                        <td className="cpn-muted" style={{ whiteSpace: 'nowrap' }}>{formatearFechaHora(e.created_at)}</td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{e.destinatario_nombre}</div>
                          <div className="cpn-muted">{e.destinatario_correo ?? 'Sin correo · entregado en PDF'}</div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{e.cantidad} · {e.servicios}</div>
                          <div className="cpn-muted cpn-code" style={{ fontSize: 11.5, fontWeight: 600 }}>
                            {e.codigos.slice(0, 4).join(' · ')}{e.codigos.length > 4 ? ` +${e.codigos.length - 4}` : ''}
                          </div>
                          {e.redimidos > 0 && <div className="cpn-muted">{e.redimidos} de {e.cantidad} ya usados</div>}
                        </td>
                        <td className="cpn-hide-sm cpn-muted">{e.entregado_por}</td>
                        <td><BadgeCorreo e={e}/></td>
                        <td>
                          <div className="cpn-actions">
                            <button className="btn btn-ghost cpn-btn-sm" onClick={() => pdfDeEntrega(e.id)}>PDF</button>
                            {e.destinatario_correo && (
                              <button className="btn btn-ghost cpn-btn-sm" onClick={() => reenviar(e)}>
                                {e.correo_estado ? 'Reenviar' : 'Enviar'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="cpn-foot">
            CORSA Carwash · Cada cupón vale por un lavado y se usa una sola vez. ¿Necesitas más cupones? Comunícate con CORSA.
          </div>
        </div>
      </main>

      {entregar && (
        <DialogoEntrega api={api} tipos={disponibles} inicial={entregar.tipo}
                        onCerrar={() => setEntregar(null)} onTerminado={alTerminarEntrega}/>
      )}
      {cambiarClave && <DialogoClave api={api} onCerrar={() => setCambiarClave(false)}/>}
    </div>
  )
}

function BadgeEstado({ estado }: { estado: EstadoCupon }) {
  const [cls, txt] = {
    pendiente: ['badge-neutral', 'Pendiente'],
    entregado: ['badge-green', 'Entregado'],
    redimido: ['badge-success', 'Redimido'],
    anulado: ['badge-danger', 'Anulado'],
  }[estado]
  return <span className={`badge ${cls}`}>{txt}</span>
}

function BadgeCorreo({ e }: { e: EntregaCuponera }) {
  if (!e.destinatario_correo) return <span className="badge badge-neutral">Sólo PDF</span>
  if (e.correo_estado === 'sent') return <span className="badge badge-success" title={e.correo_at ? formatearFechaHora(e.correo_at) : ''}>Enviado</span>
  if (e.correo_estado === 'failed') return <span className="badge badge-danger" title={e.correo_error ?? ''}>No se envió</span>
  return <span className="badge badge-warning">Sin enviar</span>
}

// ─── Entregar ─────────────────────────────────────────────────

function DialogoEntrega({ api, tipos, inicial, onCerrar, onTerminado }: {
  api: PortalApi
  tipos: TipoCupon[]
  inicial: TipoCupon | null
  onCerrar: () => void
  onTerminado: () => void
}) {
  const [tipo, setTipo] = useState<TipoCupon | null>(inicial ?? (tipos.length === 1 ? tipos[0] : null))
  const [cantidad, setCantidad] = useState(1)
  const [nombre, setNombre] = useState('')
  const [correo, setCorreo] = useState('')
  const [nota, setNota] = useState('')
  const [porCorreo, setPorCorreo] = useState(true)
  const [porPdf, setPorPdf] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hecho, setHecho] = useState<{ entregaId: string; cupones: CuponPortal[]; nombre: string; correo: string | null } | null>(null)
  const [estadoCorreo, setEstadoCorreo] = useState<'no' | 'enviando' | 'ok' | 'mal'>('no')
  const [errorCorreo, setErrorCorreo] = useState<string | null>(null)

  const max = Math.min(100, tipo?.pendientes ?? 0)
  const correoOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo.trim())
  const listo = Boolean(tipo && cantidad >= 1 && cantidad <= max && nombre.trim()
    && (porCorreo || porPdf) && (!porCorreo || correoOk) && (!correo.trim() || correoOk))

  useEffect(() => { if (cantidad > max && max > 0) setCantidad(max) }, [max, cantidad])

  const mandarCorreo = async (entregaId: string, destino: string) => {
    setEstadoCorreo('enviando')
    setErrorCorreo(null)
    const r = await api.enviarCorreo(entregaId)
    if (r.ok) setEstadoCorreo('ok')
    else { setEstadoCorreo('mal'); setErrorCorreo(r.error ?? `No se pudo enviar a ${destino}`) }
  }

  const confirmar = async () => {
    if (!tipo || !listo) return
    setError(null)
    // La ventana del PDF se abre en el clic, antes de esperar al servidor.
    const w = porPdf ? window.open('', '_blank', 'width=900,height=1000') : null
    w?.document.write('<p style="font-family:sans-serif;padding:24px">Preparando los cupones…</p>')
    setEnviando(true)
    try {
      const r = await api.entregar({
        nombre: nombre.trim(), correo: correo.trim() || null, cantidad, tipo, nota: nota.trim() || null,
      })
      setHecho({ entregaId: r.entrega_id, cupones: r.cupones, nombre: nombre.trim(), correo: correo.trim() || null })
      if (w) escribirCupones(w, r.cupones)
      if (porCorreo && correo.trim()) mandarCorreo(r.entrega_id, correo.trim())
    } catch (e) {
      w?.close()
      setError(e instanceof Error ? e.message : 'No se pudieron entregar los cupones')
    }
    setEnviando(false)
  }

  if (hecho) {
    const n = hecho.cupones.length
    return (
      <Modal open onClose={onTerminado} title="Cupones entregados" maxWidth={540}>
        <div style={{ textAlign: 'center' }}>
          <div className="cpn-ok"><IconoCheck size={26}/></div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20, marginTop: 10 }}>
            {n === 1 ? 'Se entregó 1 cupón' : `Se entregaron ${n} cupones`} a {hecho.nombre}
          </div>
          <div className="cpn-muted" style={{ marginTop: 2 }}>{nombreTipo(hecho.cupones[0])}</div>
        </div>

        <div className="cpn-chips" style={{ justifyContent: 'center' }}>
          {hecho.cupones.map(c => <span key={c.id} className="cpn-chip">{c.code}</span>)}
        </div>

        {hecho.correo && estadoCorreo !== 'no' && (
          <div className={`cpn-estado-correo ${estadoCorreo === 'ok' ? 'ok' : estadoCorreo === 'mal' ? 'mal' : 'wait'}`}>
            {estadoCorreo === 'enviando' && <><div className="spinner" style={{ width: 16, height: 16 }}/>Enviando a {hecho.correo}…</>}
            {estadoCorreo === 'ok' && <><IconoCheck size={16}/>Correo enviado a <strong>{hecho.correo}</strong></>}
            {estadoCorreo === 'mal' && <span style={{ flex: 1 }}>{errorCorreo}</span>}
            {estadoCorreo === 'mal' && (
              <button className="btn btn-ghost cpn-btn-sm" onClick={() => mandarCorreo(hecho.entregaId, hecho.correo!)}>Reintentar</button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button className="btn btn-ghost" onClick={() => printVouchers(hecho.cupones, n === 1)}><IconoPdf/> Descargar PDF</button>
          {hecho.correo && estadoCorreo === 'no' && (
            <button className="btn btn-ghost" onClick={() => mandarCorreo(hecho.entregaId, hecho.correo!)}><IconoEnviar/> Enviar por correo</button>
          )}
          <button className="btn btn-primary" onClick={onTerminado}>Listo</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onCerrar} title="Entregar cupones" maxWidth={560}>
      {tipos.length === 0 ? (
        <div className="empty-state"><div className="empty-state-title">No quedan cupones por entregar</div></div>
      ) : (
        <>
          <div className="field">
            <label>Tipo de cupón</label>
            {tipos.length === 1 ? (
              <div className="cpn-resumen-entrega"><strong>{nombreTipo(tipos[0])}</strong> · {tipos[0].pendientes} disponibles</div>
            ) : (
              <div className="cpn-opciones">
                {tipos.map(tp => {
                  const on = tipo === tp || (tipo && tp.service_code === tipo.service_code && tp.size === tipo.size && tp.includes_aspirado === tipo.includes_aspirado)
                  return (
                    <button key={`${tp.service_code}-${tp.size}-${tp.includes_aspirado}`} className={`cpn-opcion${on ? ' on' : ''}`} onClick={() => setTipo(tp)}>
                      <span>
                        <div className="cpn-opcion-title">{nombreTipo(tp)}</div>
                        <div className="cpn-opcion-sub">{tp.pendientes} disponibles</div>
                      </span>
                      <span className="cpn-check">{on && <IconoCheck size={13}/>}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="field">
            <label>Cantidad</label>
            <div className="cpn-stepper">
              <button onClick={() => setCantidad(c => Math.max(1, c - 1))} aria-label="Uno menos" disabled={!tipo}>−</button>
              <input className="corsa-input" type="number" min={1} max={max} value={cantidad} disabled={!tipo}
                     onChange={e => setCantidad(Math.max(1, Math.min(max || 1, parseInt(e.target.value) || 1)))}/>
              <button onClick={() => setCantidad(c => Math.min(max, c + 1))} aria-label="Uno más" disabled={!tipo}>+</button>
              <span className="cpn-muted">{tipo ? `de ${tipo.pendientes} disponibles${tipo.pendientes > 100 ? ' · máximo 100 por entrega' : ''}` : 'Elige el tipo de cupón'}</span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <div className="field">
              <label htmlFor="cpn-dest">Nombre de quien recibe</label>
              <input id="cpn-dest" className="corsa-input" value={nombre} maxLength={120} onChange={e => setNombre(e.target.value)} placeholder="Ej. María López"/>
            </div>
            <div className="field">
              <label htmlFor="cpn-dest-mail">Correo {porCorreo ? '' : '(opcional)'}</label>
              <input id="cpn-dest-mail" className="corsa-input" type="email" value={correo} onChange={e => setCorreo(e.target.value)} placeholder="maria@correo.com"/>
            </div>
          </div>

          <div className="field">
            <label htmlFor="cpn-nota">Mensaje (opcional, va en el correo)</label>
            <textarea id="cpn-nota" className="corsa-input" rows={2} maxLength={300} value={nota} onChange={e => setNota(e.target.value)}
                      placeholder="Ej. ¡Gracias por tu excelente trabajo este mes!" style={{ resize: 'vertical' }}/>
          </div>

          <div className="field">
            <label>¿Cómo lo entregas? Puedes elegir los dos</label>
            <div className="cpn-opciones">
              <button className={`cpn-opcion${porCorreo ? ' on' : ''}`} onClick={() => setPorCorreo(v => !v)} aria-pressed={porCorreo}>
                <span className="cpn-opcion-icon"><IconoEnviar/></span>
                <span><div className="cpn-opcion-title">Enviar por correo</div><div className="cpn-opcion-sub">Le llega el cupón en PDF desde CORSA Carwash</div></span>
                <span className="cpn-check">{porCorreo && <IconoCheck size={13}/>}</span>
              </button>
              <button className={`cpn-opcion${porPdf ? ' on' : ''}`} onClick={() => setPorPdf(v => !v)} aria-pressed={porPdf}>
                <span className="cpn-opcion-icon"><IconoPdf/></span>
                <span><div className="cpn-opcion-title">Imprimir o guardar en PDF</div><div className="cpn-opcion-sub">Para entregarlo en mano o compartirlo tú</div></span>
                <span className="cpn-check">{porPdf && <IconoCheck size={13}/>}</span>
              </button>
            </div>
          </div>

          {error && <div className="badge badge-danger" style={{ padding: '10px 12px', borderRadius: 12, fontSize: 13, whiteSpace: 'normal' }}>{error}</div>}

          {tipo && nombre.trim() && (
            <div className="cpn-resumen-entrega">
              Vas a entregar <strong>{cantidad} {cantidad === 1 ? 'cupón' : 'cupones'} {nombreTipo(tipo)}</strong> a <strong>{nombre.trim()}</strong>
              {porCorreo && correoOk ? <> y se enviarán a <strong>{correo.trim()}</strong></> : null}. Esta acción no se puede deshacer.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
            <button className="btn btn-primary" disabled={!listo || enviando} onClick={confirmar}>
              {enviando ? 'Entregando…' : `Entregar ${cantidad} ${cantidad === 1 ? 'cupón' : 'cupones'}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

function DialogoClave({ api, onCerrar }: { api: PortalApi; onCerrar: () => void }) {
  const [clave, setClave] = useState('')
  const [repite, setRepite] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ok = clave.length >= 8 && clave === repite

  const guardar = async () => {
    setGuardando(true)
    const err = await api.cambiarClave(clave)
    setGuardando(false)
    if (err) { setError(err); return }
    toast.success('Contraseña actualizada')
    onCerrar()
  }

  return (
    <Modal open onClose={onCerrar} title="Cambiar contraseña" maxWidth={420}>
      <div className="field"><label>Contraseña nueva</label>
        <input className="corsa-input" type="password" autoComplete="new-password" value={clave} onChange={e => setClave(e.target.value)} placeholder="Mínimo 8 caracteres"/></div>
      <div className="field"><label>Repítela</label>
        <input className="corsa-input" type="password" autoComplete="new-password" value={repite} onChange={e => setRepite(e.target.value)}/></div>
      {error && <div className="cpn-muted" style={{ color: 'var(--color-danger-text)' }}>{error}</div>}
      {repite && clave !== repite && <div className="cpn-muted">Las contraseñas no coinciden.</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
        <button className="btn btn-primary" disabled={!ok || guardando} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</button>
      </div>
    </Modal>
  )
}

// ─── Iconos ───────────────────────────────────────────────────

function IconoEnviar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>
    </svg>
  )
}

function IconoPdf() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>
    </svg>
  )
}

function IconoCheck({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}
