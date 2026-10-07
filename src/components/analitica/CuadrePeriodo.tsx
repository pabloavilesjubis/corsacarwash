/**
 * Cuadre caja vs máquinas del período (bi_cuadre, 0076). El mismo criterio que
 * la tarjeta del Resumen del día: caja cuenta carros, la máquina cuenta ciclos
 * y deduce el tipo por la duración. Sólo desde la primera venta: antes el POS
 * no existía y «todo sin cobrar» no sería un hallazgo.
 */
import type { FilaCuadre } from '../../services/analitica.service'
import { etiquetaFecha } from '../../lib/analitica/periodos'
import { entero } from '../../lib/analitica/variacion'

const ORDEN = ['PRO', 'ELITE', 'SIGNATURE', 'SIN_CLASIFICAR']
const LABEL: Record<string, string> = { PRO: 'PRO', ELITE: 'ÉLITE', SIGNATURE: 'SIGNATURE', SIN_CLASIFICAR: 'Sin clasificar' }
/** Una diferencia diaria menor a esto es ruido (un carro que cruzó la medianoche). */
const UMBRAL_DIA = 2

const signo = (n: number) => (n > 0 ? `+${n}` : String(n))

export function CuadrePeriodo({ filas, desde }: { filas: FilaCuadre[]; desde: string | null }) {
  const validas = desde ? filas.filter(f => f.fecha >= desde) : []
  if (validas.length === 0) {
    return <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin días con caja y máquinas en el período para cuadrar.</div>
  }
  const porServicio = ORDEN.map(s => ({
    s, caja: validas.filter(f => f.servicio === s).reduce((n, f) => n + f.caja, 0),
    maquinas: validas.filter(f => f.servicio === s).reduce((n, f) => n + f.maquinas, 0),
  })).filter(x => x.caja > 0 || x.maquinas > 0)
  const totalCaja = porServicio.reduce((n, x) => n + x.caja, 0)
  const totalMaq = porServicio.reduce((n, x) => n + x.maquinas, 0)

  const dias = [...new Set(validas.map(f => f.fecha))].sort()
  const diferencias = dias.map(d => {
    const del = validas.filter(f => f.fecha === d)
    return { d, dif: del.reduce((n, f) => n + f.maquinas - f.caja, 0) }
  }).filter(x => Math.abs(x.dif) >= UMBRAL_DIA)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="table-wrap">
        <table className="corsa-table" style={{ border: 'none' }}>
          <thead>
            <tr>
              <th>Servicio</th>
              <th style={{ textAlign: 'right' }}>Caja</th>
              <th style={{ textAlign: 'right' }}>Máquinas</th>
              <th style={{ textAlign: 'right' }}>Diferencia</th>
            </tr>
          </thead>
          <tbody>
            {porServicio.map(x => (
              <tr key={x.s}>
                <td style={{ fontWeight: 600 }}>{LABEL[x.s] ?? x.s}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{entero(x.caja)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{entero(x.maquinas)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{x.maquinas === x.caja ? '—' : signo(x.maquinas - x.caja)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td style={{ fontWeight: 800 }}>Total</td>
              <td style={{ textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{entero(totalCaja)}</td>
              <td style={{ textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{entero(totalMaq)}</td>
              <td style={{ textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: totalMaq === totalCaja ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>
                {totalMaq === totalCaja ? '0' : signo(totalMaq - totalCaja)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        {diferencias.length === 0
          ? `Ningún día con diferencia de ${UMBRAL_DIA} lavados o más.`
          : <>Días con diferencia: {diferencias.map(x => `${etiquetaFecha(x.d)} (${signo(x.dif)})`).join(' · ')}. Positivo: la máquina lavó más de lo cobrado.</>}
        {' '}Desde {etiquetaFecha(desde!)}, primera venta registrada en el POS.
      </div>
    </div>
  )
}
