/**
 * CORSA Carwash — Seguros de lluvia
 *
 * Cada fila es una obligación abierta contra el negocio: alguien pagó $2.00 y
 * tiene 48 horas para volver por un lavado PRO sin costo. Por eso la pantalla
 * se ordena por vencimiento y no por fecha de venta — lo que hay que mirar es
 * lo que está por perderse, no lo que se vendió primero.
 *
 * El estado lo decide el servidor (v_rain_policies). Acá no se compara ninguna
 * fecha: si esta pantalla dijera «vencida» por su cuenta, el reloj de la
 * computadora estaría decidiendo si un cliente tiene derecho a su lavado.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { useEsMovil } from '../hooks/useEsMovil'
import { formatearFechaHora } from '../utils/fecha'
import {
  fetchPolicies, redimirPoliza, tiempoRestante,
  ESTADO_ETIQUETA, ESTADO_COLOR,
  type RainPolicy, type EstadoPoliza,
} from '../services/rain.service'

const FILTROS: { id: EstadoPoliza | 'todas'; label: string }[] = [
  { id: 'activa',     label: 'Activos' },
  { id: 'por_vencer', label: 'Por vencer' },
  { id: 'vencida',    label: 'Vencidos' },
  { id: 'canjeada',   label: 'Canjeados' },
  { id: 'todas',      label: 'Todos' },
]

function money(n: number): string {
  return 'US$' + (Number(n) || 0).toFixed(2)
}

function Estado({ estado }: { estado: EstadoPoliza }) {
  const c = ESTADO_COLOR[estado] ?? ESTADO_COLOR.vencida
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, color: c.color, background: c.tint,
      padding: '3px 8px', borderRadius: 4, whiteSpace: 'nowrap',
    }}>
      {ESTADO_ETIQUETA[estado] ?? estado}
    </span>
  )
}

/** Una póliza en el teléfono: placa, quién y cuánto le queda. */
function LineaPoliza({ p, onAbrir }: { p: RainPolicy; onAbrir: () => void }) {
  return (
    <button
      onClick={onAbrir}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '11px 14px', border: 'none',
        borderBottom: '1px solid var(--border)',
        background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-body)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span className="font-mono" style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.5 }}>
          {p.plate}
        </span>
        <Estado estado={p.estado}/>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginTop: 3 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }} className="truncate">
          {p.customer_name}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          {p.estado === 'activa' || p.estado === 'por_vencer'
            ? `quedan ${tiempoRestante(p.horas_restantes)}`
            : formatearFechaHora(p.valid_until, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </button>
  )
}

function Dato({ label, valor }: { label: string; valor: React.ReactNode }) {
  if (valor == null || valor === '' ) return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--text-primary)', textAlign: 'right' }}>{valor}</span>
    </div>
  )
}

/** Detalle y canje. En el teléfono es una hoja; en computadora, el panel lateral. */
function DetallePoliza({ p, esMovil, onCerrar, onCanjear, canjeando }: {
  p: RainPolicy
  esMovil: boolean
  onCerrar: () => void
  onCanjear: () => void
  canjeando: boolean
}) {
  const vigente = p.estado === 'activa' || p.estado === 'por_vencer'

  const cuerpo = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span className="font-mono" style={{ fontSize: 19, fontWeight: 800, letterSpacing: 0.8 }}>{p.plate}</span>
        <Estado estado={p.estado}/>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
        {p.vehicle_label ?? 'Vehículo sin descripción'}
      </div>

      <div style={{ marginTop: 14 }}>
        <Dato label="Cliente" valor={p.customer_name}/>
        <Dato label="Teléfono" valor={p.customer_phone}/>
        <Dato label="Comprado" valor={formatearFechaHora(p.issued_at)}/>
        <Dato label="Vence" valor={<strong>{formatearFechaHora(p.valid_until)}</strong>}/>
        {vigente && <Dato label="Le quedan" valor={tiempoRestante(p.horas_restantes)}/>}
        <Dato label="Precio" valor={money(p.price)}/>
        <Dato label="Orden" valor={p.order_number}/>
        <Dato label="Sucursal" valor={p.branch_name}/>
        {p.redeemed_at && <Dato label="Canjeado" valor={formatearFechaHora(p.redeemed_at)}/>}
        <Dato label="Notas" valor={p.notes}/>
      </div>

      {/* El canje normal se hace en caja, con la venta del lavado gratis. Este
          botón es para el caso en que el lavado ya se hizo y hay que dejar
          constancia: por eso lo dice, en vez de ofrecer dos caminos iguales. */}
      {vigente && (
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
                  onClick={onCanjear} disabled={canjeando}>
            {canjeando ? 'Registrando…' : 'Registrar canje'}
          </button>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.45 }}>
            Usalo sólo si el lavado ya se hizo sin pasar por caja. Lo normal es
            canjearlo desde el POS, que registra la orden del lavado gratis.
          </div>
        </div>
      )}
    </>
  )

  if (!esMovil) {
    return (
      <div className="side-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="panel-section-label">Detalle del seguro</div>
          <button className="panel-close" onClick={onCerrar} aria-label="Cerrar">×</button>
        </div>
        {cuerpo}
      </div>
    )
  }

  return (
    <>
      <div onClick={onCerrar} style={{ position: 'fixed', inset: 0, background: 'rgba(2,20,18,0.5)', zIndex: 60 }}/>
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 61,
        background: 'var(--surface)', borderRadius: '14px 14px 0 0',
        maxHeight: '90dvh', overflowY: 'auto',
        padding: '10px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
        boxShadow: '0 -12px 40px rgba(0,0,0,0.22)',
      }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--border)', margin: '2px auto 12px' }}/>
        {cuerpo}
        <button onClick={onCerrar} className="btn btn-ghost" style={{ width: '100%', marginTop: 10 }}>Cerrar</button>
      </div>
    </>
  )
}

export function SegurosPage() {
  const { hasPermission } = useAuth()
  const esMovil = useEsMovil()
  const puedeVer = hasPermission('rain.read')
  const puedeCanjear = hasPermission('rain.redeem')

  const [polizas, setPolizas] = useState<RainPolicy[]>([])
  const [filtro, setFiltro] = useState<EstadoPoliza | 'todas'>('activa')
  const [buscar, setBuscar] = useState('')
  const [cargando, setCargando] = useState(true)
  const [abierta, setAbierta] = useState<RainPolicy | null>(null)
  const [canjeando, setCanjeando] = useState(false)

  const cargar = useCallback(async () => {
    if (!puedeVer) { setCargando(false); return }
    setCargando(true)
    try {
      setPolizas(await fetchPolicies({ estado: filtro, buscar }))
    } catch {
      toast.error('No se pudieron cargar los seguros')
    }
    setCargando(false)
  }, [puedeVer, filtro, buscar])

  useEffect(() => {
    // La búsqueda espera a que el usuario termine de escribir.
    const t = setTimeout(cargar, buscar ? 300 : 0)
    return () => clearTimeout(t)
  }, [cargar, buscar])

  const resumen = useMemo(() => ({
    activos: polizas.filter(p => p.estado === 'activa').length,
    porVencer: polizas.filter(p => p.estado === 'por_vencer').length,
    canjeados: polizas.filter(p => p.estado === 'canjeada').length,
    vendido: polizas.reduce((n, p) => n + Number(p.price || 0), 0),
  }), [polizas])

  const canjear = async () => {
    if (!abierta) return
    setCanjeando(true)
    try {
      await redimirPoliza(abierta.id)
      toast.success(`Seguro de ${abierta.plate} canjeado`)
      setAbierta(null)
      cargar()
    } catch (e: any) {
      toast.error(e?.message ?? 'No se pudo registrar el canje')
    }
    setCanjeando(false)
  }

  if (!puedeVer) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso a Seguros de lluvia</div>
          <div className="empty-state-sub">Pedile acceso a un administrador.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>Seguros de lluvia</h1>
          <div className="page-header-sub">
            Cobertura de 48 horas · {resumen.activos} activos
            {resumen.porVencer > 0 && (
              <span style={{ color: 'var(--color-warning-text)' }}> · {resumen.porVencer} por vencer</span>
            )}
          </div>
        </div>
      </div>

      <div className="kpi-grid">
        {[
          { label: 'Activos', value: String(resumen.activos) },
          { label: 'Por vencer (12 h)', value: String(resumen.porVencer) },
          { label: 'Canjeados', value: String(resumen.canjeados) },
          { label: 'Vendido en el listado', value: money(resumen.vendido) },
        ].map(k => (
          <div key={k.label} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <div className="filter-pills">
          {FILTROS.map(f => (
            <button key={f.id}
              className={`filter-pill${filtro === f.id ? ' active' : ''}`}
              onClick={() => setFiltro(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <input className="corsa-input" style={{ flex: '1 1 220px', minWidth: esMovil ? 0 : 200 }}
               placeholder="Placa o cliente…" value={buscar}
               onChange={e => setBuscar(e.target.value)}/>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <div style={{
          flex: '2 1 560px', minWidth: esMovil ? 0 : 480,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', overflow: 'hidden',
        }}>
          {cargando ? (
            <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
          ) : polizas.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">Sin seguros en este filtro</div>
              <div className="empty-state-sub">
                El seguro se vende en caja, marcándolo como servicio adicional.
              </div>
            </div>
          ) : esMovil ? (
            polizas.map(p => <LineaPoliza key={p.id} p={p} onAbrir={() => setAbierta(p)}/>)
          ) : (
            <div className="table-wrap">
              <table className="corsa-table">
                <thead>
                  <tr>
                    <th>Placa</th><th>Cliente</th><th>Vehículo</th>
                    <th>Comprado</th><th>Vence</th><th>Restante</th>
                    <th>Estado</th><th style={{ textAlign: 'right' }}>Precio</th>
                  </tr>
                </thead>
                <tbody>
                  {polizas.map(p => (
                    <tr key={p.id}
                        className={abierta?.id === p.id ? 'selected' : ''}
                        onClick={() => setAbierta(p)}>
                      <td className="font-mono" style={{ fontWeight: 700 }}>{p.plate}</td>
                      <td className="truncate" style={{ fontSize: 13 }}>{p.customer_name}</td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{p.vehicle_label ?? '—'}</td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {formatearFechaHora(p.issued_at, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                        {formatearFechaHora(p.valid_until, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td style={{ fontSize: 12.5, fontWeight: 600 }}>
                        {p.estado === 'activa' || p.estado === 'por_vencer' ? tiempoRestante(p.horas_restantes) : '—'}
                      </td>
                      <td><Estado estado={p.estado}/></td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(p.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!esMovil && abierta && (
          <DetallePoliza
            p={abierta} esMovil={false}
            onCerrar={() => setAbierta(null)}
            onCanjear={canjear}
            canjeando={canjeando || !puedeCanjear}
          />
        )}
      </div>

      {esMovil && abierta && (
        <DetallePoliza
          p={abierta} esMovil
          onCerrar={() => setAbierta(null)}
          onCanjear={canjear}
          canjeando={canjeando || !puedeCanjear}
        />
      )}
    </div>
  )
}
