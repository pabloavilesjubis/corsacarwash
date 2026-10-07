/**
 * Mix de servicios: PRO / ÉLITE / SIGNATURE en el período, contra el
 * anterior, y su evolución. Lo que interesa es hacia dónde migra el cliente:
 * si ÉLITE + SIGNATURE ganan o pierden participación.
 */
import type { MetricasPeriodo, PuntoSerie } from '../../services/analitica.service'
import { etiquetaFecha, type Granularidad } from '../../lib/analitica/periodos'
import { premiumDe, SERVICIOS } from '../../lib/analitica/mix'
import {
  dinero, dividir, entero, porcentaje, textoVariacion, variacion, variacionEnPuntos,
} from '../../lib/analitica/variacion'

const COLOR_TONO = { bueno: 'var(--color-success-text)', malo: 'var(--color-danger-text)', neutro: 'var(--text-secondary)' }

function BarraMix({ m, etiqueta }: { m: MetricasPeriodo; etiqueta: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>{etiqueta}</div>
      <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', background: 'var(--subtle-bg)' }}>
        {m.lavados > 0 && SERVICIOS.map(s => {
          const f = (m.mix[s.code]?.lavados ?? 0) / m.lavados
          return f > 0 ? <div key={s.code} title={`${s.label} ${porcentaje(f)}`} style={{ width: `${f * 100}%`, background: s.color }}/> : null
        })}
      </div>
    </div>
  )
}

export function MixServicios({ actual, anterior, sinBase, serie, granularidad }: {
  actual: MetricasPeriodo
  anterior: MetricasPeriodo
  sinBase: string | null
  serie: PuntoSerie[] | null
  granularidad: Granularidad
}) {
  const premium = premiumDe(actual)
  const premiumAnt = premiumDe(anterior)
  const vPremium = variacionEnPuntos(premium, sinBase ? null : premiumAnt, 'mas_es_mejor', sinBase ?? (premiumAnt == null ? 'Sin lavados en el período anterior' : null))
  const conLavados = (serie ?? []).filter(p => p.lavados > 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 28, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{porcentaje(premium)}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>ÉLITE + SIGNATURE sobre el total</div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: COLOR_TONO[vPremium.tono] }}>{textoVariacion(vPremium)}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <BarraMix m={actual} etiqueta="Este período"/>
        {!sinBase && anterior.lavados > 0 && <BarraMix m={anterior} etiqueta="Período anterior"/>}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-secondary)' }}>
          {SERVICIOS.map(s => <span key={s.code}><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: s.color, marginRight: 5 }}/>{s.label}</span>)}
        </div>
      </div>

      <div className="table-wrap">
        <table className="corsa-table" style={{ border: 'none' }}>
          <thead>
            <tr>
              <th>Servicio</th>
              <th style={{ textAlign: 'right' }}>Lavados</th>
              <th style={{ textAlign: 'right' }}>% del mix</th>
              <th style={{ textAlign: 'right' }}>Ingresos</th>
              <th style={{ textAlign: 'right' }}>Promedio</th>
              <th style={{ textAlign: 'right' }}>vs anterior</th>
            </tr>
          </thead>
          <tbody>
            {SERVICIOS.map(s => {
              const a = actual.mix[s.code] ?? { lavados: 0, ingresos: 0, sin_cobro: 0 }
              const b = anterior.mix[s.code] ?? { lavados: 0, ingresos: 0, sin_cobro: 0 }
              // El promedio es sobre los lavados COBRADOS: un canje de $0 no
              // abarata el servicio.
              const promedio = dividir(a.ingresos, a.lavados - a.sin_cobro)
              const v = variacion(a.lavados, sinBase ? null : b.lavados, 'neutro', sinBase)
              return (
                <tr key={s.code}>
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: s.color, marginRight: 7 }}/>{s.label}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{entero(a.lavados)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{porcentaje(dividir(a.lavados, actual.lavados))}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(a.ingresos)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(promedio)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {v.relativa != null ? textoVariacion(v) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {conLavados.length >= 2 && (
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Evolución del mix</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 110 }}>
            {conLavados.map(p => (
              <div key={p.bucket} title={`${etiquetaFecha(p.bucket, granularidad)} · premium ${porcentaje(dividir(p.lavados_elite + p.lavados_signature, p.lavados))}`}
                   style={{ flex: 1, minWidth: 6, height: '100%', display: 'flex', flexDirection: 'column-reverse', borderRadius: 3, overflow: 'hidden', background: 'var(--subtle-bg)' }}>
                <div style={{ height: `${(p.lavados_pro / p.lavados) * 100}%`, background: 'var(--text-secondary)' }}/>
                <div style={{ height: `${(p.lavados_elite / p.lavados) * 100}%`, background: 'var(--corsa-orange)' }}/>
                <div style={{ height: `${(p.lavados_signature / p.lavados) * 100}%`, background: 'var(--corsa-green)' }}/>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            <span>{etiquetaFecha(conLavados[0]!.bucket, granularidad)}</span>
            <span>{etiquetaFecha(conLavados[conLavados.length - 1]!.bucket, granularidad)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
