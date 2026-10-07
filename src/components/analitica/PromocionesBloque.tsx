/**
 * Cupones y promociones del período (bi_promociones, 0077).
 *
 * Un cupón prepagado es plata cobrada por adelantado, no un descuento: se
 * cuenta el día de la venta y su canje es un lavado de $0. Por eso no hay
 * «ticket con cupón contra sin cupón». Tampoco hay campañas ni descuentos:
 * el POS todavía no registra ninguno.
 */
import type { Promociones } from '../../services/analitica.service'
import { dinero, dividir, entero, porcentaje } from '../../lib/analitica/variacion'

function Dato({ label, valor, sub }: { label: string; valor: string; sub?: string | null }) {
  return (
    <div style={{ minWidth: 0, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{valor}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export function PromocionesBloque({ p }: { p: Promociones }) {
  const c = p.cupones, s = p.seguros
  const hayCupones = c.vendidos + c.regalados + c.canjeados + c.pendiente_cantidad > 0
  const haySeguros = s.vendidos + s.cortesias + s.canjeados_en_periodo > 0
  const tasa = dividir(c.vendidos_canjeados, c.vendidos - c.vendidos_anulados)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Cupones prepagados</div>
        {hayCupones ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <Dato label="Vendidos" valor={entero(c.vendidos)} sub={`${entero(c.lotes_vendidos)} ventas · ${dinero(c.monto_vendido)}`}/>
            <Dato label="Regalados" valor={entero(c.regalados)}/>
            <Dato label="Canjeados" valor={entero(c.canjeados)} sub={`Valor ${dinero(c.valor_canjeado)}`}/>
            <Dato label="Tasa de canje" valor={porcentaje(tasa, 0)} sub="De los vendidos en el período, ya canjeados"/>
            <Dato label="Pendiente de canje" valor={dinero(c.pendiente_valor)} sub={`${entero(c.pendiente_cantidad)} cupones activos hoy`}/>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin cupones vendidos, regalados ni canjeados en el período.</div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Seguro de lluvia</div>
        {haySeguros ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <Dato label="Vendidos" valor={entero(s.vendidos)} sub={dinero(s.monto)}/>
            <Dato label="Cortesías" valor={entero(s.cortesias)}/>
            <Dato label="Canjeados" valor={entero(s.canjeados_en_periodo)} sub={`${entero(s.canjeados)} de los emitidos en el período`}/>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin seguros de lluvia en el período.</div>
        )}
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Un cupón prepagado se cobra al venderlo; su canje es un lavado sin cobro, por eso no se compara el ticket con y sin cupón.
        {p.descuentos > 0 ? ` Descuentos aplicados en ventas: ${dinero(p.descuentos)}.` : ' El POS todavía no registra descuentos ni campañas: cuando existan, se medirán acá.'}
      </div>
    </div>
  )
}
