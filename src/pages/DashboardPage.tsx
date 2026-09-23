/**
 * CORSA Carwash — Dashboard del día
 * KPIs por tipo de servicio · Mapa de calor · Últimos 7 días
 */

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { useTheme } from '../contexts/ThemeContext'
import { formatearFecha, hoyLocal, inicioDelDiaISO, sumarDias } from '../utils/fecha'

// ─── Types ────────────────────────────────────────────────────

interface ServiceKPI {
  service_id: string
  service_name: string
  category?: string
  count: number
  revenue: number
  pct: number          // % del total de órdenes
  avg_ticket: number
}

interface DailySummary {
  sale_date: string
  label: string
  total_orders: number
  gross_revenue: number
  pct: number
  is_today: boolean
}

interface HourCell {
  hour: string
  intensity: number    // 0–1
  count: number
}

interface KPIs {
  gross_revenue: number
  total_orders: number
  completed_orders: number
  avg_ticket: number
  cancelled_orders: number
  total_discounts: number
}

// ─── Constants ────────────────────────────────────────────────

const DIAS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
// Franja mínima que siempre se dibuja, aunque no haya trabajo: si el mapa se
// encogiera a las horas con lavados, dos días flojos lo dejarían de tres
// columnas y no se podría comparar contra la semana pasada.
const HORA_DESDE = 7
const HORA_HASTA = 19

/** 13 → «1p». Los rótulos sólo se ven en el tooltip de cada celda. */
function etiquetaHora(h: number): string {
  if (h === 0) return '12a'
  if (h === 12) return '12p'
  return h < 12 ? `${h}a` : `${h - 12}p`
}

// Service category colors
const CAT_COLORS: Record<number, { color: string; tint: string; bar: string }> = {
  0: { color: 'var(--corsa-green)', tint: 'var(--color-success-tint)', bar: 'var(--corsa-green)' },
  1: { color: 'var(--color-success-text)', tint: 'var(--color-success-tint)', bar: 'var(--color-success)' },
  2: { color: 'var(--corsa-orange)', tint: 'rgba(223,245,107,0.35)', bar: 'var(--corsa-orange)' },
  3: { color: 'var(--color-warning-text)', tint: 'var(--color-warning-tint)', bar: '#F0A93A' },
  4: { color: 'var(--color-danger-text)', tint: 'var(--color-danger-tint)', bar: 'var(--color-danger)' },
}

// ─── Helpers ──────────────────────────────────────────────────

function fmt(n: number) {
  return 'US$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtShort(n: number) {
  if (n >= 1000) return 'US$' + (n / 1000).toFixed(1) + 'k'
  return 'US$' + n.toFixed(0)
}

function heatColor(intensity: number): string {
  // De un velo casi imperceptible al color pleno. Una sola tonalidad y no un
  // degradado de colores: lo que se compara es cuánto, no qué. El tono sale
  // del tema (--heat-rgb), porque la tinta que funciona en claro desaparece
  // sobre el fondo oscuro.
  const alpha = 0.06 + intensity * 0.86
  return `rgb(var(--heat-rgb) / ${alpha.toFixed(2)})`
}

/**
 * Mapa de calor de uso de las máquinas, por día y hora.
 *
 * Cuenta LAVADOS, no ventas. No es lo mismo: un lavado de flotilla se factura
 * a fin de mes, un canje de cupón no genera cobro, y una venta se registra
 * cuando el cajero llega a marcarla, a veces media hora después de que el
 * carro entró. Para decidir turnos y mantenimiento lo que importa es cuándo
 * corrió la máquina, y eso lo sabe el PLC al segundo (v_plc_heatmap, 0041).
 *
 * Muestra una VENTANA RODANTE de siete días que termina hoy. Cada día se
 * limpia a su medianoche y se va llenando hora por hora; los otros seis siguen
 * mostrando su última vez hasta que les toque. Antes agregaba sin ventana de
 * tiempo y la fila «Lunes» era la suma de todos los lunes de la historia.
 *
 * Sin lavados registrados la grilla queda vacía: no se dibuja un patrón
 * plausible, que es lo que hacía la primera versión con pesos inventados.
 */
/**
 * Qué tinta lleva el número dentro de una celda del mapa de calor.
 *
 * La celda va de casi transparente a color pleno, así que una sola tinta se
 * pierde en uno de los dos extremos. Y el punto donde hay que cambiar NO es
 * el mismo en los dos temas: en claro la celda intensa es tinta oscura, en
 * oscuro es lima brillante. O sea que la inversión va al revés.
 *
 * Los dos umbrales salen de calcular el contraste WCAG a lo largo de toda la
 * escala y quedarse con el corte que deja mejor el peor punto: 4.66 en claro
 * y 4.64 en oscuro, los dos sobre el mínimo de 4.5. Con tintas «casi» blanco
 * y «casi» negro en vez de puras, el peor punto caía a 3.97 — de ahí que acá
 * vayan puras y no los grises del tema.
 */
/** Las flechas para moverse de semana en el mapa de calor. */
const flechaSemana: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text-primary)', fontSize: 15, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', fontFamily: 'var(--font-body)',
}

function heatInk(intensidad: number, esOscuro: boolean): string {
  const corte = esOscuro ? 0.42 : 0.62
  const intensa = intensidad > corte
  if (esOscuro) return intensa ? '#000000' : '#FFFFFF'
  return intensa ? '#FFFFFF' : '#000000'
}

/**
 * Las siete fechas de la ventana, de la más vieja a hoy.
 *
 * Es una ventana RODANTE, no la semana del calendario. Hoy se limpia a la
 * medianoche y se va llenando hora por hora; los otros seis días siguen
 * mostrando su última vez hasta que les toque. Así la grilla nunca tiene
 * huecos y cada día se renueva solo cuando llega.
 *
 * Con la semana calendario —lunes a domingo— los días que todavía no habían
 * llegado salían vacíos, y un miércoles se veía media grilla en blanco.
 */
function ventanaDeSieteDias(hasta: string): string[] {
  return Array.from({ length: 7 }, (_, i) => sumarDias(hasta, i - 6))
}

/** «Jue 17». El número va porque en una ventana rodante «Jue» es ambiguo. */
function etiquetaDeDia(fecha: string, esHoy: boolean): string {
  const [, mes, dia] = fecha.split('-').map(Number)
  const d = new Date(Date.UTC(Number(fecha.slice(0, 4)), (mes as number) - 1, dia))
  const nombre = DIAS_ES[d.getUTCDay()]
  return esHoy ? `${nombre}\u00a0${dia}\u00a0·\u00a0hoy` : `${nombre}\u00a0${dia}`
}

/**
 * Arma la grilla a partir de las filas de la vista y de las fechas de la
 * ventana.
 *
 * Las filas se indexan por FECHA y no por día de la semana. Con día de la
 * semana, dos lunes distintos caían en la misma celda y se sumaban — que es
 * exactamente el bug que tenía el mapa: la fila «Lun» era todos los lunes de
 * la historia apilados.
 */
function buildHeatmapFrom(rows: any[], fechas: string[], hoy: string): { label: string; cells: HourCell[] }[] {
  // La vista trae UNA FILA POR MÁQUINA para cada día y hora, así que hay que
  // sumarlas. Antes acá se hacía rows.find(), que devuelve la primera: con dos
  // máquinas lavando a la misma hora, la segunda desaparecía sin dejar rastro
  // y el mapa mostraba menos trabajo del que hubo.
  const porCelda = new Map<string, number>()
  for (const r of rows) {
    const fecha = String(r.wash_date ?? '')
    const hora = Number(r.hour_of_day)
    if (!fecha || !Number.isFinite(hora)) continue
    const clave = `${fecha}:${hora}`
    porCelda.set(clave, (porCelda.get(clave) ?? 0) + (Number(r.washes) || 0))
  }

  // El máximo sale de los totales ya sumados, no de las filas sueltas. Con el
  // máximo por máquina, una celda con las dos máquinas trabajando podía pasar
  // del tope y saturar la escala de color.
  const max = Math.max(1, ...porCelda.values())

  // La franja sigue a los datos en lugar de estar fija de 7 a 19. Con horario
  // fijo, un lavado de las 6 de la mañana o de las 8 de la noche simplemente
  // no aparecía.
  const horas = rows.map(r => Number(r.hour_of_day)).filter(h => Number.isFinite(h))
  const desde = horas.length ? Math.min(HORA_DESDE, ...horas) : HORA_DESDE
  const hasta = horas.length ? Math.max(HORA_HASTA, ...horas) : HORA_HASTA

  return fechas.map(fecha => ({
    label: etiquetaDeDia(fecha, fecha === hoy),
    cells: Array.from({ length: hasta - desde + 1 }, (_, hi) => {
      const hora = desde + hi
      const count = porCelda.get(`${fecha}:${hora}`) ?? 0
      return { hour: etiquetaHora(hora), count, intensity: count / max }
    }),
  }))
}

/** Cómo se muestra cada estado que reporta el PLC. */
/**
 * Cómo se muestra cada estado que reporta el PLC.
 *
 * Fondo sólido y no un tinte suave: esto se mira de lejos, cruzando el local,
 * y con frecuencia de reojo. Las etiquetas son cortas por lo mismo — a este
 * tamaño, «Fuera de línea» parte en dos renglones y deja de leerse de un
 * golpe.
 */
const MACHINE_STATES: Record<string, { label: string; bg: string; fg: string }> = {
  // LAVANDO va en lima: es el único estado que dice «está pasando algo ahora»
  // y tiene que saltar sobre los demás. Encima del lima el texto va en tinta,
  // porque blanco sobre lima no se lee ni de cerca.
  WASHING:   { label: 'LAVANDO',  bg: 'var(--corsa-orange)', fg: 'var(--on-accent)' },
  READY:     { label: 'STANDBY',  bg: 'var(--corsa-green)',  fg: 'var(--on-primary)' },
  ONLINE:    { label: 'STANDBY',  bg: 'var(--corsa-green)',  fg: 'var(--on-primary)' },
  NOT_READY: { label: 'NO LISTA', bg: '#8A6414', fg: '#fff' },
  FAULT:     { label: 'FALLA',    bg: '#B03A33', fg: '#fff' },
  OFFLINE:   { label: 'OFFLINE',  bg: '#5F6368', fg: '#fff' },
}

/**
 * `machine-1` se lee mal en una tarjeta. Si alguien le puso nombre en
 * plc_machines, ese manda; si no, se arma uno legible a partir del código.
 */
function nombreDeMaquina(m: { name: string; machine_id: string }): string {
  if (m.name && m.name !== m.machine_id) return m.name
  const n = m.machine_id.match(/(\d+)\s*$/)
  return n ? `Máquina ${n[1]}` : m.machine_id
}

/**
 * Los tres servicios de CORSA, en orden de duración.
 *
 * El PLC no informa cuál corrió: la nube lo deduce de cuánto duró el ciclo,
 * contra los límites configurados por máquina (0038). UNKNOWN es un lavado
 * real cuya duración cae fuera de todo rango razonable — no es un servicio
 * más, es una señal de que hay algo que mirar.
 */
const SERVICIOS = ['PRO', 'ELITE', 'SIGNATURE'] as const

interface MachineCard {
  machine_id: string
  name: string
  status: string | null
  washes_today: number
  pro_today: number
  elite_today: number
  signature_today: number
  unknown_today: number
  avg_seconds_today: number | null
  /** Ciclos de hoy que corrieron pero no llegaron a ser un lavado. */
  interrupted_today: number
  washes_in_progress: number
  reporting: boolean
  current_service: string | null
}

/** 341 s se lee peor que 5:41 cuando lo que importa es comparar ciclos. */
function duracion(segundos: number | null | undefined): string {
  if (!segundos) return '—'
  const m = Math.floor(segundos / 60)
  return `${m}:${String(segundos % 60).padStart(2, '0')}`
}

// ─── Sub-components ──────────────────────────────────────────

function KpiCard({ label, value, sub, trend, primary }: {
  label: string; value: string; sub?: string; trend?: { val: string; up: boolean } | null; primary?: boolean
}) {
  if (primary) return (
    <div style={{
      position: 'relative',
      background: 'var(--corsa-green)',
      color: 'var(--on-primary)',
      borderRadius: 'var(--radius)',
      padding: 20,
      overflow: 'hidden',
    }}>
      {/* Un punto de acento en lugar de la esquina recortada: con radios
          grandes, un corte en diagonal se lee como un error de render. */}
      <div style={{ position: 'absolute', top: 16, right: 16, width: 10, height: 10, borderRadius: '50%', background: 'var(--corsa-orange)' }}/>
      <div style={{ fontSize: 13.5, opacity: 0.72 }}>{label}</div>
      <div style={{ marginTop: 8, fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 36, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {trend && (
        <div style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, color: trend.up ? 'var(--corsa-orange)' : 'var(--color-danger-tint)' }}>
          <span>{trend.up ? '▲' : '▼'}</span><span>{trend.val}</span>
        </div>
      )}
      {sub && !trend && <div style={{ marginTop: 8, fontSize: 13, opacity: 0.6 }}>{sub}</div>}
    </div>
  )

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ marginTop: 8, fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 32, fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', lineHeight: 1.1 }}>{value}</div>
      {trend && (
        <div style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: trend.up ? 'var(--color-success-text)' : 'var(--color-danger-text)', background: trend.up ? 'var(--color-success-tint)' : 'var(--color-danger-tint)', padding: '3px 8px', borderRadius: 4 }}>
          {trend.up ? '▲' : '▼'} {trend.val}
        </div>
      )}
      {sub && !trend && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)' }}>{sub}</div>}
    </div>
  )
}

/**
 * Estado de una máquina de lavado, leído del PLC.
 *
 * El número grande son los lavados de hoy. El resto de la tarjeta existe para
 * que ese número se pueda interpretar: un cero puede significar «no se lavó
 * nada» o «hace media hora que no sabemos nada de esa máquina», y son cosas
 * muy distintas para quien está a cargo del turno.
 */
function MachineCard({ m }: { m: MachineCard }) {
  const estado = MACHINE_STATES[m.status ?? '']
    ?? { label: (m.status ?? 'SIN DATOS').toUpperCase(), bg: '#5F6368', fg: '#fff' }

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderLeft: `4px solid ${m.reporting ? estado.bg : 'var(--border)'}`,
      borderRadius: 12,
      padding: 20,
      opacity: m.reporting ? 1 : 0.75,
    }}>
      <div style={{
        fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15,
        color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {nombreDeMaquina(m)}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{m.machine_id}</div>

      {/* El estado y el conteo compiten por la mirada, así que van en la misma
          línea y al mismo peso: uno dice qué está pasando ahora y el otro
          cuánto se lleva hecho. */}
      <div style={{
        marginTop: 18, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{
            fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 44, lineHeight: 1,
            color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
          }}>
            {m.washes_today}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {m.washes_today === 1 ? 'lavado hoy' : 'lavados hoy'}
          </div>
        </div>

        <span style={{
          background: estado.bg,
          color: estado.fg,
          fontFamily: 'var(--font-heading)',
          fontWeight: 800,
          fontSize: 26,
          letterSpacing: 0.5,
          lineHeight: 1,
          padding: '12px 22px',
          borderRadius: 12,
          whiteSpace: 'nowrap',
        }}>
          {estado.label}
        </span>
      </div>

      {/* De qué fueron esos lavados. Es lo único que dice si el día estuvo
          cargado de SIGNATURE o de lavados PRO, que para el mismo número de
          carros es una diferencia de plata y de tiempo de máquina. */}
      {m.washes_today > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
          {SERVICIOS.map(s => {
            const n = s === 'PRO' ? m.pro_today : s === 'ELITE' ? m.elite_today : m.signature_today
            return (
              <div key={s} style={{ color: n > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{n}</strong>{' '}
                <span style={{ fontSize: 11.5, letterSpacing: 0.3 }}>{s}</span>
              </div>
            )
          })}
          {m.unknown_today > 0 && (
            <div style={{ color: 'var(--color-warning-text, #9A6510)' }}>
              <strong>{m.unknown_today}</strong> <span style={{ fontSize: 11.5 }}>sin clasificar</span>
            </div>
          )}
          {!!m.avg_seconds_today && (
            <div style={{ color: 'var(--text-secondary)', marginLeft: 'auto' }}>
              promedio {duracion(m.avg_seconds_today)}
            </div>
          )}
        </div>
      )}

      {m.current_service && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Servicio en curso: <strong style={{ color: 'var(--text-primary)' }}>{m.current_service}</strong>
        </div>
      )}

      {/* Un ciclo interrumpido no es un lavado y no se cobra, pero sí ocupó la
          máquina. Si son muchos, el problema está en la máquina, no en el conteo. */}
      {m.interrupted_today > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
          {m.interrupted_today === 1 ? '1 ciclo interrumpido' : `${m.interrupted_today} ciclos interrumpidos`}
        </div>
      )}

      {/* Un cero sin explicación se lee como «no trabajó». Si además hace rato
          que no llega un latido, eso hay que decirlo: puede que sí trabajara y
          no nos estemos enterando. */}
      {!m.reporting && (
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-warning-text, #9A6510)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}/>
          Sin señal del gateway; el dato puede estar desactualizado
        </div>
      )}
    </div>
  )
}

/**
 * Qué se lavó hoy, según el PLC.
 *
 * Es la otra mitad del número de lavados: doce carros de PRO y doce de
 * SIGNATURE ocupan la misma línea en el conteo y son días completamente
 * distintos en plata y en tiempo de máquina.
 *
 * El servicio se deduce de la duración del ciclo (0038), así que esto no
 * depende de que alguien lo haya facturado. La diferencia contra lo vendido en
 * caja es, justamente, lo que conviene mirar.
 */
function ServiciosDelDia({ servicios, total, porHora }: {
  servicios: { tipo: string; washes: number; avg_seconds: number }[]
  total: number
  porHora: Map<number, number>
}) {
  const de = (tipo: string) => servicios.find(s => s.tipo === tipo)
  const sinClasificar = de('UNKNOWN')

  // Sólo las horas con actividad, y siempre de la primera a la última: una
  // franja de 24 columnas dejaría la mitad vacía todos los días.
  const horas = [...porHora.keys()].sort((a, b) => a - b)
  const desde = horas[0] ?? 0
  const hasta = horas[horas.length - 1] ?? 0
  const pico = Math.max(...porHora.values(), 1)

  return (
    <div style={{ marginTop: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
          Servicios detectados hoy
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          por duración del ciclo · no depende de la caja
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {SERVICIOS.map(tipo => {
          const s = de(tipo)
          const n = s?.washes ?? 0
          const pct = total > 0 ? Math.round((n / total) * 100) : 0
          return (
            <div key={tipo} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--text-secondary)' }}>{tipo}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 28, lineHeight: 1, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{n}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{pct}%</div>
              </div>
              {/* Barra de proporción: comparar tres números de dos dígitos es
                  más rápido con una barra que leyéndolos. */}
              <div style={{ marginTop: 8, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--corsa-green)' }}/>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                {n > 0 ? `duración promedio ${duracion(s?.avg_seconds)}` : 'sin lavados'}
              </div>
            </div>
          )
        })}
      </div>

      {/* Un lavado sin clasificar es un ciclo que corrió fuera de todo rango
          razonable. No se esconde: o hay que recalibrar los límites, o pasó
          algo con la máquina. */}
      {!!sinClasificar?.washes && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--color-warning-text, #9A6510)' }}>
          {sinClasificar.washes} {sinClasificar.washes === 1 ? 'lavado' : 'lavados'} sin clasificar
          {' '}(duración fuera del rango esperado, promedio {duracion(sinClasificar.avg_seconds)})
        </div>
      )}

      {horas.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Lavados por hora</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 56 }}>
            {Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i).map(h => {
              const n = porHora.get(h) ?? 0
              return (
                <div key={h} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{n || ''}</div>
                  <div style={{
                    width: '100%',
                    height: Math.max(2, Math.round((n / pico) * 34)),
                    background: n > 0 ? 'var(--corsa-green)' : 'var(--border)',
                    borderRadius: 2,
                  }}/>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{h}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function ServiceKPIRow({ svc, idx, max }: { svc: ServiceKPI; idx: number; max: number }) {
  const style = CAT_COLORS[idx % 5]
  const barPct = Math.max(4, Math.round(svc.count / max * 100))

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      {/* Color dot */}
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: style.bar, flexShrink: 0, marginTop: 2 }}/>

      {/* Name + bar */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{svc.service_name}</div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmt(svc.revenue)}</div>
        </div>
        <div style={{ height: 5, borderRadius: 3, background: 'var(--subtle-bg)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${barPct}%`, background: style.bar, borderRadius: 3, transition: 'width 0.4s ease' }}/>
        </div>
      </div>

      {/* Count + avg */}
      <div style={{ flexShrink: 0, textAlign: 'right', minWidth: 80 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{svc.count} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-secondary)' }}>uds</span></div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', marginTop: 1 }}>{fmt(svc.avg_ticket)}/u</div>
      </div>

      {/* % badge */}
      <div style={{ flexShrink: 0, width: 40, textAlign: 'center' }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: style.color, background: style.tint, padding: '3px 6px', borderRadius: 4 }}>{svc.pct}%</span>
      </div>
    </div>
  )
}

function BarChart7Days({ items }: { items: DailySummary[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 150, paddingTop: 6 }}>
      {items.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: '100%' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{d.total_orders}</div>
          <div
            title={`${d.label}: ${fmt(d.gross_revenue)}`}
            style={{
              width: '100%', maxWidth: 36,
              height: `${d.pct}%`,
              background: d.is_today ? 'var(--corsa-orange)' : 'var(--corsa-green)',
              borderRadius: '3px 3px 0 0',
              transition: 'height 0.4s ease',
              cursor: 'default',
            }}
          />
          <div style={{ fontSize: 11, color: d.is_today ? 'var(--corsa-orange)' : 'var(--text-secondary)', fontWeight: d.is_today ? 700 : 400, textAlign: 'center', lineHeight: 1.2 }}>{d.label}</div>
        </div>
      ))}
    </div>
  )
}

function Heatmap({ rows }: { rows: { label: string; cells: HourCell[] }[] }) {
  const [tooltip, setTooltip] = useState<{ label: string; hour: string; count: number } | null>(null)
  const { isDark } = useTheme()
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {rows.map(row => (
          <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <div style={{ width: 26, fontSize: 10.5, color: 'var(--text-secondary)', flexShrink: 0 }}>{row.label}</div>
            <div style={{ display: 'flex', gap: 2, flex: 1 }}>
              {row.cells.map((cell, ci) => (
                <div
                  key={ci}
                  title={`${row.label} ${cell.hour}: ${cell.count} lavados`}
                  onMouseEnter={() => setTooltip({ label: row.label, hour: cell.hour, count: cell.count })}
                  onMouseLeave={() => setTooltip(null)}
                  style={{
                    flex: 1,
                    aspectRatio: '1',
                    borderRadius: 2,
                    background: heatColor(cell.intensity),
                    cursor: 'default',
                    transition: 'transform 0.1s',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: heatInk(cell.intensity, isDark),
                    fontSize: 11,
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1,
                    // Con celdas angostas —el teléfono, o una semana completa
                    // en pantalla— un número de dos cifras desbordaría y
                    // ensancharía la fila entera.
                    overflow: 'hidden',
                  }}
                  onMouseOver={e => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1.3)' }}
                  onMouseOut={e => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1)' }}
                >
                  {/* Las horas sin lavados van vacías. Una grilla sembrada de
                      ceros es ruido: la celda pálida ya dice «acá no pasó
                      nada», y el cero compite por la mirada con los números
                      que sí importan. */}
                  {cell.count > 0 ? cell.count : ''}
                </div>
              ))}
            </div>
          </div>
        ))}
        {/* Hour labels — salen de las celdas, que ahora definen la franja. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 2 }}>
          <div style={{ width: 26, flexShrink: 0 }}/>
          <div style={{ display: 'flex', gap: 2, flex: 1 }}>
            {(rows[0]?.cells ?? []).map((c, i) => (
              <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: 'var(--text-secondary)' }}>{c.hour}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-secondary)', textAlign: 'center' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{tooltip.label} {tooltip.hour}</span>
          {' — '}{tooltip.count} {tooltip.count === 1 ? 'servicio' : 'servicios'}
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Menos</div>
        {[0.05, 0.25, 0.50, 0.75, 1.0].map(v => (
          <div key={v} style={{ width: 14, height: 14, borderRadius: 2, background: heatColor(v) }}/>
        ))}
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Más</div>
      </div>
    </div>
  )
}

function WeekSummaryTable({ items }: { items: DailySummary[] }) {
  const totalOrders  = items.reduce((s, d) => s + d.total_orders, 0)
  const totalRevenue = items.reduce((s, d) => s + d.gross_revenue, 0)
  return (
    <div>
      <div style={{ display: 'flex', fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', paddingBottom: 8, borderBottom: '1px solid var(--border)', gap: 0 }}>
        <div style={{ flex: 1 }}>Día</div>
        <div style={{ width: 60, textAlign: 'center' }}>Órdenes</div>
        <div style={{ width: 100, textAlign: 'right' }}>Ingresos</div>
        <div style={{ width: 64, textAlign: 'right' }}>Prom.</div>
      </div>
      {items.map((d, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '8px 0',
            borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none',
            background: d.is_today ? 'rgba(223,245,107,0.22)' : 'transparent',
          }}
        >
          <div style={{ flex: 1, fontSize: 13, fontWeight: d.is_today ? 700 : 500, color: d.is_today ? 'var(--corsa-orange)' : 'var(--text-primary)' }}>
            {d.label}
            {d.is_today && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: 'var(--corsa-orange)', background: 'rgba(223,245,107,0.35)', padding: '1px 5px', borderRadius: 3 }}>hoy</span>}
          </div>
          <div style={{ width: 60, textAlign: 'center', fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{d.total_orders}</div>
          <div style={{ width: 100, textAlign: 'right', fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmtShort(d.gross_revenue)}</div>
          <div style={{ width: 64, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(d.gross_revenue / d.total_orders)}</div>
        </div>
      ))}
      {/* Total row */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 0 0', marginTop: 4, borderTop: '2px solid var(--border)' }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Total 7 días</div>
        <div style={{ width: 60, textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{totalOrders}</div>
        <div style={{ width: 100, textAlign: 'right', fontSize: 14, fontWeight: 800, fontFamily: 'var(--font-heading)', color: 'var(--corsa-green)', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalRevenue)}</div>
        <div style={{ width: 64, textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalRevenue / totalOrders)}</div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────

export function DashboardPage() {
  const { profile, currentBranch, hasPermission } = useAuth()
  const branchId = (currentBranch as any)?.id ?? null

  // State
  const [kpis, setKpis] = useState<KPIs | null>(null)
  // Sin datos de relleno: si no hay ventas, las secciones muestran su vacío.
  const [serviceKpis, setServiceKpis] = useState<ServiceKPI[]>([])
  const [dailySales, setDailySales] = useState<DailySummary[]>([])
  const [heatmapRows, setHeatmapRows] = useState<{ label: string; cells: HourCell[] }[]>([])
  // Qué semana se está mirando: 0 es la actual, −1 la pasada, y así.
  //
  // Existe porque el arreglo del mapa es retroactivo: los lavados siempre se
  // guardaron con su fecha, así que cualquier semana vieja se dibuja bien. Sin
  // esta navegación esa corrección no se podría mirar, sólo suponer.
  const [semanaOffset, setSemanaOffset] = useState(0)
  // Por qué el mapa no se pudo cargar, si es que no se pudo.
  //
  // Antes el fallo se tragaba con un `return` y la grilla quedaba vacía, que se
  // lee como «no hubo lavados». Son cosas distintas y la diferencia importa: si
  // falta la migración 0044, la columna wash_date no existe y el mapa se vería
  // vacío un día entero antes de que alguien sospeche.
  const [heatmapError, setHeatmapError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [cashAlert, setCashAlert] = useState<{ difference: number } | null>(null)
  const [voucherStats, setVoucherStats] = useState({ revenue: 0, sold: 0, redeemed: 0 })
  const [machines, setMachines] = useState<MachineCard[]>([])
  const [lavadosPorHora, setLavadosPorHora] = useState<Map<number, number>>(new Map())
  const [serviciosPlc, setServiciosPlc] = useState<{ tipo: string; washes: number; avg_seconds: number }[]>([])

  /**
   * Estado de las máquinas, desde el gateway PLC.
   *
   * Va aparte de loadKPIs a propósito: si las tablas del PLC todavía no
   * existen —la migración 0036 se corre en otro momento que el despliegue de
   * la app— la consulta falla, y no puede llevarse puesto el resto del
   * resumen del día. Acá el fallo se traduce en «no hay tarjetas», no en una
   * pantalla rota.
   */
  const loadMachines = useCallback(async () => {
    if (!hasPermission('plc.read')) return
    const { data, error } = await (supabase as any)
      .from('v_plc_machines')
      .select('machine_id, name, status, washes_today, pro_today, elite_today, signature_today, ' +
              'unknown_today, avg_seconds_today, interrupted_today, washes_in_progress, ' +
              'reporting, current_service, active')
      .eq('active', true)
      .order('machine_id')

    if (error) { setMachines([]); return }
    setMachines(data ?? [])

    // Duración promedio por servicio. Las tarjetas ya traen los conteos; esto
    // agrega el «cuánto dura», que es lo que permite ver si un SIGNATURE se
    // está corriendo más lento de lo que debería.
    const { data: svc } = await (supabase as any)
      .from('v_plc_servicios_diarios')
      .select('service_type, washes, avg_seconds')
      .eq('day', hoyLocal())

    const acum = new Map<string, { washes: number; segundos: number }>()
    for (const s of (svc ?? []) as any[]) {
      const prev = acum.get(s.service_type) ?? { washes: 0, segundos: 0 }
      prev.washes += Number(s.washes ?? 0)
      // Promedio ponderado: cada máquina aporta su promedio por la cantidad de
      // lavados que hizo, no por igual.
      prev.segundos += Number(s.avg_seconds ?? 0) * Number(s.washes ?? 0)
      acum.set(s.service_type, prev)
    }
    setServiciosPlc([...acum.entries()].map(([tipo, v]) => ({
      tipo,
      washes: v.washes,
      avg_seconds: v.washes > 0 ? Math.round(v.segundos / v.washes) : 0,
    })))

    // Los lavados por hora van en una consulta aparte y su fallo no se
    // propaga: el tablero sin la franja horaria sigue sirviendo, sin el
    // conteo no sirve de nada.
    const { data: horas } = await (supabase as any)
      .from('v_plc_production_hourly')
      .select('hour, washes')
      .gte('hour', `${hoyLocal()}T00:00:00`)
      .lt('hour', `${sumarDias(hoyLocal(), 1)}T00:00:00`)

    // `hour` viene truncado a la hora local, sin zona: se lee la hora tal cual
    // en lugar de dejar que el navegador la reinterprete en la suya.
    const porHora = new Map<number, number>()
    for (const h of (horas ?? []) as any[]) {
      const hh = Number(String(h.hour).slice(11, 13))
      porHora.set(hh, (porHora.get(hh) ?? 0) + Number(h.washes ?? 0))
    }
    setLavadosPorHora(porHora)
  }, [hasPermission])

  /**
   * Mapa de calor — uso real de las máquinas, no facturación.
   *
   * Va con las máquinas y no con loadKPIs, que es donde estaba: loadKPIs sólo
   * se vuelve a correr cuando cambia algo en work_orders, y un lavado del PLC
   * no toca work_orders. O sea que el mapa quedaba congelado en la foto del
   * momento en que se abrió la pantalla mientras las tarjetas de arriba
   * seguían subiendo — el mapa decía 4 y las máquinas 5, y la diferencia no
   * era un dato sino la pantalla vieja.
   *
   * El `or` con branch_id nulo no es un descuido: la sucursal del lavado sale
   * del gateway que lo reportó, y un gateway al que nadie le asignó sucursal
   * igual está adentro de este local. Dejar sus lavados afuera mostraría un
   * mapa vacío con las máquinas trabajando.
   */
  const loadHeatmap = useCallback(async () => {
    if (!branchId) return
    // ACOTADO A LA SEMANA EN CURSO, y esto es la mitad del sentido del mapa.
    //
    // Sin el filtro la vista suma TODOS los lunes desde que el carwash existe
    // sobre la misma celda. El número deja de significar algo y la escala de
    // color se satura: los días viejos acumulan tanto que el día que se está
    // mirando siempre sale pálido.
    //
    // Con el filtro, cada día arranca vacío cuando le toca: el lunes se limpia
    // el lunes, el martes el martes, y la grilla se llena a medida que avanza
    // la semana. Los días que todavía no llegaron se ven vacíos porque lo
    // están, no porque falte el dato.
    // Ventana RODANTE de siete días que termina HOY, no la semana del
    // calendario. Cada día se limpia a su medianoche y se va llenando hora por
    // hora; los otros seis siguen mostrando su última vez hasta que les toque.
    //
    // Con lunes-a-domingo los días que todavía no habían llegado salían
    // vacíos, y un miércoles dejaba media grilla en blanco. Acá siempre hay
    // siete días con datos y ninguno se apila con el de la semana pasada,
    // porque la ventana tiene exactamente siete fechas distintas.
    const hoy = hoyLocal()
    const finVentana = sumarDias(hoy, semanaOffset * 7)
    const fechas = ventanaDeSieteDias(finVentana)
    const { data, error } = await (supabase as any)
      .from('v_plc_heatmap')
      .select('wash_date, hour_of_day, washes')
      .gte('wash_date', fechas[0])
      .lte('wash_date', finVentana)
      .or(`branch_id.eq.${branchId},branch_id.is.null`)
    if (error) {
      // El mapa dibujado no se borra —se queda el último bueno— pero el motivo
      // sube a la pantalla en vez de perderse.
      const detalle = String(error.message ?? error)
      setHeatmapError(
        /wash_date/.test(detalle)
          ? 'Falta correr la migración 0044 en Supabase: la vista todavía no tiene la columna wash_date.'
          : `No se pudo cargar el mapa: ${detalle}`,
      )
      return
    }
    setHeatmapError(null)
    setHeatmapRows(buildHeatmapFrom(data ?? [], fechas, hoy))
  }, [branchId, semanaOffset])

  const loadKPIs = useCallback(async () => {
    if (!branchId) return
    setLoading(true)
    try {
      // El día del carwash, no el día UTC. `sale_date` en las vistas ya está
      // convertido a hora de El Salvador; pedirle el día UTC dejaba el tablero
      // en cero desde las 6 de la tarde, que es cuando más se trabaja.
      const today = hoyLocal()
      const desdeMedianoche = inicioDelDiaISO(today)

      // Totales del día desde v_daily_totals (0032), que separa plata de
      // servicio. Calcularlo acá sumando work_orders mezclaría las tres
      // naturalezas: una venta de cupones no presta servicio y un canje no
      // ingresa plata, así que el ticket promedio saldría mal en ambos casos.
      const { data: totales } = await (supabase as any)
        .from('v_daily_totals')
        .select('*')
        .eq('branch_id', branchId)
        .eq('sale_date', today)
        .maybeSingle()

      const { data: orders } = await (supabase as any)
        .from('work_orders')
        .select('status, order_kind')
        .eq('branch_id', branchId)
        .gte('created_at', desdeMedianoche)

      // Un día sin ventas es un dato, no un error: se muestran ceros.
      setKpis({
        gross_revenue: Number(totales?.gross_revenue ?? 0),
        total_orders: Number(totales?.services_delivered ?? 0),
        completed_orders: Number(totales?.services_delivered ?? 0),
        avg_ticket: Number(totales?.avg_ticket ?? 0),
        cancelled_orders: (orders ?? []).filter((o: any) => o.status === 'cancelled').length,
        total_discounts: 0,
      })
      setVoucherStats({
        revenue: Number(totales?.voucher_revenue ?? 0),
        sold: Number(totales?.voucher_sales ?? 0),
        redeemed: Number(totales?.vouchers_redeemed ?? 0),
      })

      // Desglose por servicio del día.
      // No se usa v_service_performance: esa vista agrupa por MES, y la
      // consulta anterior filtraba por `order_date`, columna que no existe —
      // fallaba en silencio y dejaba a la vista los datos de relleno.
      const { data: svcData } = await (supabase as any)
        .from('work_order_items')
        .select('service_id, description_snapshot, total, work_orders!inner(branch_id, status, created_at)')
        .eq('work_orders.branch_id', branchId)
        .neq('work_orders.status', 'cancelled')
        .gte('work_orders.created_at', desdeMedianoche)

      if (svcData) {
        const porServicio = new Map<string, { name: string; count: number; revenue: number }>()
        for (const row of svcData as any[]) {
          const key = row.service_id ?? row.description_snapshot
          const prev = porServicio.get(key) ?? { name: row.description_snapshot, count: 0, revenue: 0 }
          prev.count += 1
          prev.revenue += Number(row.total) || 0
          porServicio.set(key, prev)
        }
        const totalCount = [...porServicio.values()].reduce((n, r) => n + r.count, 0)
        setServiceKpis([...porServicio.entries()]
          .map(([id, r]) => ({
            service_id: id,
            service_name: r.name,
            count: r.count,
            revenue: r.revenue,
            pct: totalCount > 0 ? Math.round((r.count / totalCount) * 100) : 0,
            avg_ticket: r.count > 0 ? r.revenue / r.count : 0,
          }))
          .sort((a, b) => b.revenue - a.revenue))
      }

      // 7-day summary
      const weekStart = sumarDias(today, -6)

      const { data: weekData } = await (supabase as any)
        .from('v_daily_sales')
        .select('*')
        .eq('branch_id', branchId)
        .gte('sale_date', weekStart)
        .order('sale_date')

      if (weekData) {
        const max = Math.max(...weekData.map((d: any) => d.total_orders || 1))
        setDailySales(weekData.map((d: any) => {
          const date = new Date(d.sale_date + 'T12:00:00')
          const isToday = d.sale_date === today
          return {
            sale_date: d.sale_date,
            label: isToday ? `${DIAS_ES[date.getDay()]}\u00a0(hoy)` : DIAS_ES[date.getDay()],
            total_orders: d.total_orders || 0,
            gross_revenue: d.gross_revenue || 0,
            pct: Math.max(6, Math.round((d.total_orders || 0) / max * 100)),
            is_today: isToday,
          }
        }))
      }

      // Cash discrepancy
      const { data: cashData } = await (supabase as any)
        .from('cash_sessions')
        .select('difference_amount')
        .eq('branch_id', branchId)
        .eq('status', 'closed')
        .not('difference_amount', 'is', null)
        .lt('difference_amount', -1)
        .order('closed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (cashData) setCashAlert({ difference: cashData.difference_amount })

    } catch {
      // Sin datos no se inventa nada: las secciones muestran su estado vacío.
    }
    setLoading(false)
  }, [branchId])

  useEffect(() => { loadKPIs() }, [loadKPIs])

  // Lo que mide el PLC se refresca solo: el operador deja este tablero abierto
  // durante el turno y un número congelado desde que abrió la pantalla no
  // sirve de nada. Treinta segundos es la cadencia del heartbeat del gateway;
  // pedir más seguido no traería datos nuevos.
  //
  // Las tarjetas y el mapa de calor se piden juntos, en el mismo tick. Cuando
  // iban por caminos distintos terminaban contando cosas distintas del mismo
  // día, y quien mira el tablero no tiene cómo saber cuál de los dos está
  // viejo.
  useEffect(() => {
    const refrescar = () => { loadMachines(); loadHeatmap() }
    refrescar()
    const t = setInterval(refrescar, 30_000)
    return () => clearInterval(t)
  }, [loadMachines, loadHeatmap])

  // Realtime
  useEffect(() => {
    if (!branchId) return
    const channel = supabase
      .channel(`dash:${branchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'work_orders', filter: `branch_id=eq.${branchId}` },
        () => loadKPIs())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [branchId, loadKPIs])

  // Los lavados que contó el PLC. Puede no coincidir con los vehículos
  // facturados, y esa diferencia es justamente lo interesante: un lavado que
  // la máquina hizo y la caja no cobró.
  const totalLavadosPlc = machines.reduce((acc, m) => acc + (m.washes_today ?? 0), 0)

  // Lavados que las máquinas hicieron y la caja no registró: la diferencia
  // entre los dos KPI, y la razón por la que vale la pena tener los dos —uno
  // mide el PLC y el otro la facturación.
  //
  // Sólo tiene sentido si la caja está en uso. Con cero facturado, la brecha
  // es igual al total y la tarjeta diría «33 sin cobrar» todos los días
  // mientras el local no use el POS: una alarma que suena siempre deja de
  // significar algo.
  const facturados = kpis?.completed_orders ?? 0
  const brechaConCaja = facturados > 0 ? Math.max(0, totalLavadosPlc - facturados) : 0

  // Labels
  const todayLabel = formatearFecha(new Date(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const firstName = (profile as any)?.first_name ?? 'equipo'
  const branchName = (currentBranch as any)?.name ?? ''

  const totalRevenueSvc = serviceKpis.reduce((s, k) => s + k.revenue, 0)
  const maxCount = Math.max(...serviceKpis.map(s => s.count), 1)

  // El pico salía escrito a mano ("Pico: 11am–12pm · Sábado"). Ahora se deriva
  // de las celdas reales; sin lavados no se afirma nada.
  const picoLabel = (() => {
    let mejor: { dia: string; hora: string; count: number } | null = null
    for (const row of heatmapRows) {
      for (const cell of row.cells) {
        if (cell.count > 0 && (!mejor || cell.count > mejor.count)) {
          mejor = { dia: row.label, hora: cell.hour, count: cell.count }
        }
      }
    }
    return mejor ? `Pico: ${mejor.hora} · ${mejor.dia} (${mejor.count} lavados)` : null
  })()

  // El total del mapa, a la vista. Sin esto, «¿cuadra con lo que dice la base?»
  // se contesta sumando celdas a mano — que es como se encontró que faltaba
  // una máquina.
  const totalMapa = heatmapRows.reduce(
    (suma, fila) => suma + fila.cells.reduce((s, c) => s + c.count, 0), 0)

  // Cómo se llama la semana que se está mirando. Se escribe el rango completo
  // y no sólo «hace 2 semanas»: al conciliar contra otra fuente hace falta
  // saber qué días entran, y contarlos hacia atrás a mano invita al error.
  const finVisible = sumarDias(hoyLocal(), semanaOffset * 7)
  const inicioVisible = sumarDias(finVisible, -6)
  const rangoSemana = `${formatearFecha(new Date(inicioVisible + 'T12:00:00'), { day: 'numeric', month: 'short' })} — ${formatearFecha(new Date(finVisible + 'T12:00:00'), { day: 'numeric', month: 'short' })}`
  const etiquetaSemana =
    semanaOffset === 0 ? 'en los últimos 7 días'
    : `en los 7 días que terminan el ${formatearFecha(new Date(finVisible + 'T12:00:00'), { day: 'numeric', month: 'short' })}`

  return (
    <div className="page-inner">

      {/* ── Header ── */}
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 36, letterSpacing: '-0.03em', color: 'var(--text-primary)', margin: 0 }}>
            Hola, {firstName}
          </h1>
          <div className="page-header-sub">
            {todayLabel}{branchName && ` · Sucursal ${branchName}`}
          </div>
        </div>
      </div>

      {/* ── Cash alert ── */}
      {cashAlert && (
        <div className="alert-banner warning">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div className="alert-body">
            <div className="alert-title">Diferencia sin justificar en el cierre de anoche</div>
            <div className="alert-desc">El corte de caja quedó con una diferencia de {fmt(Math.abs(cashAlert.difference))}. Revísalo antes de continuar.</div>
          </div>
          <a href="#" className="alert-link">Revisar cierre de caja</a>
        </div>
      )}

      {/* ── KPI Cards (Top) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        <KpiCard
          primary
          label="Ventas de hoy"
          value={kpis ? fmt(kpis.gross_revenue) : '—'}
          trend={kpis ? { val: '12% vs. ayer', up: true } : null}
        />
        <KpiCard
          label="Vehículos atendidos"
          value={kpis ? String(kpis.completed_orders) : '—'}
          sub={`/ meta 60 · ${kpis ? Math.round(kpis.completed_orders / 60 * 100) : 0}% completado`}
        />
        <KpiCard
          label="Ticket promedio"
          value={kpis ? fmt(kpis.avg_ticket) : '—'}
          trend={kpis && kpis.avg_ticket > 25 ? { val: 'Sobre meta US$25', up: true } : null}
        />
        {/* Lo que de verdad hicieron las máquinas hoy, sumando las dos.
            Reemplaza a «Órdenes activas», que contaba órdenes de taller — un
            flujo que este local no usa, así que marcaba cero todos los días y
            ocupaba el lugar de un dato real.

            Con máquinas sin reportar muestra «—» y no «0»: que no haya datos
            y que no se haya lavado nada son cosas distintas, y a las siete de
            la mañana un cero es normal mientras que un gateway caído no. */}
        <KpiCard
          label="Servicios brindados"
          value={machines.length ? String(totalLavadosPlc) : '—'}
          sub={
            machines.length === 0
              ? 'sin lectura de las máquinas'
              : brechaConCaja > 0
                ? `${brechaConCaja} sin cobrar en caja`
                : `${machines.length === 1 ? 'la máquina' : `las ${machines.length} máquinas`} · lectura del PLC`
          }
        />
      </div>

      {/* ── Máquinas de lavado ── */}
      {machines.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
              Máquinas de lavado
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {totalLavadosPlc} {totalLavadosPlc === 1 ? 'lavado' : 'lavados'} hoy · lectura directa del PLC
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
            {machines.map(m => <MachineCard key={m.machine_id} m={m} />)}
          </div>

          {totalLavadosPlc > 0 && (
            <ServiciosDelDia
              servicios={serviciosPlc}
              total={totalLavadosPlc}
              porHora={lavadosPorHora}
            />
          )}
        </div>
      )}

      {/* ── Ventas por servicio + 7 días ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>

        {/* Servicios vendidos hoy */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Servicios vendidos hoy</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 18, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(totalRevenueSvc)}</div>
          </div>

          {loading && serviceKpis.length === 0 ? (
            <div className="loading-center"><div className="spinner"/></div>
          ) : serviceKpis.length === 0 ? (
            <div className="empty-state"><div className="empty-state-sub">Sin ventas registradas hoy</div></div>
          ) : (
            <>
              {/* Service type mini KPIs */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                {serviceKpis.slice(0, 3).map((s, i) => (
                  <div key={s.service_id} style={{ background: 'var(--subtle-bg)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_COLORS[i % 5].bar, flexShrink: 0 }}/>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.service_name.split('·')[0].trim()}
                      </div>
                    </div>
                    <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{s.count}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(s.revenue)}</div>
                  </div>
                ))}
              </div>

              {/* Full list */}
              {serviceKpis.length === 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', padding: '12px 0' }}>
                  Todavía no hay servicios facturados hoy.
                </div>
              )}
              {serviceKpis.map((svc, i) => (
                <ServiceKPIRow key={svc.service_id} svc={svc} idx={i} max={maxCount} />
              ))}
            </>
          )}
        </div>

        {/* Últimos 7 días */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>Servicios por día — últimos 7 días</div>
          <BarChart7Days items={dailySales} />
          <div style={{ height: 1, background: 'var(--border)' }}/>
          <WeekSummaryTable items={dailySales} />
        </div>

      </div>

      {/* ── Cupones del día ──
          Se muestran aparte de los KPI principales a propósito: la venta de
          cupones suma plata pero no servicios, y el canje suma servicio pero
          no plata. Mezclarlos con el ticket promedio lo distorsionaría. */}
      {(voucherStats.sold > 0 || voucherStats.redeemed > 0) && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px', display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14 }}>Cupones</div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Vendidos hoy</div>
            <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
              {voucherStats.sold} · {fmt(voucherStats.revenue)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Canjeados hoy</div>
            <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
              {voucherStats.redeemed}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', flex: 1, minWidth: 220, lineHeight: 1.5 }}>
            La venta suma al ingreso del día pero no cuenta como servicio.
            El canje cuenta como servicio prestado, sin volver a sumar plata.
          </div>
        </div>
      )}

      {/* ── Mapa de calor ──
          Acotado a media pantalla: las celdas usan aspect-ratio 1, así que a
          ancho completo 13 columnas × 7 filas ocupaban un bloque enorme sin
          aportar más información. */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '16px 18px', maxWidth: 560,
      }}>
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>
              Mapa de calor · lavados por hora
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              {totalMapa > 0
                ? `${totalMapa} ${totalMapa === 1 ? 'lavado' : 'lavados'} ${etiquetaSemana}${
                    picoLabel ? ' · ' + picoLabel.toLowerCase() : ''}`
                : `Sin lavados ${etiquetaSemana}`}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
              {rangoSemana}
            </div>
            {heatmapError && (
              <div style={{
                fontSize: 11.5, marginTop: 6, padding: '6px 9px', borderRadius: 8,
                background: 'var(--color-warning-tint)', color: 'var(--color-warning-text)',
                lineHeight: 1.4,
              }}>
                {heatmapError}
              </div>
            )}
          </div>

          {/* Navegación de semanas.
              Hacia adelante se corta en la semana actual: no hay datos del
              futuro, y un botón que no hace nada se prueba una vez y confunde
              cada vez. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <button
              onClick={() => setSemanaOffset(n => n - 1)}
              aria-label="Semana anterior"
              style={flechaSemana}
            >‹</button>
            {semanaOffset !== 0 && (
              <button
                onClick={() => setSemanaOffset(0)}
                style={{ ...flechaSemana, width: 'auto', padding: '0 10px', fontSize: 11.5 }}
              >Hoy</button>
            )}
            <button
              onClick={() => setSemanaOffset(n => Math.min(0, n + 1))}
              disabled={semanaOffset >= 0}
              aria-label="Semana siguiente"
              style={{ ...flechaSemana, opacity: semanaOffset >= 0 ? 0.35 : 1, cursor: semanaOffset >= 0 ? 'default' : 'pointer' }}
            >›</button>
          </div>
        </div>
        <Heatmap rows={heatmapRows} />
      </div>

      {/* ── KPIs adicionales de servicios ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {serviceKpis.map((s, i) => {
          const style = CAT_COLORS[i % 5]
          return (
            <div key={s.service_id} style={{ background: 'var(--surface)', border: `1px solid var(--border)`, borderLeft: `4px solid ${style.bar}`, borderRadius: 12, padding: '14px 16px' }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 6 }}>{s.service_name}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 28, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{s.count}</div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmt(s.revenue)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.pct}% del total</div>
                </div>
              </div>
              {/* Mini progress */}
              <div style={{ marginTop: 10, height: 3, borderRadius: 2, background: 'var(--subtle-bg)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${s.pct}%`, background: style.bar, borderRadius: 2 }}/>
              </div>
            </div>
          )
        })}
      </div>

    </div>
  )
}
