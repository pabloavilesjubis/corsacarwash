/**
 * CORSA — Cierre de caja y manejo de efectivo (0065).
 *
 * Desde el POS. Tres momentos de la misma caja:
 *   · sin turno abierto: se abre sola con lo que quedó en el último cierre
 *     (sólo la primera apertura de la sucursal pide el monto);
 *   · abierta: ventas por forma de pago, el efectivo que debería haber y los
 *     retiros del día; se registra un retiro con motivo, monto y quién autoriza;
 *   · al cerrar: la remesa, el efectivo final, el reporte en PDF por correo y
 *     la notificación a los celulares (la emite la base al cerrar).
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import {
  abrirCaja, asegurarCajaAbierta, cerradaHoy, cerrarCaja, fetchAutorizadores, fetchEstadoCaja, retirarEfectivo, type EstadoCaja, type ResumenCaja,
} from '../../services/caja.service'
import { enviarCierreCaja } from '../../services/correo.service'
import { emisorParaTicket } from '../../lib/fiscal/emisor'
import { imprimirReporteCierre, reporteCierreHTML } from '../../lib/caja/reporteCierre'

const money = (n: number) => 'US$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit', timeZone: 'America/El_Salvador' })
const monto = (v: string) => Math.round((parseFloat(v) || 0) * 100) / 100

export function CajaModal({ branchId, onCerrar }: { branchId: string; onCerrar: () => void }) {
  const { hasPermission } = useAuth()
  const [estado, setEstado] = useState<EstadoCaja | null>(null)
  const [cargando, setCargando] = useState(true)
  const [ocupado, setOcupado] = useState(false)
  // Apertura
  const [inicial, setInicial] = useState('')
  // Retiro
  const [verRetiro, setVerRetiro] = useState(false)
  const [retMonto, setRetMonto] = useState('')
  const [retMotivo, setRetMotivo] = useState('')
  const [retAutoriza, setRetAutoriza] = useState('')
  const [autorizadores, setAutorizadores] = useState<{ id: string; nombre: string }[]>([])
  // Cierre
  const [verCierre, setVerCierre] = useState(false)
  const [remesa, setRemesa] = useState('')
  const [cerrado, setCerrado] = useState<ResumenCaja | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      // Cerrada y con un cierre anterior: se abre sola con lo que quedó ahí.
      if (hasPermission('cash.open')) {
        const r = await asegurarCajaAbierta(branchId)
        setEstado(r.estado)
        if (r.abrioAhora != null) toast.success(`Caja abierta con ${money(r.abrioAhora)} del último cierre`)
      } else {
        setEstado(await fetchEstadoCaja(branchId))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cargar la caja')
    }
    setCargando(false)
  }, [branchId, hasPermission])
  useEffect(() => { cargar() }, [cargar])

  useEffect(() => {
    if (!verRetiro || autorizadores.length) return
    fetchAutorizadores().then(setAutorizadores).catch(() => setAutorizadores([]))
  }, [verRetiro, autorizadores.length])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar])

  const s = estado?.sesion ?? null

  const abrir = async () => {
    // Con un cierre anterior el monto es lo que quedó ahí; sólo la primera
    // apertura de la caja lo pide.
    const previo = estado?.ultimo_cierre?.efectivo_final
    const m = previo ?? monto(inicial)
    if (previo == null && (m < 0 || inicial.trim() === '')) { toast.error('Ingresá el efectivo inicial'); return }
    if (!window.confirm(`¿Abrir la caja con ${money(m)} de efectivo inicial${previo != null ? ' (lo que quedó en el último cierre)' : ''}?`)) return
    setOcupado(true)
    try {
      await abrirCaja(branchId, m)
      toast.success('Caja abierta')
      await cargar()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo abrir la caja')
    }
    setOcupado(false)
  }

  const retirar = async () => {
    if (!s) return
    const m = monto(retMonto)
    if (m <= 0) { toast.error('Ingresá el monto del retiro'); return }
    if (!retMotivo.trim()) { toast.error('Escribí el motivo del retiro'); return }
    if (!retAutoriza) { toast.error('Elegí quién autoriza'); return }
    const quien = autorizadores.find(a => a.id === retAutoriza)?.nombre ?? ''
    if (!window.confirm(`¿Registrar un retiro de ${money(m)}?\nMotivo: ${retMotivo.trim()}\nAutoriza: ${quien}`)) return
    setOcupado(true)
    try {
      const r = await retirarEfectivo(s.session_id, m, retMotivo.trim(), retAutoriza)
      setEstado(e => e ? { ...e, sesion: r } : e)
      toast.success(`Retiro de ${money(m)} registrado`)
      setRetMonto(''); setRetMotivo(''); setRetAutoriza(''); setVerRetiro(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar el retiro')
    }
    setOcupado(false)
  }

  const remesaNum = monto(remesa)
  const finalCalculado = s ? Math.round((s.efectivo_disponible - remesaNum) * 100) / 100 : 0

  const cerrar = async () => {
    if (!s) return
    if (remesaNum < 0 || remesaNum > s.efectivo_disponible + 0.001) {
      toast.error(`La remesa tiene que estar entre ${money(0)} y ${money(s.efectivo_disponible)}`); return
    }
    if (!window.confirm(`¿Cerrar la caja?\nRemesa: ${money(remesaNum)}\nEfectivo final en caja: ${money(finalCalculado)}\n\nSe envía el reporte por correo y a los celulares.`)) return
    setOcupado(true)
    try {
      const r = await cerrarCaja(s.session_id, remesaNum)
      setCerrado(r)
      toast.success('Caja cerrada')
      enviarCierreCaja(r.session_id).then(x => {
        if (x.ok) toast.success(`Reporte de cierre enviado a ${x.destinatarios?.join(', ') ?? ''}`)
        else toast.error(`La caja quedó cerrada, pero el correo no salió: ${x.error ?? ''}`, { duration: 10000 })
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cerrar la caja')
    }
    setOcupado(false)
  }

  const imprimir = async (r: ResumenCaja) => {
    try {
      const emisor = await emisorParaTicket(branchId, false)
      imprimirReporteCierre(reporteCierreHTML({ emisor, resumen: r }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo generar el reporte')
    }
  }

  const retiros = s?.movimientos.filter(m => m.tipo === 'cash_out') ?? []

  return (
    <div className="ficha-fondo" onClick={e => { if (e.target === e.currentTarget) onCerrar() }}>
      <div className="ficha cxc-det" role="dialog" aria-label="Cierre de caja y manejo de efectivo" style={{ maxWidth: 820 }}>
        <header className="ficha-cabecera">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ficha-nombre">Cierre de caja y manejo de efectivo</div>
            <div className="cxc-det-sub">
              {estado?.caja ?? 'Caja'}
              {s && <> · Abierta {hora(s.abierta_at)} por {s.abrio}</>}
              {!s && !cargando && !cerrado && ' · Cerrada'}
            </div>
          </div>
          <div className="cxc-det-acciones">
            {s && !cerrado && <button className="cxc-btn-mini" onClick={() => imprimir(s)}>Reporte parcial</button>}
            <button className="ficha-cerrar" onClick={onCerrar} aria-label="Cerrar">×</button>
          </div>
        </header>

        {cargando ? (
          <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><div className="spinner" style={{ width: 22, height: 22 }}/></div>
        ) : cerrado ? (
          /* ── Recién cerrada ── */
          <div className="ficha-cuerpo" style={{ gridTemplateColumns: '1fr' }}>
            <section className="cxc-seccion">
              <div className="cxc-seccion-titulo">Caja cerrada</div>
              <Linea t="Efectivo inicial" v={cerrado.efectivo_inicial}/>
              <Linea t="+ Ingresos en efectivo" v={cerrado.ingresos_efectivo}/>
              <Linea t="− Retiros" v={cerrado.egresos_efectivo}/>
              <Linea t="− Remesa" v={cerrado.remesa}/>
              <Linea t="Efectivo final en caja" v={cerrado.efectivo_final} fuerte/>
              <div className="cxc-det-pie">
                <span style={{ color: 'var(--text-secondary)' }}>El reporte sale por correo y a los celulares de gerencia.</span>
                <button className="btn btn-primary btn-sm" onClick={() => imprimir(cerrado)}>Imprimir reporte</button>
              </div>
            </section>
          </div>
        ) : !s ? (
          /* ── Sin turno: abrir ── */
          <div className="ficha-cuerpo" style={{ gridTemplateColumns: '1fr' }}>
            <section className="cxc-seccion">
              {estado?.ultimo_cierre && estado && cerradaHoy(estado) ? (<>
                <div className="cxc-seccion-titulo">La caja ya se cerró hoy</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>
                  Quedaron {money(estado.ultimo_cierre.efectivo_final)} en caja. Mañana abre sola con ese monto.
                  Si hace falta seguir vendiendo hoy, se puede abrir de nuevo con lo que quedó.
                </div>
              </>) : (<>
                <div className="cxc-seccion-titulo">Primera apertura de la caja</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Esta caja todavía no tiene cierres. Indicá el efectivo con el que arranca; desde el próximo día abre sola con lo que quede en cada cierre.
                </div>
              </>)}
              {hasPermission('cash.open') ? (
                estado?.ultimo_cierre ? (
                  <button id="caja-abrir" className="btn btn-ghost btn-sm" onClick={abrir} disabled={ocupado}>
                    {ocupado ? 'Abriendo…' : `Abrir de nuevo con ${money(estado.ultimo_cierre.efectivo_final)}`}
                  </button>
                ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label className="ficha-campo" style={{ flex: '1 1 200px' }}>
                    <span>Efectivo inicial (US$)</span>
                    <input id="caja-inicial" className="corsa-input" type="number" min="0" step="0.01" value={inicial}
                           onChange={e => setInicial(e.target.value)} placeholder="0.00" autoFocus/>
                  </label>
                  <button id="caja-abrir" className="btn btn-primary btn-sm" onClick={abrir} disabled={ocupado}>
                    {ocupado ? 'Abriendo…' : 'Abrir caja'}
                  </button>
                </div>
                )
              ) : <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>No tenés permiso para abrir la caja (cash.open).</div>}
            </section>
          </div>
        ) : (
          /* ── Caja abierta ── */
          <>
            <div className="ficha-indicadores">
              <div><div className="cxc-mini">Ventas en efectivo</div><div className="cxc-mini-valor">{money(s.ventas.efectivo)}</div></div>
              <div><div className="cxc-mini">Ventas con tarjeta</div><div className="cxc-mini-valor">{money(s.ventas.tarjeta)}</div></div>
              <div><div className="cxc-mini">Transferencias</div><div className="cxc-mini-valor">{money(s.ventas.transferencia)}</div></div>
              <div><div className="cxc-mini">Efectivo en caja</div><div className="cxc-mini-valor principal">{money(s.efectivo_disponible)}</div></div>
            </div>

            <div className="ficha-cuerpo" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
              <div className="ficha-columna">
                <section className="cxc-seccion">
                  <div className="cxc-seccion-titulo">Efectivo</div>
                  <Linea t="Efectivo inicial" v={s.efectivo_inicial}/>
                  <Linea t="+ Ingresos en efectivo" v={s.ingresos_efectivo}/>
                  <Linea t="− Retiros" v={s.egresos_efectivo}/>
                  <Linea t="Efectivo en caja" v={s.efectivo_disponible} fuerte/>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
                    {s.ventas.cantidad} ventas cobradas · total {money(s.ventas.total)}
                    {s.ventas.otros > 0 && ` · otros ${money(s.ventas.otros)}`}
                  </div>
                </section>

                <section className="cxc-seccion">
                  <div className="cxc-det-cabeza">
                    <div className="cxc-seccion-titulo">Retiros de efectivo ({retiros.length})</div>
                    {!verRetiro && <button id="caja-retiro" className="btn btn-ghost btn-sm" onClick={() => { setVerRetiro(true); setVerCierre(false) }}>Retiro de efectivo de caja</button>}
                  </div>
                  {retiros.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin retiros hoy.</div>
                  ) : retiros.map(m => (
                    <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                      <span style={{ color: 'var(--text-secondary)', width: 44, flexShrink: 0 }}>{hora(m.fecha)}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>{m.motivo}<span style={{ color: 'var(--text-secondary)' }}> · autorizó {m.autorizo ?? '—'}</span></span>
                      <span className="tnum" style={{ fontWeight: 700, color: 'var(--color-danger-text)' }}>−{money(m.monto)}</span>
                    </div>
                  ))}
                </section>
              </div>

              <div className="ficha-columna">
                {verRetiro && (
                  <section className="cxc-seccion">
                    <div className="cxc-seccion-titulo">Retiro de efectivo de caja</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <label className="ficha-campo">
                        <span>Monto (US$) · disponible {money(s.efectivo_disponible)}</span>
                        <input id="retiro-monto" className="corsa-input" type="number" min="0.01" step="0.01" value={retMonto}
                               onChange={e => setRetMonto(e.target.value)} placeholder="0.00" autoFocus/>
                      </label>
                      <label className="ficha-campo">
                        <span>Motivo</span>
                        <input id="retiro-motivo" className="corsa-input" value={retMotivo} onChange={e => setRetMotivo(e.target.value)}
                               placeholder="Compra de insumos, pago a proveedor…"/>
                      </label>
                      <label className="ficha-campo">
                        <span>Autoriza</span>
                        <select id="retiro-autoriza" className="corsa-input" value={retAutoriza} onChange={e => setRetAutoriza(e.target.value)}>
                          <option value="">Elegí quién autoriza…</option>
                          {autorizadores.map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                        </select>
                      </label>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setVerRetiro(false)}>Cancelar</button>
                        <button id="retiro-guardar" className="btn btn-primary btn-sm" onClick={retirar} disabled={ocupado}>
                          {ocupado ? 'Registrando…' : 'Registrar retiro'}
                        </button>
                      </div>
                    </div>
                  </section>
                )}

                <section className="cxc-seccion">
                  <div className="cxc-seccion-titulo">Cierre del día</div>
                  {!hasPermission('cash.close') ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>No tenés permiso para cerrar la caja (cash.close).</div>
                  ) : !verCierre ? (
                    <>
                      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 8 }}>
                        Al cerrar indicás cuánto efectivo se remesa; lo demás queda como efectivo final en caja.
                      </div>
                      <button id="caja-ir-cierre" className="btn btn-primary btn-sm" style={{ width: '100%', justifyContent: 'center' }}
                              onClick={() => { setVerCierre(true); setVerRetiro(false) }}>Remesa de efectivo y cierre</button>
                    </>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <Linea t="Efectivo inicial" v={s.efectivo_inicial}/>
                      <Linea t="+ Ingresos en efectivo" v={s.ingresos_efectivo}/>
                      <Linea t="− Egresos (retiros)" v={s.egresos_efectivo}/>
                      <Linea t="Efectivo en caja" v={s.efectivo_disponible} fuerte/>
                      <label className="ficha-campo">
                        <span>Remesa de efectivo (US$)</span>
                        <div className="cxc-det-monto">
                          <input id="caja-remesa" className="corsa-input" type="number" min="0" step="0.01" value={remesa}
                                 onChange={e => setRemesa(e.target.value)} placeholder="0.00" autoFocus/>
                          <button type="button" onClick={() => setRemesa(s.efectivo_disponible.toFixed(2))}>Todo</button>
                        </div>
                      </label>
                      <Linea t="Efectivo final de cierre" v={finalCalculado} fuerte/>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setVerCierre(false)}>Cancelar</button>
                        <button id="caja-cerrar" className="btn btn-primary btn-sm" onClick={cerrar}
                                disabled={ocupado || finalCalculado < 0}>
                          {ocupado ? 'Cerrando…' : 'Cerrar caja'}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Linea({ t, v, fuerte }: { t: string; v: number; fuerte?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: fuerte ? 13.5 : 12.5,
                  fontWeight: fuerte ? 800 : 400, borderTop: fuerte ? '1px solid var(--border)' : undefined,
                  marginTop: fuerte ? 2 : 0 }}>
      <span style={{ color: fuerte ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{t}</span>
      <span className="tnum">{money(v)}</span>
    </div>
  )
}
