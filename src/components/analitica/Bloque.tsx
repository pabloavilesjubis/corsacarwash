/**
 * Una sección de Inteligencia de negocio: la misma tarjeta que el Resumen del
 * día (surface, borde, radio 12, título en la tipografía de encabezados), con
 * sus tres estados resueltos acá para que ninguna sección muestre NaN o un
 * cero que en realidad es «no cargó».
 */
import type { ReactNode } from 'react'

export function Bloque({ titulo, subtitulo, accion, id, children }: {
  titulo: string
  subtitulo?: ReactNode
  accion?: ReactNode
  id?: string
  children: ReactNode
}) {
  return (
    <section id={id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>{titulo}</div>
          {subtitulo && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{subtitulo}</div>}
        </div>
        {accion}
      </div>
      {children}
    </section>
  )
}

export function Esqueleto({ alto = 180, filas }: { alto?: number; filas?: number }) {
  if (filas) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true" aria-label="Cargando">
        {Array.from({ length: filas }, (_, i) => <div key={i} className="bi-skeleton" style={{ height: 18, width: `${90 - i * 8}%` }}/>)}
      </div>
    )
  }
  return <div className="bi-skeleton" style={{ height: alto }} aria-busy="true" aria-label="Cargando"/>
}

export function Vacio({ titulo, detalle }: { titulo: string; detalle?: ReactNode }) {
  return (
    <div className="empty-state" style={{ padding: '24px 12px' }}>
      <div className="empty-state-title">{titulo}</div>
      {detalle && <div className="empty-state-sub">{detalle}</div>}
    </div>
  )
}

export function ErrorBloque({ mensaje, onReintentar }: { mensaje: string; onReintentar?: () => void }) {
  return (
    <div className="alert-banner danger">
      <div className="alert-body">
        <div className="alert-desc">{mensaje}</div>
        {onReintentar && (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={onReintentar}>Reintentar</button>
        )}
      </div>
    </div>
  )
}
