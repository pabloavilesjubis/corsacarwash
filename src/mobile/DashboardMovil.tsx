/**
 * CORSA Carwash — Resumen del día, en el teléfono
 *
 * No es el tablero de escritorio angosto: es otra pantalla. Quien la mira está
 * parado en el local o llegando en el carro, con una mano, y quiere saber tres
 * cosas en ese orden — cuánto se vendió, cómo van las máquinas, y qué se está
 * lavando. El mapa de calor, la tabla de servicios y los últimos 7 días no
 * entran en esa lista: viven en la versión de computadora, donde hay lugar
 * para mirarlos con calma.
 *
 * Los datos salen de src/services/plc.service.ts, el mismo lugar del que
 * debería leerlos el escritorio el día que se unifiquen.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { inicioDelDiaISO, formatearFecha } from '../utils/fecha'
import {
  fetchMaquinas, fetchServiciosHoy, fetchTotalesDelDia, duracionCorta,
  type MaquinaPlc, type ServicioDelDia,
} from '../services/plc.service'

const SERVICIOS = ['PRO', 'ELITE', 'SIGNATURE'] as const

const ESTADOS: Record<string, { label: string; bg: string }> = {
  WASHING:   { label: 'LAVANDO',  bg: '#1E9E6B' },
  READY:     { label: 'LISTA',    bg: '#0F7B5A' },
  NOT_READY: { label: 'NO LISTA', bg: '#9A6510' },
  FAULT:     { label: 'FALLA',    bg: '#B3261E' },
  OFFLINE:   { label: 'OFFLINE',  bg: '#5F6368' },
}

function money(n: number): string {
  return 'US$' + (Number(n) || 0).toFixed(2)
}

function nombreDeMaquina(m: MaquinaPlc): string {
  if (m.name && m.name !== m.machine_id) return m.name
  const n = m.machine_id.match(/(\d+)\s*$/)
  return n ? `Máquina ${n[1]}` : m.machine_id
}

function Kpi({ label, valor, sub, destacado }: {
  label: string; valor: string; sub?: string; destacado?: boolean
}) {
  return (
    <div className="corsa-movil__tarjeta" style={destacado ? {
      background: 'var(--corsa-green)', borderColor: 'var(--corsa-green)',
    } : undefined}>
      <div className="corsa-movil__etiqueta" style={destacado ? { color: 'rgba(255,255,255,0.78)' } : undefined}>
        {label}
      </div>
      <div className="corsa-movil__numero" style={destacado ? { color: '#fff' } : undefined}>
        {valor}
      </div>
      {sub && (
        <div style={{ marginTop: 4, fontSize: 11, color: destacado ? 'rgba(255,255,255,0.65)' : 'var(--text-secondary)' }}>
          {sub}
        </div>
      )}
    </div>
  )
}

function TarjetaMaquina({ m }: { m: MaquinaPlc }) {
  const estado = ESTADOS[m.status ?? ''] ?? { label: (m.status ?? 'SIN DATOS').toUpperCase(), bg: '#5F6368' }

  return (
    <div className="corsa-movil__tarjeta" style={{
      borderLeft: `4px solid ${m.reporting ? estado.bg : 'var(--border)'}`,
      opacity: m.reporting ? 1 : 0.75,
      marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14.5, color: 'var(--text-primary)' }}>
          {nombreDeMaquina(m)}
        </div>
        {/* El estado grande y en color es lo que se lee de lejos, que es como
            se mira el teléfono cuando uno está caminando por el local. */}
        <span style={{
          background: estado.bg, color: '#fff', fontFamily: 'var(--font-heading)',
          fontWeight: 800, fontSize: 13, letterSpacing: 0.4, lineHeight: 1,
          padding: '8px 12px', borderRadius: 5, whiteSpace: 'nowrap',
        }}>
          {estado.label}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 12 }}>
        <div style={{
          fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 34,
          lineHeight: 1, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
        }}>
          {m.washes_today}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {m.washes_today === 1 ? 'lavado hoy' : 'lavados hoy'}
        </div>
        {!!m.avg_seconds_today && (
          <div style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-secondary)' }}>
            prom. {duracionCorta(m.avg_seconds_today)}
          </div>
        )}
      </div>

      {m.washes_today > 0 && (
        <div style={{ marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
          {SERVICIOS.map(s => {
            const n = s === 'PRO' ? m.pro_today : s === 'ELITE' ? m.elite_today : m.signature_today
            return (
              <div key={s} style={{ color: n > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{n}</strong>{' '}
                <span style={{ fontSize: 11 }}>{s}</span>
              </div>
            )
          })}
          {m.unknown_today > 0 && (
            <div style={{ color: 'var(--color-warning-text, #9A6510)' }}>
              <strong>{m.unknown_today}</strong> <span style={{ fontSize: 11 }}>sin clasificar</span>
            </div>
          )}
        </div>
      )}

      {!m.reporting && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--color-warning-text, #9A6510)' }}>
          Sin señal del gateway; el dato puede estar desactualizado
        </div>
      )}
    </div>
  )
}

export function DashboardMovil() {
  const { profile, currentBranch, hasPermission } = useAuth()
  const branchId = (currentBranch as any)?.id

  const [maquinas, setMaquinas] = useState<MaquinaPlc[]>([])
  const [servicios, setServicios] = useState<ServicioDelDia[]>([])
  const [ventas, setVentas] = useState({ bruto: 0, servicios: 0, ticket: 0 })
  const [activas, setActivas] = useState(0)
  const [cargando, setCargando] = useState(true)

  const cargarPlc = useCallback(async () => {
    if (!hasPermission('plc.read')) return
    setMaquinas(await fetchMaquinas())
    setServicios(await fetchServiciosHoy())
  }, [hasPermission])

  const cargarVentas = useCallback(async () => {
    if (!branchId) return

    const totales = await fetchTotalesDelDia(branchId)
    setVentas({ bruto: totales.ingresos, servicios: totales.servicios, ticket: totales.ticket })

    const { data: ordenes } = await (supabase as any)
      .from('work_orders')
      .select('status, order_kind')
      .eq('branch_id', branchId)
      .gte('created_at', inicioDelDiaISO())

    setActivas((ordenes ?? []).filter(
      (o: any) => o.order_kind === 'service' && !['delivered', 'cancelled'].includes(o.status)
    ).length)
  }, [branchId])

  useEffect(() => {
    let vivo = true
    Promise.all([cargarPlc(), cargarVentas()]).finally(() => { if (vivo) setCargando(false) })
    // Las máquinas se refrescan solas: esta pantalla se deja abierta durante el
    // turno y un número congelado no sirve. 30 s es la cadencia del heartbeat.
    const t = setInterval(cargarPlc, 30_000)
    return () => { vivo = false; clearInterval(t) }
  }, [cargarPlc, cargarVentas])

  const totalLavados = maquinas.reduce((n, m) => n + (m.washes_today ?? 0), 0)
  const servicioDe = (tipo: string) => servicios.find(s => s.tipo === tipo)

  if (cargando) {
    return <div className="loading-center corsa-movil__pantalla" style={{ paddingTop: 40 }}><div className="spinner"/></div>
  }

  return (
    <div className="corsa-movil__pantalla">
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {formatearFecha(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}
      </div>

      <div className="corsa-movil__grid2">
        <Kpi label="Ventas de hoy" valor={money(ventas.bruto)} destacado/>
        <Kpi label="Vehículos" valor={String(ventas.servicios)} sub={`ticket ${money(ventas.ticket)}`}/>
        <Kpi label="Lavados (PLC)" valor={String(totalLavados)} sub="lectura de las máquinas"/>
        <Kpi label="Órdenes activas" valor={String(activas)} sub="en proceso ahora"/>
      </div>

      {maquinas.length > 0 && (
        <>
          <div className="corsa-movil__seccion">Máquinas</div>
          {maquinas.map(m => <TarjetaMaquina key={m.machine_id} m={m}/>)}
        </>
      )}

      {totalLavados > 0 && (
        <>
          <div className="corsa-movil__seccion">Servicios detectados hoy</div>
          <div className="corsa-movil__tarjeta">
            {SERVICIOS.map((tipo, i) => {
              const s = servicioDe(tipo)
              const n = s?.washes ?? 0
              const pct = totalLavados > 0 ? Math.round((n / totalLavados) * 100) : 0
              return (
                <div key={tipo} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 0',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}>
                  <div style={{ width: 82, fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: 'var(--text-secondary)' }}>
                    {tipo}
                  </div>
                  <div style={{ flex: 1, height: 6, background: 'var(--subtle-bg)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--corsa-green)' }}/>
                  </div>
                  <div style={{ width: 58, textAlign: 'right', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
                    {n}
                  </div>
                  <div style={{ width: 46, textAlign: 'right', fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    {duracionCorta(s?.avg_seconds)}
                  </div>
                </div>
              )
            })}
            {!!servicioDe('UNKNOWN')?.washes && (
              <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--color-warning-text, #9A6510)' }}>
                {servicioDe('UNKNOWN')!.washes} sin clasificar — duración fuera del rango esperado
              </div>
            )}
          </div>
        </>
      )}

      <div style={{ marginTop: 20, fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center' }}>
        {profile ? `Sesión de ${(profile as any).first_name ?? 'equipo'}` : ''}
        {currentBranch ? ` · ${(currentBranch as any).name}` : ''}
      </div>
    </div>
  )
}
