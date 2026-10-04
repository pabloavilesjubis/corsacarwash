/**
 * CORSA Carwash — Cuentas por cobrar
 *
 * Los clientes con crédito y lo que deben. Arriba la cartera entera —total,
 * vencido, crédito otorgado, antigüedad—; abajo, cliente por cliente. Al
 * elegir uno se ve el detalle de su deuda, se registran abonos y se emite su
 * estado de cuenta.
 *
 * Las cifras salen de v_cxc_clientes (0058), que respeta las RLS: quien no
 * tiene ar.read y corporate.read no ve nada.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { emisorParaTicket } from '../lib/fiscal/emisor'
import { diasVencido, estadoCuentaHTML, imprimirEstadoCuenta } from '../lib/cxc/estadoCuenta'
import {
  EVENTO_ETIQUETA, crearCcfConsolidado, fetchCxcClientes, fetchDocumentosCxc, fetchLavadosCredito, fetchMovimientosCredito,
  registrarAbono, type CxcCliente, type DocumentoCxc, type LavadoCredito, type MovimientoCredito,
} from '../services/credito.service'
import { emitirConFirmaLocal } from '../services/fiscal.service'
import { fetchDteDeVenta } from '../services/sales.service'
import { imprimirTicketEnSegundoPlano } from '../lib/ticket/corsaTicket'
import { buildTicketCcfConsolidado } from '../lib/ticket/fromSale'
import { enviarCorreoFactura, enviarEstadoCuenta } from '../services/correo.service'
import { formatearFechaHora } from '../utils/fecha'

function money(n: number) { return 'US$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function fechaCorta(iso: string) {
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('es-SV', { day: '2-digit', month: 'short', year: '2-digit' })
}

type Filtro = 'saldo' | 'vencidos' | 'todos'

function Tarjeta({ titulo, valor, detalle, tono }: { titulo: string; valor: string; detalle?: string; tono?: 'tinta' | 'roja' }) {
  return (
    <div className={`cxc-tarjeta${tono ? ` ${tono}` : ''}`}>
      <div className="cxc-tarjeta-titulo">{titulo}</div>
      <div className="cxc-tarjeta-valor">{valor}</div>
      {detalle && <div className="cxc-tarjeta-detalle">{detalle}</div>}
    </div>
  )
}

export function CxcPage() {
  const { hasPermission, currentBranch } = useAuth()
  const puedeAbonar = hasPermission('payments.create')
  const puedeFacturar = hasPermission('fiscal.issue')
  const [params, setParams] = useSearchParams()

  const [clientes, setClientes] = useState<CxcCliente[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<Filtro>('saldo')
  const [buscar, setBuscar] = useState('')
  const elegidoId = params.get('cliente')

  const cargar = useCallback(async () => {
    setCargando(true)
    try { setClientes(await fetchCxcClientes()); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar la cartera') }
    setCargando(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const totales = useMemo(() => {
    const t = { saldo: 0, vencido: 0, porVencer: 0, limite: 0, conSaldo: 0, activos: 0, v1: 0, v2: 0, v3: 0, v4: 0 }
    for (const c of clientes) {
      t.saldo += c.saldo; t.vencido += c.vencido; t.porVencer += c.por_vencer
      if (c.credit_enabled) { t.limite += c.credit_limit; t.activos++ }
      if (c.saldo > 0) t.conSaldo++
      t.v1 += c.vencido_1_30; t.v2 += c.vencido_31_60; t.v3 += c.vencido_61_90; t.v4 += c.vencido_90_mas
    }
    return t
  }, [clientes])

  const lista = useMemo(() => {
    const q = buscar.trim().toLowerCase()
    return clientes
      .filter(c => filtro === 'todos' || (filtro === 'saldo' ? c.saldo > 0 : c.vencido > 0))
      .filter(c => !q || [c.customer_name, c.legal_name, c.nit].some(v => (v ?? '').toLowerCase().includes(q)))
  }, [clientes, filtro, buscar])

  const elegido = clientes.find(c => c.customer_id === elegidoId) ?? null
  const elegir = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('cliente', id); else p.delete('cliente')
    setParams(p, { replace: true })
  }

  const tramos: [string, number][] = [
    ['Por vencer', totales.porVencer], ['1–30', totales.v1], ['31–60', totales.v2], ['61–90', totales.v3], ['+90', totales.v4],
  ]
  const maxTramo = Math.max(1, ...tramos.map(([, v]) => v))
  const usoCartera = totales.limite > 0 ? Math.round((totales.saldo / totales.limite) * 100) : 0

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>Cuentas por cobrar</h1>
          <div className="page-header-sub">
            {totales.activos} clientes con crédito · {totales.conSaldo} con saldo pendiente
          </div>
        </div>
        <button className="btn btn-ghost" onClick={cargar}>Actualizar</button>
      </div>

      {error && <div className="alert-banner danger"><div className="alert-body">{error}</div></div>}

      {/* ── Resumen de la cartera ── */}
      <div className="cxc-tarjetas">
        <Tarjeta tono="tinta" titulo="Total por cobrar" valor={money(totales.saldo)} detalle={`${totales.conSaldo} clientes`}/>
        <Tarjeta tono={totales.vencido > 0 ? 'roja' : undefined} titulo="Vencido" valor={money(totales.vencido)}
                 detalle={totales.saldo > 0 ? `${Math.round((totales.vencido / totales.saldo) * 100)}% de la cartera` : 'Sin saldo'}/>
        <Tarjeta titulo="Por vencer" valor={money(totales.porVencer)} detalle="Dentro del plazo"/>
        <Tarjeta titulo="Crédito otorgado" valor={money(totales.limite)} detalle={`${usoCartera}% utilizado`}/>
      </div>

      <div className="cxc-antiguedad">
        <div className="panel-section-label">Cartera por antigüedad</div>
        <div className="cxc-tramos">
          {tramos.map(([nombre, valor], i) => (
            <div key={nombre} className="cxc-tramo">
              <div className="cxc-tramo-barra">
                <div style={{ height: `${Math.max(valor > 0 ? 6 : 0, (valor / maxTramo) * 100)}%`, background: i === 0 ? 'var(--corsa-green)' : i >= 3 ? 'var(--color-danger-text)' : 'var(--color-warning-text)' }}/>
              </div>
              <div className="cxc-tramo-valor">{money(valor)}</div>
              <div className="cxc-tramo-nombre">{nombre}{i > 0 ? ' días' : ''}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Clientes ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div className="filter-pills">
          {([['saldo', 'Con saldo'], ['vencidos', 'Vencidos'], ['todos', 'Todos con crédito']] as [Filtro, string][]).map(([id, label]) => (
            <button key={id} className={`filter-pill${filtro === id ? ' active' : ''}`} onClick={() => setFiltro(id)}>{label}</button>
          ))}
        </div>
        <div className="search-bar">
          <input type="search" placeholder="Buscar cliente o NIT" value={buscar} onChange={e => setBuscar(e.target.value)} aria-label="Buscar cliente"/>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="corsa-table" style={{ border: 'none', minWidth: 760 }}>
          <thead>
            <tr>
              <th>Cliente</th><th style={{ textAlign: 'right' }}>Límite</th><th style={{ textAlign: 'right' }}>Saldo</th>
              <th style={{ textAlign: 'right' }}>Vencido</th><th style={{ textAlign: 'right' }}>Disponible</th>
              <th>Más antiguo</th><th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {cargando && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24 }}><div className="spinner" style={{ margin: '0 auto' }}/></td></tr>}
            {!cargando && lista.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)' }}>
                {clientes.length === 0 ? 'Todavía no hay clientes con crédito. Se activa desde la ficha del cliente.' : 'Ningún cliente en este filtro.'}
              </td></tr>
            )}
            {lista.map(c => {
              const atraso = c.vencimiento_mas_antiguo ? diasVencido(c.vencimiento_mas_antiguo) : null
              return (
                <tr key={c.customer_id} onClick={() => elegir(c.customer_id)} style={{ cursor: 'pointer' }}
                    className={elegidoId === c.customer_id ? 'selected' : undefined}>
                  <td>
                    <div style={{ fontWeight: 700 }}>{c.customer_name ?? '—'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{c.nit ? `NIT ${c.nit}` : c.legal_name ?? ''}</div>
                  </td>
                  <td className="tnum" style={{ textAlign: 'right' }}>{money(c.credit_limit)}</td>
                  <td className="tnum" style={{ textAlign: 'right', fontWeight: 700 }}>{money(c.saldo)}</td>
                  <td className="tnum" style={{ textAlign: 'right', color: c.vencido > 0 ? 'var(--color-danger-text)' : undefined, fontWeight: c.vencido > 0 ? 700 : 400 }}>{money(c.vencido)}</td>
                  <td className="tnum" style={{ textAlign: 'right' }}>{money(c.disponible)}</td>
                  <td style={{ fontSize: 12.5 }}>
                    {c.vencimiento_mas_antiguo
                      ? <>{fechaCorta(c.vencimiento_mas_antiguo)}{atraso != null && atraso > 0 && <span style={{ color: 'var(--color-danger-text)', fontWeight: 700 }}> · {atraso} d</span>}</>
                      : '—'}
                  </td>
                  <td>
                    {c.blocked ? <span className="badge badge-danger">Bloqueado</span>
                      : !c.credit_enabled ? <span className="badge badge-neutral">Crédito desactivado</span>
                      : c.vencido > 0 ? <span className="badge badge-danger">En mora</span>
                      : <span className="badge badge-success">Al día</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {elegido && (
        <DetalleCxc cliente={elegido} branchId={(currentBranch as any)?.id ?? null} puedeAbonar={puedeAbonar} puedeFacturar={puedeFacturar}
          onCerrar={() => elegir(null)} onCambio={cargar}/>
      )}
    </div>
  )
}

// ─── Detalle de la deuda de un cliente ─────────────────────────

function DetalleCxc({ cliente: c, branchId, puedeAbonar, puedeFacturar, onCerrar, onCambio }: {
  cliente: CxcCliente
  branchId: string | null
  puedeAbonar: boolean
  puedeFacturar: boolean
  onCerrar: () => void
  onCambio: () => void
}) {
  const [documentos, setDocumentos] = useState<DocumentoCxc[]>([])
  const [movimientos, setMovimientos] = useState<MovimientoCredito[]>([])
  const [cargando, setCargando] = useState(true)
  const [abono, setAbono] = useState('')
  const [nota, setNota] = useState('')
  const [guardando, setGuardando] = useState(false)
  // Lavados con facturación consolidada (0060) y cuáles se van a facturar.
  const [lavados, setLavados] = useState<LavadoCredito[]>([])
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
  const [facturando, setFacturando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const [d, m, l] = await Promise.all([
        fetchDocumentosCxc(c.customer_id), fetchMovimientosCredito(c.customer_id),
        fetchLavadosCredito(c.customer_id).catch(() => [] as LavadoCredito[]),
      ])
      setDocumentos(d); setMovimientos(m); setLavados(l)
      setSeleccion(new Set(l.filter(x => !x.consolidated_invoice_id).map(x => x.work_order_id)))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar el detalle')
    }
    setCargando(false)
  }, [c.customer_id])
  useEffect(() => { cargar() }, [cargar])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar])

  const abiertos = documentos.filter(d => d.balance > 0)
  const pendientes = lavados.filter(l => !l.consolidated_invoice_id)
  const elegidos = pendientes.filter(l => seleccion.has(l.work_order_id))
  const totalElegido = Math.round(elegidos.reduce((t, l) => t + l.total, 0) * 100) / 100
  // CCF consolidados ya armados pero sin sello: se reintenta el MISMO.
  const sinSello = Object.values(lavados.reduce((acc, l) => {
    if (l.consolidated_invoice_id && l.dte_status !== 'ACCEPTED' && l.dte_status !== 'INVALIDATED') {
      const g = acc[l.consolidated_invoice_id] ??= { id: l.consolidated_invoice_id, numero: l.ccf_interno ?? '', items: [] as LavadoCredito[] }
      g.items.push(l)
    }
    return acc
  }, {} as Record<string, { id: string; numero: string; items: LavadoCredito[] }>))

  /** Emite (o retoma) el DTE de un CCF consolidado y, sellado, imprime su ticket resumen. */
  const emitirConsolidado = async (invoiceId: string, items: LavadoCredito[]) => {
    const espera = toast.loading('Firmando en la estación fiscal y transmitiendo el CCF a Hacienda…')
    try {
      const r = await emitirConFirmaLocal(invoiceId, { manual: true })
      if (r.estado === 'ACCEPTED') {
        toast.success(`CCF sellado por Hacienda: ${r.numeroControl ?? ''}`, { id: espera, duration: 8000 })
        enviarCorreoFactura(invoiceId).then(x => {
          if (x.ok) toast.success(`CCF enviado por correo a ${x.destinatarios?.join(', ') ?? ''}`)
          else toast.error(`El CCF quedó sellado, pero el correo no salió: ${x.error ?? ''}`, { duration: 10000 })
        })
        try {
          const dte = await fetchDteDeVenta(invoiceId)
          const fechas = items.map(i => i.created_at).sort()
          const emisor = await emisorParaTicket(branchId, true)
          await imprimirTicketEnSegundoPlano(buildTicketCcfConsolidado({
            emisor, cliente: { nombre: c.legal_name || c.customer_name || '', nit: c.nit }, lavados: items.length,
            desde: fechas[0], hasta: fechas[fechas.length - 1],
            total: Math.round(items.reduce((t, i) => t + i.total, 0) * 100) / 100, invoiceId, dte,
          }))
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'El CCF quedó sellado, pero no se pudo imprimir el ticket')
        }
      } else {
        toast.error(`CCF ${r.estado === 'REJECTED' ? 'rechazado' : 'pendiente'}: ${r.mensaje ?? 'revisalo en Contabilidad'}`, { id: espera, duration: 12000 })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo emitir el CCF', { id: espera, duration: 12000 })
    }
    await cargar(); onCambio()
  }

  const facturarPendientes = async () => {
    if (elegidos.length === 0) return
    if (!window.confirm(`Se emitirá UN CCF a ${c.legal_name || c.customer_name} por ${elegidos.length} lavados (${money(totalElegido)}), ` +
                        'con una línea por carro: fecha, placa y servicio. Es un documento tributario real. ¿Continuar?')) return
    setFacturando(true)
    try {
      const r = await crearCcfConsolidado(c.customer_id, elegidos.map(l => l.work_order_id))
      await emitirConsolidado(r.invoice_id, elegidos)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo armar el CCF')
    }
    setFacturando(false)
  }

  const registrar = async () => {
    const monto = Math.round(parseFloat(abono) * 100) / 100
    if (!Number.isFinite(monto) || monto <= 0) { toast.error('Ingresá el monto del abono'); return }
    if (monto > c.saldo + 0.001) { toast.error(`El abono no puede ser mayor que el saldo (${money(c.saldo)})`); return }
    if (!window.confirm(`¿Registrar un abono de ${money(monto)} de ${c.customer_name}? Se aplica a las deudas más antiguas primero.`)) return
    setGuardando(true)
    try {
      await registrarAbono(c.customer_id, monto, nota.trim() || undefined)
      toast.success(`Abono de ${money(monto)} registrado`)
      setAbono(''); setNota('')
      await cargar(); onCambio()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo registrar el abono')
    }
    setGuardando(false)
  }

  const [enviando, setEnviando] = useState(false)
  const enviarEstado = async () => {
    if (!window.confirm(`¿Enviar el estado de cuenta a ${c.customer_name}${c.email ? ` (${c.email})` : ' (no tiene correo: va a CORSA)'}?`)) return
    setEnviando(true)
    const r = await enviarEstadoCuenta(c.customer_id)
    setEnviando(false)
    if (r.ok) toast.success(`Estado de cuenta enviado a ${r.destinatarios?.join(', ') ?? ''}`)
    else toast.error(r.error ?? 'No se pudo enviar', { duration: 10000 })
  }

  const estadoCuenta = async () => {
    try {
      const emisor = await emisorParaTicket(branchId, false)
      imprimirEstadoCuenta(estadoCuentaHTML({ emisor, cliente: c, documentos, movimientos, lavados }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo generar el estado de cuenta')
    }
  }

  const usado = c.credit_limit > 0 ? Math.min(1, c.saldo / c.credit_limit) : 0
  const totalPendiente = pendientes.reduce((t, l) => t + l.total, 0)
  const conSeleccion = puedeFacturar && pendientes.length > 0

  return (
    <div className="ficha-fondo" onClick={e => { if (e.target === e.currentTarget) onCerrar() }}>
      <div className="ficha cxc-det" role="dialog" aria-label={`Cuenta de ${c.customer_name}`}>
        <header className="ficha-cabecera">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="ficha-nombre">{c.customer_name}</div>
              {c.vencido > 0 && <span className="ficha-etiqueta roja">En mora · {money(c.vencido)}</span>}
              {!c.credit_enabled && <span className="ficha-etiqueta">Crédito desactivado</span>}
            </div>
            <div className="cxc-det-sub">
              {[c.legal_name !== c.customer_name ? c.legal_name : null, c.nit ? `NIT ${c.nit}` : null].filter(Boolean).join(' · ')}
              {' · '}Límite <b>{money(c.credit_limit)}</b> · Plazo {c.credit_days} días
            </div>
          </div>
          <div className="cxc-det-acciones">
            <button id="btn-estado-cuenta" className="cxc-btn-mini" onClick={estadoCuenta} disabled={cargando} title="Estado de cuenta en PDF">Estado de cuenta</button>
            <button id="btn-enviar-estado" className="cxc-btn-mini" onClick={enviarEstado} disabled={enviando} title="Enviar el estado de cuenta por correo">{enviando ? 'Enviando…' : 'Enviar'}</button>
            <button className="ficha-cerrar" onClick={onCerrar} aria-label="Cerrar">×</button>
          </div>
        </header>

        <div className="ficha-indicadores">
          <div><div className="cxc-mini">Saldo</div><div className="cxc-mini-valor principal">{money(c.saldo)}</div></div>
          <div><div className="cxc-mini">Vencido</div><div className="cxc-mini-valor" style={{ color: c.vencido > 0 ? 'var(--color-danger-text)' : 'var(--text-secondary)' }}>{money(c.vencido)}</div></div>
          <div><div className="cxc-mini">Por vencer</div><div className="cxc-mini-valor">{money(c.por_vencer)}</div></div>
          <div>
            <div className="cxc-mini">Disponible</div>
            <div className="cxc-mini-valor">{money(c.disponible)}</div>
            {c.credit_limit > 0 && (
              <div className="cxc-det-uso" title={`${Math.round(usado * 100)}% del límite usado`}>
                <div style={{ width: `${usado * 100}%`, background: usado >= 0.9 ? 'var(--color-danger)' : 'var(--corsa-green)' }}/>
              </div>
            )}
          </div>
        </div>

        <div className="ficha-cuerpo" style={{ gridTemplateColumns: puedeAbonar && c.saldo > 0 ? 'minmax(0, 2fr) minmax(220px, 1fr)' : '1fr' }}>
          <div className="ficha-columna">
            <section className="cxc-seccion">
              <div className="cxc-seccion-titulo">Documentos pendientes ({abiertos.length})</div>
              {cargando ? <div className="spinner" style={{ width: 18, height: 18 }}/> : abiertos.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>No debe nada.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="corsa-table cxc-tabla" style={{ border: 'none' }}>
                    <thead><tr><th>Documento</th><th>Fecha</th><th>Vence</th><th style={{ textAlign: 'right' }}>Monto</th><th style={{ textAlign: 'right' }}>Saldo</th><th style={{ textAlign: 'right' }}>Estado</th></tr></thead>
                    <tbody>
                      {abiertos.map(d => {
                        const dias = diasVencido(d.due_date)
                        return (
                          <tr key={d.id}>
                            <td className="font-mono" style={{ fontSize: 12 }}>{d.factura ?? d.orden ?? '—'}</td>
                            <td>{fechaCorta(d.created_at)}</td>
                            <td>{fechaCorta(d.due_date)}</td>
                            <td className="tnum" style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{money(d.amount)}</td>
                            <td className="tnum" style={{ textAlign: 'right', fontWeight: 700 }}>{money(d.balance)}</td>
                            <td style={{ textAlign: 'right' }}>{dias > 0
                              ? <span className="badge badge-danger">Vencido {dias} d</span>
                              : <span className="badge badge-success">{dias === 0 ? 'Vence hoy' : `Vence en ${-dias} d`}</span>}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {lavados.length > 0 && (
              <section className="cxc-seccion">
                <div className="cxc-det-cabeza">
                  <div className="cxc-seccion-titulo">Lavados al crédito</div>
                  <div className="cxc-det-resumen">
                    {lavados.length} lavados · {lavados.length - pendientes.length} facturados
                    {pendientes.length > 0 && <> · <b>{pendientes.length} pendientes ({money(totalPendiente)})</b></>}
                  </div>
                </div>
                {sinSello.map(g => (
                  <div key={g.id} className="alert-banner danger" style={{ marginBottom: 8 }}>
                    <div className="alert-body" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, width: '100%' }}>
                      <span style={{ fontSize: 12.5 }}>El CCF {g.numero} ({g.items.length} lavados) no tiene sello de Hacienda.</span>
                      {puedeFacturar && <button className="btn btn-ghost btn-sm" onClick={() => emitirConsolidado(g.id, g.items)}>Reintentar</button>}
                    </div>
                  </div>
                ))}
                <div style={{ overflowX: 'auto' }}>
                  <table className="corsa-table cxc-tabla" style={{ border: 'none' }}>
                    <thead><tr>
                      {conSeleccion && (
                        <th style={{ width: 24 }}>
                          <input type="checkbox" aria-label="Elegir todos" checked={elegidos.length === pendientes.length}
                                 onChange={e => setSeleccion(e.target.checked ? new Set(pendientes.map(p => p.work_order_id)) : new Set())}/>
                        </th>
                      )}
                      <th>Fecha</th><th>Placa</th><th>Servicio</th><th style={{ textAlign: 'right' }}>Monto</th><th style={{ textAlign: 'right' }}>Factura</th>
                    </tr></thead>
                    <tbody>
                      {lavados.map(l => (
                        <tr key={l.work_order_id}>
                          {conSeleccion && (
                            <td>{!l.consolidated_invoice_id && (
                              <input type="checkbox" checked={seleccion.has(l.work_order_id)} aria-label={`Facturar ${l.order_number}`}
                                     onChange={e => setSeleccion(prev => {
                                       const n = new Set(prev)
                                       if (e.target.checked) n.add(l.work_order_id); else n.delete(l.work_order_id)
                                       return n
                                     })}/>
                            )}</td>
                          )}
                          <td>{fechaCorta(l.created_at)}</td>
                          <td className="font-mono" style={{ fontWeight: 700 }}>{l.placa_principal}</td>
                          <td className="envuelve" style={{ color: 'var(--text-secondary)' }}>{l.detalle ?? '—'}</td>
                          <td className="tnum" style={{ textAlign: 'right', fontWeight: 700 }}>{money(l.total)}</td>
                          <td style={{ textAlign: 'right' }}>
                            {!l.consolidated_invoice_id
                              ? <span className="badge badge-warning">Pendiente</span>
                              : l.dte_status === 'ACCEPTED'
                                ? <span className="badge badge-success" title={`CCF ${l.numero_control ?? ''}\n${l.sello_recepcion ?? ''}`}>Facturado</span>
                                : <span className="badge badge-danger" title={l.ccf_interno ?? ''}>Sin sello</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {conSeleccion && (
                  <div className="cxc-det-pie">
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {elegidos.length} de {pendientes.length} seleccionados · <b style={{ color: 'var(--text-primary)' }}>{money(totalElegido)}</b>
                    </span>
                    <button id="btn-ccf-consolidado" className="btn btn-primary btn-sm" onClick={facturarPendientes}
                            disabled={facturando || elegidos.length === 0}>
                      {facturando ? 'Emitiendo…' : 'Emitir CCF'}
                    </button>
                  </div>
                )}
              </section>
            )}

            <section className="cxc-seccion">
              <div className="cxc-seccion-titulo">Movimientos</div>
              {movimientos.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin movimientos.</div> : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {movimientos.slice(0, 30).map(m => (
                    <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                      <span style={{ width: 118, flexShrink: 0, color: 'var(--text-secondary)' }}>{formatearFechaHora(m.created_at)}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {EVENTO_ETIQUETA[m.event_type] ?? m.event_type}
                        {m.reason && <span style={{ color: 'var(--text-secondary)' }}> · {m.reason}</span>}
                      </span>
                      <span className="tnum" style={{ fontWeight: 700, color: m.event_type === 'PAYMENT' ? 'var(--color-success-text)' : undefined }}>
                        {m.amount != null && (m.event_type === 'PAYMENT' || m.event_type === 'CHARGE_VOID' ? '−' : m.event_type === 'CHARGE' || m.event_type === 'CHARGE_OVERRIDE' ? '+' : '')}
                        {m.amount != null ? money(m.amount) : m.credit_limit != null ? `Límite ${money(m.credit_limit)}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {puedeAbonar && c.saldo > 0 && (
            <div className="ficha-columna">
              <section className="cxc-seccion">
                <div className="cxc-seccion-titulo">Registrar abono</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label className="ficha-campo">
                    <span>Monto (US$)</span>
                    <div className="cxc-det-monto">
                      <input id="abono-monto" className="corsa-input" type="number" min="0.01" step="0.01" value={abono}
                             onChange={e => setAbono(e.target.value)} placeholder={c.saldo.toFixed(2)}/>
                      <button type="button" onClick={() => setAbono(c.saldo.toFixed(2))} title={`Pagar todo (${money(c.saldo)})`}>Todo</button>
                    </div>
                  </label>
                  <label className="ficha-campo">
                    <span>Referencia</span>
                    <input className="corsa-input" value={nota} onChange={e => setNota(e.target.value)} placeholder="Opcional: transferencia #, cheque…"/>
                  </label>
                  <button id="abono-guardar" className="btn btn-primary btn-sm" style={{ justifyContent: 'center' }} onClick={registrar} disabled={guardando}>
                    {guardando ? 'Registrando…' : 'Registrar abono'}
                  </button>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    Se aplica a lo más antiguo primero y libera cupo.
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
