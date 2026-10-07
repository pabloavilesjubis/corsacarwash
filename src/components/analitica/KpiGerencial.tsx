/**
 * KPI de Inteligencia de negocio. Mismo aspecto que las tarjetas del Resumen
 * del día; la diferencia es que el color de la variación sale del SENTIDO del
 * indicador (variacion.ts), no de si la flecha sube o baja.
 */
import { textoVariacion, type Variacion } from '../../lib/analitica/variacion'

const COLORES = {
  bueno:  { color: 'var(--color-success-text)', fondo: 'var(--color-success-tint)' },
  malo:   { color: 'var(--color-danger-text)',  fondo: 'var(--color-danger-tint)' },
  neutro: { color: 'var(--text-secondary)',     fondo: 'var(--subtle-bg)' },
}

export function KpiGerencial({ label, valor, variacion, sub, cargando, id }: {
  label: string
  valor: string
  variacion?: Variacion | null
  sub?: string | null
  cargando?: boolean
  id?: string
}) {
  const hayCambio = variacion && (variacion.relativa != null || variacion.puntos != null)
  const cambio = variacion?.relativa ?? variacion?.puntos ?? 0
  const c = COLORES[variacion?.tono ?? 'neutro']
  return (
    <div id={id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, minWidth: 0 }}>
      <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>{label}</div>
      {cargando ? (
        <>
          <div className="bi-skeleton" style={{ height: 34, width: '70%', marginTop: 10 }}/>
          <div className="bi-skeleton" style={{ height: 16, width: '45%', marginTop: 10 }}/>
        </>
      ) : (
        <>
          <div style={{ marginTop: 8, fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 30, fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)', lineHeight: 1.1, overflowWrap: 'anywhere' }}>{valor}</div>
          {variacion && (
            hayCambio ? (
              <div title="Contra el período anterior" style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: c.color, background: c.fondo, padding: '3px 8px', borderRadius: 4 }}>
                {cambio > 0 ? '▲' : cambio < 0 ? '▼' : '•'} {textoVariacion(variacion)}
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>{textoVariacion(variacion)}</div>
            )
          )}
          {sub && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-secondary)' }}>{sub}</div>}
        </>
      )}
    </div>
  )
}
