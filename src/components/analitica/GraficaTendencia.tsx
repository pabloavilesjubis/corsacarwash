/**
 * Evolución del negocio: facturación (barras, eje izquierdo) y lavados (línea,
 * eje derecho), con el período anterior detrás —barras tenues y línea
 * punteada— alineado por posición: el día 1 contra el día 1, la semana 1
 * contra la semana 1.
 *
 * SVG a mano, como las demás gráficas de CORSA: escala con el ancho y toma
 * los colores de los tokens del tema.
 */
import { useState } from 'react'
import type { PuntoSerie } from '../../services/analitica.service'
import { etiquetaFecha, type Granularidad } from '../../lib/analitica/periodos'
import { dinero, entero } from '../../lib/analitica/variacion'

const W = 800, H = 250, M = { top: 14, right: 44, bottom: 30, left: 58 }

function tope(n: number): number {
  if (n <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(n)))
  const f = n / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}

export function GraficaTendencia({ actual, anterior, granularidad }: {
  actual: PuntoSerie[]
  anterior: PuntoSerie[]
  granularidad: Granularidad
}) {
  const [foco, setFoco] = useState<number | null>(null)
  const n = actual.length
  const maxV = tope(Math.max(...actual.map(p => p.ventas), ...anterior.slice(0, n).map(p => p.ventas), 0))
  const maxL = tope(Math.max(...actual.map(p => p.lavados), ...anterior.slice(0, n).map(p => p.lavados), 0))
  const ancho = (W - M.left - M.right) / Math.max(n, 1)
  const x = (i: number) => M.left + ancho * i + ancho / 2
  const yV = (v: number) => H - M.bottom - (v / maxV) * (H - M.top - M.bottom)
  const yL = (v: number) => H - M.bottom - (v / maxL) * (H - M.top - M.bottom)
  const barra = Math.max(2, Math.min(34, ancho * 0.62))
  const cadaCuanto = Math.max(1, Math.ceil(n / 10))
  const linea = (s: PuntoSerie[]) => s.slice(0, n).map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${yL(p.lavados).toFixed(1)}`).join(' ')
  const p = foco != null ? actual[foco] : null
  const pa = foco != null ? anterior[foco] : null

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--corsa-green)', borderRadius: 2, marginRight: 5 }}/>Facturación</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 3, background: 'var(--corsa-orange)', borderRadius: 2, marginRight: 5, verticalAlign: 'middle' }}/>Lavados</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--border)', borderRadius: 2, marginRight: 5 }}/>Período anterior</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
           aria-label="Facturación y lavados por período, contra el período anterior"
           onMouseLeave={() => setFoco(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={M.left} x2={W - M.right} y1={yV(maxV * f)} y2={yV(maxV * f)} style={{ stroke: 'var(--border)' }} strokeWidth={1}/>
            <text x={M.left - 8} y={yV(maxV * f) + 4} textAnchor="end" fontSize={11} style={{ fill: 'var(--text-secondary)' }}>{f === 0 ? '0' : '$' + Math.round(maxV * f).toLocaleString('en-US')}</text>
            <text x={W - M.right + 8} y={yL(maxL * f) + 4} fontSize={11} style={{ fill: 'var(--text-secondary)' }}>{Math.round(maxL * f)}</text>
          </g>
        ))}
        {actual.map((pt, i) => {
          const ant = anterior[i]
          return (
            <g key={pt.bucket} onMouseEnter={() => setFoco(i)} onClick={() => setFoco(i)}>
              <rect x={M.left + ancho * i} y={M.top} width={ancho} height={H - M.top - M.bottom} style={{ fill: foco === i ? 'var(--subtle-bg)' : 'transparent' }}/>
              {ant && ant.ventas > 0 && (
                <rect x={x(i) - barra / 2 - 3} y={yV(ant.ventas)} width={barra} height={H - M.bottom - yV(ant.ventas)} rx={2} style={{ fill: 'var(--border)' }}/>
              )}
              {pt.ventas > 0 && (
                <rect x={x(i) - barra / 2 + 3} y={yV(pt.ventas)} width={barra} height={H - M.bottom - yV(pt.ventas)} rx={2} style={{ fill: 'var(--corsa-green)' }}/>
              )}
              {i % cadaCuanto === 0 && (
                <text x={x(i)} y={H - 10} textAnchor="middle" fontSize={11} style={{ fill: 'var(--text-secondary)' }}>{etiquetaFecha(pt.bucket, granularidad)}</text>
              )}
            </g>
          )
        })}
        {anterior.length > 0 && (
          <path d={linea(anterior)} fill="none" strokeWidth={1.5} strokeDasharray="4 4" style={{ stroke: 'var(--text-secondary)', opacity: 0.6 }} pointerEvents="none"/>
        )}
        <path d={linea(actual)} fill="none" strokeWidth={2.5} style={{ stroke: 'var(--corsa-orange)' }} pointerEvents="none"/>
        {actual.map((pt, i) => (
          <circle key={pt.bucket} cx={x(i)} cy={yL(pt.lavados)} r={foco === i ? 4.5 : 3} style={{ fill: 'var(--corsa-orange)' }} pointerEvents="none"/>
        ))}
      </svg>
      <div style={{ minHeight: 20, fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>
        {p ? (
          <>
            <strong style={{ color: 'var(--text-primary)' }}>{etiquetaFecha(p.bucket, granularidad)}</strong>
            {' · '}{dinero(p.ventas)} · {entero(p.lavados)} lavados
            {pa && <> · anterior: {dinero(pa.ventas)} · {entero(pa.lavados)} lavados</>}
          </>
        ) : 'Tocá o pasá el cursor sobre un período para ver el detalle.'}
      </div>
    </div>
  )
}
