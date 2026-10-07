/**
 * Rendimiento de máquinas en el período (bi_maquinas, 0076): Máquina 1 contra
 * Máquina 2. Es un resumen gerencial; el detalle día por día está en Análisis
 * de máquinas (/machines).
 *
 * Lo que NO se muestra, y por qué: disponibilidad y tiempo detenido. El
 * gateway informa las máquinas «en línea» las 24 horas y sólo las fallas
 * traen inicio y fin, así que cualquier porcentaje sería inventado. Las horas
 * operativas se aproximan con la jornada activa (primer a último lavado).
 */
import { Link } from 'react-router-dom'
import type { MaquinasPeriodo, MetricasMaquina } from '../../services/analitica.service'
import { duracionCorta, duracionLarga, nombreMaquina } from '../../services/plc.service'
import { dividir, entero, porcentaje, textoVariacion, variacion } from '../../lib/analitica/variacion'

const COLORES = ['var(--corsa-green)', 'var(--corsa-orange)', 'var(--text-secondary)']

interface Fila {
  label: string
  ayuda?: string
  valor: (m: MetricasMaquina, total: number) => string
}

const FILAS: Fila[] = [
  { label: 'Lavados', valor: m => entero(m.lavados) },
  { label: 'Participación', valor: (m, t) => porcentaje(dividir(m.lavados, t), 0) },
  { label: 'Lavados por hora de jornada', ayuda: 'Lavados ÷ jornada activa', valor: m => {
      const h = dividir(m.lavados, m.segundos_jornada / 3600); return h == null ? '—' : h.toFixed(2) } },
  { label: 'Ciclo promedio', ayuda: 'Sólo ciclos de duración válida', valor: m => duracionCorta(dividir(m.segundos_lavando, m.ciclos_validos) == null ? null : Math.round(m.segundos_lavando / m.ciclos_validos)) },
  { label: 'Utilización', ayuda: 'Tiempo lavando ÷ jornada activa', valor: m => porcentaje(dividir(m.segundos_lavando, m.segundos_jornada), 0) },
  { label: 'Jornada activa', ayuda: 'Primer a último lavado de cada día (aproximación)', valor: m => duracionLarga(m.segundos_jornada) },
  { label: 'Días con lavados', valor: m => entero(m.dias_activos) },
  { label: 'Fallas', valor: m => entero(m.fallas) },
  { label: 'Tiempo en falla', ayuda: 'Parcial: hay fallas que el sistema cerró en 0 s', valor: m => m.segundos_en_falla > 0 ? duracionLarga(m.segundos_en_falla) : '—' },
  { label: 'Sin clasificar', ayuda: 'Ciclos cuya duración no corresponde a un servicio', valor: m => entero(m.sin_clasificar) },
  { label: 'Ciclos fuera de rango', ayuda: 'Cuentan como lavado, no entran al promedio', valor: m => entero(m.ciclos_fuera_de_rango) },
]

export function RendimientoMaquinas({ actual, anterior, maquina, sinBase }: {
  actual: MaquinasPeriodo
  anterior: MaquinasPeriodo
  maquina: string | null
  sinBase: string | null
}) {
  const total = actual.maquinas.reduce((n, m) => n + m.lavados, 0)
  const visibles = actual.maquinas.filter(m => !maquina || m.machine_id === maquina)
  const ant = (id: string) => anterior.maquinas.find(m => m.machine_id === id)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Reparto de la carga */}
      {total > 0 && (
        <div>
          <div style={{ display: 'flex', height: 26, borderRadius: 6, overflow: 'hidden', background: 'var(--subtle-bg)' }}>
            {actual.maquinas.map((m, i) => {
              const f = m.lavados / total
              return f > 0 ? (
                <div key={m.machine_id} title={`${nombreMaquina(m.machine_id, m.nombre)}: ${entero(m.lavados)} lavados`}
                     style={{ width: `${f * 100}%`, background: COLORES[i % COLORES.length], opacity: maquina && maquina !== m.machine_id ? 0.35 : 1,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--surface)', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                  {f >= 0.12 ? `${nombreMaquina(m.machine_id, m.nombre).replace('Máquina ', 'M')} ${porcentaje(f, 0)}` : ''}
                </div>
              ) : null
            })}
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="corsa-table" style={{ border: 'none' }}>
          <thead>
            <tr>
              <th>Indicador</th>
              {visibles.map(m => <th key={m.machine_id} style={{ textAlign: 'right' }}>{nombreMaquina(m.machine_id, m.nombre)}</th>)}
            </tr>
          </thead>
          <tbody>
            {FILAS.map(f => (
              <tr key={f.label}>
                <td>
                  <div style={{ fontWeight: 600 }}>{f.label}</div>
                  {f.ayuda && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{f.ayuda}</div>}
                </td>
                {visibles.map(m => {
                  const esLavados = f.label === 'Lavados'
                  const v = esLavados ? variacion(m.lavados, sinBase ? null : (ant(m.machine_id)?.lavados ?? 0), 'mas_es_mejor', sinBase) : null
                  return (
                    <td key={m.machine_id} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {f.valor(m, total)}
                      {v && v.relativa != null && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{textoVariacion(v)}</div>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Disponibilidad y tiempo detenido no se calculan: el gateway reporta las máquinas en línea las 24 horas y sólo las fallas traen inicio y fin.
        El tipo de servicio de cada ciclo se deduce por su duración. Ciclo válido: {actual.reglas.min_valid_seconds}–{actual.reglas.max_valid_seconds} s.{' '}
        <Link to="/machines" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Ver análisis de máquinas →</Link>
      </div>
    </div>
  )
}
