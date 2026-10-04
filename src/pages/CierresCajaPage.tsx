/**
 * CORSA — Cierres de caja (0065).
 *
 * El historial día a día, para control: por cada turno el efectivo inicial,
 * las ventas por forma de pago, los retiros (con motivo y quién autorizó), la
 * remesa y el efectivo final. Al elegir uno se ve su reporte, el mismo PDF que
 * llega por correo. La notificación del cierre abre /cierres-caja/<turno>.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { fetchHistorialCaja, fetchReporteCaja, type ResumenCaja } from '../services/caja.service'
import { enviarCierreCaja } from '../services/correo.service'
import { emisorParaTicket } from '../lib/fiscal/emisor'
import { diaDelTurno, reporteCierreHTML } from '../lib/caja/reporteCierre'

const money = (n: number) => 'US$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const hora = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit', timeZone: 'America/El_Salvador' }) : '—'
const hoySV = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' })
const haceDias = (n: number) => { const d = new Date(`${hoySV()}T12:00:00`); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10) }

export function CierresCajaPage() {
  const { id } = useParams<{ id?: string }>()
  return id ? <ReporteCierre sessionId={id}/> : <Historial/>
}

// ─── Historial ─────────────────────────────────────────────────

function Historial() {
  const navigate = useNavigate()
  const { currentBranch } = useAuth()
  const [desde, setDesde] = useState(haceDias(30))
  const [hasta, setHasta] = useState(hoySV())
  const [filas, setFilas] = useState<ResumenCaja[]>([])
  const [cargando, setCargando] = useState(true)
  const [abierto, setAbierto] = useState<string | null>(null)
  const branchId = (currentBranch as any)?.id ?? null

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      setFilas(await fetchHistorialCaja(desde, hasta, branchId))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudieron cargar los cierres')
    }
    setCargando(false)
  }, [desde, hasta, branchId])
  useEffect(() => { cargar() }, [cargar])

  const tot = useMemo(() => filas.reduce((t, r) => ({
    ventas: t.ventas + r.ventas.total, efectivo: t.efectivo + r.ventas.efectivo, tarjeta: t.tarjeta + r.ventas.tarjeta,
    transferencia: t.transferencia + r.ventas.transferencia, retiros: t.retiros + r.egresos_efectivo, remesa: t.remesa + r.remesa,
  }), { ventas: 0, efectivo: 0, tarjeta: 0, transferencia: 0, retiros: 0, remesa: 0 }), [filas])

  return (
    <div className="page-inner" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 24, margin: 0 }}>Cierres de caja</h1>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Día a día: ventas por forma de pago, retiros, remesa y efectivo final.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label className="ficha-campo"><span>Desde</span>
            <input className="corsa-input" type="date" value={desde} max={hasta} onChange={e => setDesde(e.target.value)} style={{ padding: '7px 10px' }}/></label>
          <label className="ficha-campo"><span>Hasta</span>
            <input className="corsa-input" type="date" value={hasta} min={desde} onChange={e => setHasta(e.target.value)} style={{ padding: '7px 10px' }}/></label>
        </div>
      </div>

      <div className="cxc-tarjetas">
        {[
          ['Ventas', tot.ventas], ['Efectivo', tot.efectivo], ['Tarjeta', tot.tarjeta],
          ['Transferencias', tot.transferencia], ['Retiros', tot.retiros], ['Remesado', tot.remesa],
        ].map(([t, v]) => (
          <div key={t as string} className="cxc-tarjeta" style={{ padding: '12px 14px' }}>
            <div className="cxc-tarjeta-titulo">{t}</div>
            <div className="cxc-tarjeta-valor" style={{ fontSize: 20 }}>{money(v as number)}</div>
          </div>
        ))}
      </div>

      <section className="cxc-seccion" style={{ padding: '12px 14px', borderRadius: 12 }}>
        {cargando ? <div className="spinner" style={{ width: 18, height: 18 }}/> : filas.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>No hay cierres en ese rango.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="corsa-table cxc-tabla" style={{ border: 'none' }}>
              <thead><tr>
                <th>Día</th><th>Sucursal</th><th>Horario</th>
                <th style={{ textAlign: 'right' }}>Inicial</th><th style={{ textAlign: 'right' }}>Efectivo</th>
                <th style={{ textAlign: 'right' }}>Tarjeta</th><th style={{ textAlign: 'right' }}>Transf.</th>
                <th style={{ textAlign: 'right' }}>Retiros</th><th style={{ textAlign: 'right' }}>Remesa</th>
                <th style={{ textAlign: 'right' }}>Final</th><th/>
              </tr></thead>
              <tbody>
                {filas.map(r => {
                  const ab = abierto === r.session_id
                  return (<Fragment key={r.session_id}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setAbierto(ab ? null : r.session_id)}>
                      <td style={{ fontWeight: 700, textTransform: 'capitalize' }}>{diaDelTurno(r.abierta_at)}</td>
                      <td>{r.sucursal}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{hora(r.abierta_at)}–{r.estado === 'open' ? 'abierta' : hora(r.cerrada_at)}</td>
                      <td className="tnum" style={{ textAlign: 'right' }}>{money(r.efectivo_inicial)}</td>
                      <td className="tnum" style={{ textAlign: 'right' }}>{money(r.ventas.efectivo)}</td>
                      <td className="tnum" style={{ textAlign: 'right' }}>{money(r.ventas.tarjeta)}</td>
                      <td className="tnum" style={{ textAlign: 'right' }}>{money(r.ventas.transferencia)}</td>
                      <td className="tnum" style={{ textAlign: 'right', color: r.egresos_efectivo ? 'var(--color-danger-text)' : undefined }}>{money(r.egresos_efectivo)}</td>
                      <td className="tnum" style={{ textAlign: 'right' }}>{money(r.remesa)}</td>
                      <td className="tnum" style={{ textAlign: 'right', fontWeight: 800 }}>
                        {r.estado === 'open' ? <span className="badge badge-warning">Abierta</span> : money(r.efectivo_final)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); navigate(`/cierres-caja/${r.session_id}`) }}>Reporte</button>
                      </td>
                    </tr>
                    {ab && (
                      <tr style={{ cursor: 'default' }}>
                        <td colSpan={11} className="envuelve" style={{ background: 'var(--subtle-bg)' }}>
                          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12.5, padding: '4px 0 8px' }}>
                            <span>Abrió <b>{r.abrio}</b> {hora(r.abierta_at)}</span>
                            <span>Cerró <b>{r.cerro ?? '—'}</b> {hora(r.cerrada_at)}</span>
                            <span>{r.ventas.cantidad} ventas · total {money(r.ventas.total)}</span>
                            <span>Efectivo antes de remesar {money(r.efectivo_disponible)}</span>
                          </div>
                          {r.movimientos.length === 0 ? (
                            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin retiros ni remesa.</div>
                          ) : r.movimientos.map(m => (
                            <div key={m.id} style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                              <span style={{ width: 48, color: 'var(--text-secondary)' }}>{hora(m.fecha)}</span>
                              <span style={{ width: 80, fontWeight: 600 }}>{m.tipo === 'deposit' ? 'Remesa' : 'Retiro'}</span>
                              <span style={{ flex: 1 }}>{m.motivo}
                                <span style={{ color: 'var(--text-secondary)' }}> · registró {m.registro}{m.autorizo ? ` · autorizó ${m.autorizo}` : ''}</span>
                              </span>
                              <span className="tnum" style={{ fontWeight: 700 }}>−{money(m.monto)}</span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>)
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

// ─── Reporte de un cierre ──────────────────────────────────────

function ReporteCierre({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const marco = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let vivo = true
    ;(async () => {
      try {
        const r = await fetchReporteCaja(sessionId)
        const emisor = await emisorParaTicket(r.branch_id, false)
        if (vivo) setHtml(reporteCierreHTML({ emisor, resumen: r }))
      } catch (e) {
        if (vivo) setError(e instanceof Error ? e.message : 'No se pudo cargar el reporte')
      }
    })()
    return () => { vivo = false }
  }, [sessionId])

  const reenviar = async () => {
    if (!window.confirm('¿Enviar de nuevo el reporte de cierre por correo?')) return
    setEnviando(true)
    const r = await enviarCierreCaja(sessionId)
    setEnviando(false)
    if (r.ok) toast.success(`Reporte enviado a ${r.destinatarios?.join(', ') ?? ''}`)
    else toast.error(r.error ?? 'No se pudo enviar', { duration: 10000 })
  }

  return (
    <div className="page-inner" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/cierres-caja')}>← Cierres de caja</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={reenviar} disabled={enviando || !html}>{enviando ? 'Enviando…' : 'Reenviar por correo'}</button>
          <button className="btn btn-primary btn-sm" disabled={!html}
                  onClick={() => { marco.current?.contentWindow?.focus(); marco.current?.contentWindow?.print() }}>Imprimir / PDF</button>
        </div>
      </div>
      {error ? <div className="alert-banner danger"><div className="alert-body">{error}</div></div>
        : !html ? <div className="spinner" style={{ width: 22, height: 22 }}/>
        : <iframe ref={marco} title="Reporte de cierre de caja" srcDoc={html}
                  style={{ width: '100%', minHeight: '80vh', border: '1px solid var(--border)', borderRadius: 12, background: '#fff' }}/>}
    </div>
  )
}
