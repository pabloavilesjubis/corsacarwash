/**
 * CORSA Carwash — Cierre del día
 *
 * A dónde lleva tocar el push de cierre: /dashboard/cierre-diario?date=YYYY-MM-DD
 *
 * El push muestra un resumen de tres líneas porque es lo que entra en la
 * pantalla de bloqueo de un teléfono. El detalle entero vive acá.
 *
 * Un día todavía sin cerrar también se puede mirar: muestra los números hasta
 * ahora y POR QUÉ no cerró —qué máquina sigue encendida, si el gateway está
 * reportando—, que es la pregunta que trae a alguien a esta pantalla a las
 * nueve de la noche.
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { hoyLocal, sumarDias, formatearFecha, formatearFechaHora } from '../utils/fecha'
import { duracionLarga, duracionCorta } from '../services/plc.service'
import {
  fetchCierreDiario, fetchEstadoOperativo, cerrarDiaManual,
  type CierreDiario, type EstadoOperativo, type ResumenMaquina,
} from '../services/notifications.service'

const SERVICIOS = ['PRO', 'ELITE', 'SIGNATURE'] as const

const MOTIVOS: Record<string, string> = {
  MAQUINAS_APAGADAS: 'Las dos máquinas quedaron apagadas',
  HORA_TOPE: 'Hora tope sin actividad',
  MANUAL: 'Cerrado a mano',
  SIMULADO: 'Simulación',
}

function TarjetaMaquina({ m, total }: { m: ResumenMaquina; total: number }) {
  const pct = total > 0 ? Math.round((m.lavados / total) * 100) : 0

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 17, letterSpacing: '-0.015em' }}>
          {m.nombre}
        </span>
        <span className="badge badge-neutral">{pct}% del total</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 40, lineHeight: 1,
          letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums',
        }}>
          {m.lavados}
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {m.lavados === 1 ? 'lavado' : 'lavados'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        {SERVICIOS.map(s => (
          <div key={s}>
            <div style={{ fontSize: 11, letterSpacing: '0.04em', color: 'var(--text-secondary)' }}>{s}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 19, fontVariantNumeric: 'tabular-nums' }}>
              {s === 'PRO' ? m.pro : s === 'ELITE' ? m.elite : m.signature}
            </div>
          </div>
        ))}
        {m.unknown > 0 && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-warning-text)' }}>Sin clasificar</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 19, color: 'var(--color-warning-text)' }}>
              {m.unknown}
            </div>
          </div>
        )}
      </div>

      <div style={{
        borderTop: '1px solid var(--border)', paddingTop: 10,
        display: 'flex', gap: 18, flexWrap: 'wrap',
        fontSize: 12.5, color: 'var(--text-secondary)',
      }}>
        <span>Tiempo trabajando <strong style={{ color: 'var(--text-primary)' }}>{duracionLarga(m.busy_seconds)}</strong></span>
        {m.lavados > 0 && (
          <span>Promedio <strong style={{ color: 'var(--text-primary)' }}>
            {duracionCorta(Math.round(m.busy_seconds / m.lavados))}
          </strong></span>
        )}
        {m.primer_lavado && (
          <span>Primero <strong style={{ color: 'var(--text-primary)' }}>
            {formatearFechaHora(m.primer_lavado, { hour: '2-digit', minute: '2-digit' })}
          </strong></span>
        )}
        {m.ultimo_lavado && (
          <span>Último <strong style={{ color: 'var(--text-primary)' }}>
            {formatearFechaHora(m.ultimo_lavado, { hour: '2-digit', minute: '2-digit' })}
          </strong></span>
        )}
        {(m.faulted > 0 || m.interrumpidos > 0) && (
          <span style={{ color: 'var(--color-warning-text)' }}>
            {m.faulted > 0 && `${m.faulted} con falla`}
            {m.faulted > 0 && m.interrumpidos > 0 && ' · '}
            {m.interrumpidos > 0 && `${m.interrumpidos} interrumpidos`}
          </span>
        )}
      </div>
    </div>
  )
}

/** Por qué el día todavía no cerró. Sólo aparece en el día en curso. */
function PorQueNoCerro({ e }: { e: EstadoOperativo }) {
  const encendidas = e.maquinas.filter(m => m.apagada_desde === null)

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="card-header" style={{ marginBottom: 0 }}>
        <span className="card-title">El día todavía no cerró</span>
        <span className={`badge ${e.gateway_online ? 'badge-success' : 'badge-warning'}`}>
          {e.gateway_online ? 'Gateway reportando' : 'Gateway sin reportar'}
        </span>
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {!e.gateway_online ? (
          <>
            El gateway dejó de reportar{e.gateway_ultimo_latido
              ? ` (último latido ${formatearFechaHora(e.gateway_ultimo_latido)})`
              : ''}. Sin él no se sabe si las máquinas están apagadas o si lo que se cayó es la
            red del local, y CORSA no cierra el día por una suposición. Si la operación ya
            terminó, el cierre sale igual pasada la hora tope.
          </>
        ) : encendidas.length > 0 ? (
          <>
            {encendidas.length === 1 ? 'Sigue encendida ' : 'Siguen encendidas '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {encendidas.map(m => m.nombre).join(', ')}
            </strong>. El cierre se genera cuando todas se apaguen y se sostengan apagadas.
          </>
        ) : (
          <>
            Todas las máquinas están apagadas. Falta que se sostengan así durante la ventana de
            confirmación, que existe para que un corte de luz de diez minutos no cierre el día.
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {e.maquinas.map(m => (
          <div key={m.machine_id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 10, padding: '8px 12px', background: 'var(--subtle-bg)', borderRadius: 12,
            fontSize: 13,
          }}>
            <span>{m.nombre}</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>
              {m.apagada_desde === null
                ? `Encendida${m.estado ? ` · ${m.estado}` : ''}`
                : `Apagada hace ${m.minutos_apagada} min`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CierreDiarioPage() {
  const { hasPermission } = useAuth()
  const [params, setParams] = useSearchParams()
  const hoy = hoyLocal()
  const fecha = params.get('date') || hoy

  const [cierre, setCierre] = useState<CierreDiario | null>(null)
  const [estado, setEstado] = useState<EstadoOperativo | null>(null)
  const [cargando, setCargando] = useState(true)
  const [cerrando, setCerrando] = useState(false)

  const puedeVer = hasPermission('plc.read')
  const puedeCerrar = hasPermission('plc.manage')

  const cargar = useCallback(async () => {
    if (!puedeVer) { setCargando(false); return }
    setCargando(true)
    const [c, e] = await Promise.all([
      fetchCierreDiario(fecha),
      fecha === hoy ? fetchEstadoOperativo() : Promise.resolve(null),
    ])
    setCierre(c)
    setEstado(e)
    setCargando(false)
  }, [puedeVer, fecha, hoy])

  useEffect(() => { cargar() }, [cargar])

  const cerrar = async () => {
    setCerrando(true)
    try {
      const r = await cerrarDiaManual(fecha)
      if (r.ok) toast.success('Día cerrado y notificado')
      else toast.error(r.motivo ?? 'No se pudo cerrar')
      await cargar()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cerrar el día')
    }
    setCerrando(false)
  }

  const irA = (f: string) => setParams({ date: f })

  if (!puedeVer) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso al cierre del día</div>
          <div className="empty-state-sub">Pedile acceso a un administrador.</div>
        </div>
      </div>
    )
  }

  if (cargando || !cierre) {
    return <div className="page-inner"><div className="loading-center"><div className="spinner"/></div></div>
  }

  const r = cierre.resumen
  const total = Number(r?.total_lavados ?? 0)
  const maquinas = r?.maquinas ?? []

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>
            Cierre del día
          </h1>
          <div className="page-header-sub">
            {formatearFecha(`${fecha}T12:00:00`, { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            {cierre.cerrado && cierre.cerrado_at && (
              <> · cerrado a las {formatearFechaHora(cierre.cerrado_at, { hour: '2-digit', minute: '2-digit' })}</>
            )}
          </div>
        </div>

        <div className="page-header-actions">
          <button className="btn btn-ghost" onClick={() => irA(sumarDias(fecha, -1))}>← Día anterior</button>
          {fecha < hoy && (
            <button className="btn btn-ghost" onClick={() => irA(sumarDias(fecha, 1))}>Día siguiente →</button>
          )}
          {fecha !== hoy && (
            <button className="btn btn-ghost" onClick={() => irA(hoy)}>Hoy</button>
          )}
        </div>
      </div>

      {/* ── El total del día ── */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Total del día</div>
          <div className="kpi-value">{total}</div>
          <div className="kpi-sub">{total === 1 ? 'lavado' : 'lavados'} · {maquinas.length} {maquinas.length === 1 ? 'máquina' : 'máquinas'}</div>
        </div>
        {SERVICIOS.map(s => {
          const n = s === 'PRO' ? r.total_pro : s === 'ELITE' ? r.total_elite : r.total_signature
          return (
            <div className="kpi-card" key={s}>
              <div className="kpi-label">{s}</div>
              <div className="kpi-value">{Number(n ?? 0)}</div>
              <div className="kpi-sub">
                {total > 0 ? `${Math.round((Number(n ?? 0) / total) * 100)}% del día` : '—'}
              </div>
            </div>
          )
        })}
        <div className="kpi-card">
          <div className="kpi-label">Tiempo trabajando</div>
          <div className="kpi-value" style={{ fontSize: 30 }}>{duracionLarga(r.total_busy_seconds)}</div>
          <div className="kpi-sub">sumando las máquinas</div>
        </div>
      </div>

      {/* ── Cómo se detectó el cierre ── */}
      {cierre.cerrado ? (
        <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 18 }}>🌙</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {MOTIVOS[cierre.motivo ?? ''] ?? cierre.motivo}
            </div>
            {/* La detección en prosa: es la respuesta a «¿por qué cerró a esta
                hora?» sin tener que abrir el SQL Editor. */}
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.6 }}>
              {cierre.deteccion}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
              Generado por {cierre.generado_por === 'SISTEMA' ? 'el sistema' : 'un usuario'}
              {cierre.notification_sent_at && ' · notificación enviada'}
            </div>
          </div>
        </div>
      ) : estado ? (
        <PorQueNoCerro e={estado}/>
      ) : (
        <div className="card" style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Este día no tiene un cierre registrado. Los números de arriba salen de los lavados que
          quedaron guardados; el cierre automático sólo se genera durante el día en curso.
        </div>
      )}

      {/* ── Por máquina ── */}
      {maquinas.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {maquinas.map(m => <TarjetaMaquina key={m.machine_id} m={m} total={total}/>)}
        </div>
      ) : (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-title">Sin lavados registrados este día</div>
            <div className="empty-state-sub">
              Si las máquinas trabajaron, revisá que el gateway haya estado reportando.
            </div>
          </div>
        </div>
      )}

      {puedeCerrar && !cierre.cerrado && total > 0 && (
        <div>
          <button className="btn btn-ghost" onClick={cerrar} disabled={cerrando}>
            Cerrar este día a mano
          </button>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
            Registra el cierre y manda la notificación. Para el día en que la detección
            automática no alcanzó.
          </div>
        </div>
      )}
    </div>
  )
}
