/**
 * Oportunidades: los mensajes que superan los umbrales de lib/analitica/insights.
 * Si nada cambió lo suficiente, lo dice en una línea en vez de llenar la
 * pantalla de variaciones insignificantes.
 */
import type { Insight } from '../../lib/analitica/insights'

const TONO = {
  positivo: { color: 'var(--color-success-text)', fondo: 'var(--color-success-tint)', marca: '▲' },
  alerta:   { color: 'var(--color-warning-text)', fondo: 'var(--color-warning-tint)', marca: '!' },
  info:     { color: 'var(--text-secondary)',     fondo: 'var(--subtle-bg)',          marca: 'i' },
}

export function Oportunidades({ insights, incompleto }: { insights: Insight[]; incompleto: boolean }) {
  if (insights.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        {incompleto ? 'Cargando los datos del período…' : 'Sin variaciones relevantes en este período.'}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {insights.map(i => {
        const t = TONO[i.tono]
        return (
          <div key={i.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10 }}>
            <div aria-hidden style={{ flex: '0 0 auto', width: 24, height: 24, borderRadius: 6, background: t.fondo, color: t.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800 }}>{t.marca}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{i.categoria}</div>
              <div style={{ fontSize: 13.5, color: 'var(--text-primary)', marginTop: 2, lineHeight: 1.45 }}>{i.texto}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
