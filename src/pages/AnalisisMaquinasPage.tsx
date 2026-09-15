/**
 * CORSA Carwash — Análisis de máquinas
 *
 * Cuánto trabajó cada máquina: lavados, qué servicios corrió y cuánto tiempo
 * estuvo efectivamente lavando, día por día.
 *
 * Por qué el rango arranca en el mes: la pregunta que trae a alguien a esta
 * pantalla casi nunca es «¿cuánto llevamos hoy?» —eso está en el resumen del
 * día— sino «¿cómo viene el mes y cómo se reparte entre las dos máquinas?».
 * Los filtros más cortos existen para bajar desde ahí, no para empezar.
 *
 * Todo sale de v_plc_production_daily, la misma vista que alimenta al tablero.
 * Contar acá por cuenta propia habría dado dos respuestas distintas para el
 * mismo día sin forma de saber cuál es la buena.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useEsMovil } from '../hooks/useEsMovil'
import { hoyLocal, sumarDias, formatearFecha } from '../utils/fecha'
import {
  fetchProduccionDiaria, fetchMaquinas, duracionCorta, duracionLarga,
  type ProduccionDiaria, type MaquinaPlc,
} from '../services/plc.service'

const SERVICIOS = ['PRO', 'ELITE', 'SIGNATURE'] as const

type PresetId = 'hoy' | 'ayer' | 'semana' | 'mes' | 'personalizado'

const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'hoy',           label: 'Hoy' },
  { id: 'ayer',          label: 'Ayer' },
  { id: 'semana',        label: 'Esta semana' },
  { id: 'mes',           label: 'Este mes' },
  { id: 'personalizado', label: 'Selección especial' },
]

/**
 * El rango de cada preset, en días del carwash.
 *
 * «Esta semana» corre de lunes a hoy y no siete días hacia atrás: quien compara
 * turnos piensa en la semana que está corriendo, no en una ventana móvil.
 */
function rangoDe(preset: PresetId, hoy: string): { desde: string; hasta: string } {
  const [a, m, d] = hoy.split('-').map(Number)
  switch (preset) {
    case 'hoy':
      return { desde: hoy, hasta: hoy }
    case 'ayer': {
      const ayer = sumarDias(hoy, -1)
      return { desde: ayer, hasta: ayer }
    }
    case 'semana': {
      // getUTCDay sobre una fecha construida en UTC: sin hora local de por
      // medio, el día de la semana no se corre según dónde esté el navegador.
      const dow = new Date(Date.UTC(a, m - 1, d)).getUTCDay()
      const desdeLunes = dow === 0 ? 6 : dow - 1
      return { desde: sumarDias(hoy, -desdeLunes), hasta: hoy }
    }
    default:
      return { desde: `${a}-${String(m).padStart(2, '0')}-01`, hasta: hoy }
  }
}

function nombreDeMaquina(id: string, maquinas: MaquinaPlc[]): string {
  const m = maquinas.find(x => x.machine_id === id)
  if (m?.name && m.name !== m.machine_id) return m.name
  const n = id.match(/(\d+)\s*$/)
  return n ? `Máquina ${n[1]}` : id
}

interface Totales {
  washes: number
  pro: number
  elite: number
  signature: number
  unknown: number
  faulted: number
  interrupted: number
  busy: number
  dias: number
}

function acumular(filas: ProduccionDiaria[]): Totales {
  return filas.reduce<Totales>((t, f) => ({
    washes: t.washes + Number(f.washes || 0),
    pro: t.pro + Number(f.pro || 0),
    elite: t.elite + Number(f.elite || 0),
    signature: t.signature + Number(f.signature || 0),
    unknown: t.unknown + Number(f.unknown || 0),
    faulted: t.faulted + Number(f.faulted || 0),
    interrupted: t.interrupted + Number(f.interrupted || 0),
    busy: t.busy + Number(f.busy_seconds || 0),
    dias: t.dias + (Number(f.washes || 0) > 0 ? 1 : 0),
  }), { washes: 0, pro: 0, elite: 0, signature: 0, unknown: 0, faulted: 0, interrupted: 0, busy: 0, dias: 0 })
}

// ─── Tarjeta por máquina ──────────────────────────────────────

function TarjetaMaquina({ nombre, t, total }: { nombre: string; t: Totales; total: number }) {
  const pct = total > 0 ? Math.round((t.washes / total) * 100) : 0

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 17, letterSpacing: '-0.015em' }}>
          {nombre}
        </span>
        {/* Cuánto del trabajo del rango pasó por esta máquina. Con dos
            máquinas, un reparto muy despareja es la señal a mirar. */}
        <span className="badge badge-neutral">{pct}% del total</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 40, lineHeight: 1, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
          {t.washes}
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {t.washes === 1 ? 'servicio' : 'servicios'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {SERVICIOS.map(s => {
          const n = s === 'PRO' ? t.pro : s === 'ELITE' ? t.elite : t.signature
          return (
            <div key={s}>
              <div style={{ fontSize: 11, letterSpacing: '0.04em', color: 'var(--text-secondary)' }}>{s}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 19, fontVariantNumeric: 'tabular-nums' }}>{n}</div>
            </div>
          )
        })}
        {t.unknown > 0 && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-warning-text)' }}>Sin clasificar</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 19, color: 'var(--color-warning-text)' }}>{t.unknown}</div>
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-secondary)' }}>
        <span>Operación <strong style={{ color: 'var(--text-primary)' }}>{duracionLarga(t.busy)}</strong></span>
        <span>
          Promedio{' '}
          <strong style={{ color: 'var(--text-primary)' }}>
            {duracionCorta(t.washes > 0 ? Math.round(t.busy / t.washes) : 0)}
          </strong>
        </span>
        {t.dias > 0 && (
          <span>
            Por día <strong style={{ color: 'var(--text-primary)' }}>{(t.washes / t.dias).toFixed(1)}</strong>
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Pantalla ─────────────────────────────────────────────────

export function AnalisisMaquinasPage() {
  const { hasPermission } = useAuth()
  const esMovil = useEsMovil()
  const puedeVer = hasPermission('plc.read')

  const hoy = hoyLocal()
  const [preset, setPreset] = useState<PresetId>('mes')
  const [desde, setDesde] = useState(rangoDe('mes', hoy).desde)
  const [hasta, setHasta] = useState(hoy)
  const [filas, setFilas] = useState<ProduccionDiaria[]>([])
  const [maquinas, setMaquinas] = useState<MaquinaPlc[]>([])
  const [cargando, setCargando] = useState(true)

  // Cambiar de preset mueve el rango; en «selección especial» lo mueve la
  // persona y el preset no lo vuelve a tocar.
  const elegirPreset = (p: PresetId) => {
    setPreset(p)
    if (p === 'personalizado') return
    const r = rangoDe(p, hoy)
    setDesde(r.desde)
    setHasta(r.hasta)
  }

  const cargar = useCallback(async () => {
    if (!puedeVer) { setCargando(false); return }
    setCargando(true)
    const [prod, maqs] = await Promise.all([
      fetchProduccionDiaria(desde, hasta),
      fetchMaquinas(),
    ])
    setFilas(prod)
    setMaquinas(maqs)
    setCargando(false)
  }, [puedeVer, desde, hasta])

  useEffect(() => { cargar() }, [cargar])

  /** Las máquinas que aparecen: las activas, más cualquiera con datos en el rango. */
  const codigos = useMemo(() => {
    const set = new Set<string>(maquinas.map(m => m.machine_id))
    for (const f of filas) set.add(f.machine_id)
    return [...set].sort()
  }, [maquinas, filas])

  const porMaquina = useMemo(() => {
    const mapa = new Map<string, Totales>()
    for (const c of codigos) mapa.set(c, acumular(filas.filter(f => f.machine_id === c)))
    return mapa
  }, [codigos, filas])

  const total = useMemo(() => acumular(filas), [filas])

  /** Los días del rango con actividad, del más reciente al más viejo. */
  const dias = useMemo(() => {
    const set = new Set(filas.map(f => f.day))
    return [...set].sort().reverse()
  }, [filas])

  const celda = (dia: string, maquina: string) =>
    filas.find(f => f.day === dia && f.machine_id === maquina)

  if (!puedeVer) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso al análisis de máquinas</div>
          <div className="empty-state-sub">Pedile acceso a un administrador.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>
            Análisis de máquinas
          </h1>
          <div className="page-header-sub">
            {formatearFecha(`${desde}T12:00:00`)} — {formatearFecha(`${hasta}T12:00:00`)} ·{' '}
            {total.washes} {total.washes === 1 ? 'servicio' : 'servicios'}
          </div>
        </div>
      </div>

      {/* ── Filtros ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <div className="filter-pills">
          {PRESETS.map(p => (
            <button key={p.id}
              className={`filter-pill${preset === p.id ? ' active' : ''}`}
              onClick={() => elegirPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>

        {/* Las fechas sólo aparecen con la selección especial: con un preset
            activo mostrarían valores que el usuario no eligió y que se le van
            a mover solos al cambiar de pestaña. */}
        {preset === 'personalizado' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: esMovil ? '1 1 100%' : undefined }}>
            <input type="date" className="corsa-input" aria-label="Desde"
                   style={{ width: esMovil ? 0 : 160, flex: esMovil ? '1 1 0' : undefined }}
                   value={desde} max={hasta} onChange={e => setDesde(e.target.value)}/>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>a</span>
            <input type="date" className="corsa-input" aria-label="Hasta"
                   style={{ width: esMovil ? 0 : 160, flex: esMovil ? '1 1 0' : undefined }}
                   value={hasta} min={desde} max={hoy} onChange={e => setHasta(e.target.value)}/>
          </div>
        )}
      </div>

      {/* ── Una tarjeta por máquina ── */}
      <div style={{ display: 'grid', gridTemplateColumns: esMovil ? '1fr' : 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        {codigos.map(c => (
          <TarjetaMaquina
            key={c}
            nombre={nombreDeMaquina(c, maquinas)}
            t={porMaquina.get(c) ?? acumular([])}
            total={total.washes}
          />
        ))}
      </div>

      {/* ── Detalle día por día ── */}
      <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {cargando ? (
          <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
        ) : dias.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">Sin lavados en este rango</div>
            <div className="empty-state-sub">Probá con otro período.</div>
          </div>
        ) : esMovil ? (
          /* En el teléfono cada día es una tarjeta con sus máquinas adentro:
             una tabla de nueve columnas por máquina no entra de ninguna forma. */
          dias.map(dia => (
            <div key={dia} style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                {formatearFecha(`${dia}T12:00:00`, { weekday: 'short', day: '2-digit', month: 'short' })}
              </div>
              {codigos.map(c => {
                const f = celda(dia, c)
                if (!f || !Number(f.washes)) return null
                return (
                  <div key={c} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 12.5 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{nombreDeMaquina(c, maquinas)}</span>
                    <span style={{ textAlign: 'right' }}>
                      <strong>{f.washes}</strong>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {' '}· {f.pro}/{f.elite}/{f.signature} · {duracionLarga(f.busy_seconds)}
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>
          ))
        ) : (
          <div className="table-wrap">
            <table className="corsa-table">
              <thead>
                <tr>
                  <th>Día</th>
                  <th>Máquina</th>
                  <th style={{ textAlign: 'right' }}>Lavados</th>
                  <th style={{ textAlign: 'right' }}>PRO</th>
                  <th style={{ textAlign: 'right' }}>ELITE</th>
                  <th style={{ textAlign: 'right' }}>SIGNATURE</th>
                  <th style={{ textAlign: 'right' }}>Sin clasificar</th>
                  <th style={{ textAlign: 'right' }}>Tiempo de operación</th>
                  <th style={{ textAlign: 'right' }}>Promedio</th>
                  <th style={{ textAlign: 'right' }}>Interrumpidos</th>
                </tr>
              </thead>
              <tbody>
                {dias.map(dia => codigos.map((c, i) => {
                  const f = celda(dia, c)
                  if (!f) return null
                  return (
                    <tr key={`${dia}-${c}`} style={{ cursor: 'default' }}>
                      {/* El día se escribe una sola vez por bloque: repetirlo en
                          cada máquina obliga a leer la fecha para saber si la
                          fila cambió de día. */}
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {i === 0 ? formatearFecha(`${dia}T12:00:00`, { weekday: 'short', day: '2-digit', month: 'short' }) : ''}
                      </td>
                      <td style={{ fontSize: 13 }}>{nombreDeMaquina(c, maquinas)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{f.washes}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.pro}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.elite}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.signature}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: f.unknown > 0 ? 'var(--color-warning-text)' : 'var(--text-secondary)' }}>
                        {f.unknown || '—'}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{duracionLarga(f.busy_seconds)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{duracionCorta(f.avg_seconds)}</td>
                      <td style={{ textAlign: 'right', color: f.interrupted > 0 ? 'var(--color-warning-text)' : 'var(--text-secondary)' }}>
                        {f.interrupted || '—'}
                      </td>
                    </tr>
                  )
                }))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)' }}>
                  <td colSpan={2} style={{ fontWeight: 700 }}>Total del período</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{total.washes}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{total.pro}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{total.elite}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{total.signature}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{total.unknown || '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{duracionLarga(total.busy)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                    {duracionCorta(total.washes > 0 ? Math.round(total.busy / total.washes) : 0)}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{total.interrupted || '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
