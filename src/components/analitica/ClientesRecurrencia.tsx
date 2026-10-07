/**
 * Clientes y recurrencia (bi_clientes, 0076). Sólo clientes identificados:
 * los lavados a Consumidor Final se informan como proporción y no entran en
 * ninguna métrica, porque mezclarlos haría parecer que nadie vuelve.
 *
 * Un porcentaje con menos de MUESTRA_MINIMA casos no se muestra: con tres
 * clientes, «67% de recurrencia» es ruido.
 */
import type { ClientesPeriodo } from '../../services/analitica.service'
import { dinero, dividir, entero, porcentaje, textoVariacion, variacion, type Variacion } from '../../lib/analitica/variacion'

const MUESTRA_MINIMA = 10

const COLOR_TONO = { bueno: 'var(--color-success-text)', malo: 'var(--color-danger-text)', neutro: 'var(--text-secondary)' }

function Celda({ label, valor, sub, v }: { label: string; valor: string; sub?: string | null; v?: Variacion | null }) {
  return (
    <div style={{ minWidth: 0, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{valor}</div>
      {v && v.relativa != null && <div style={{ fontSize: 11.5, fontWeight: 600, color: COLOR_TONO[v.tono] }}>{textoVariacion(v)}</div>}
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export function ClientesRecurrencia({ actual, anterior, sinBase }: {
  actual: ClientesPeriodo
  anterior: ClientesPeriodo
  sinBase: string | null
}) {
  const a = actual, b = anterior
  const comp = (x: number, y: number) => variacion(x, sinBase ? null : y, 'mas_es_mejor', sinBase)
  const anonimos = dividir(a.lavados - a.lavados_identificados, a.lavados)
  const pctRecurrentes = a.clientes_activos >= MUESTRA_MINIMA ? dividir(a.clientes_recurrentes, a.clientes_activos) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {anonimos != null && anonimos > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {porcentaje(anonimos, 0)} de los lavados del período fueron a Consumidor Final y no entran en estas métricas
          ({entero(a.lavados_identificados)} de {entero(a.lavados)} lavados tienen cliente).
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <Celda label="Clientes activos" valor={entero(a.clientes_activos)} v={comp(a.clientes_activos, b.clientes_activos)}/>
        <Celda label="Nuevos" valor={entero(a.clientes_nuevos)} sub="Primer lavado en el período" v={comp(a.clientes_nuevos, b.clientes_nuevos)}/>
        <Celda label="Recurrentes" valor={entero(a.clientes_recurrentes)} sub="Ya habían lavado antes" v={comp(a.clientes_recurrentes, b.clientes_recurrentes)}/>
        <Celda label="% recurrentes" valor={pctRecurrentes == null ? '—' : porcentaje(pctRecurrentes, 0)}
               sub={pctRecurrentes == null ? `Muestra insuficiente (menos de ${MUESTRA_MINIMA} clientes)` : null}/>
        <Celda label="Lavados por cliente" valor={dividir(a.lavados_identificados, a.clientes_activos)?.toFixed(1) ?? '—'} sub="Visita = carro lavado"/>
        <Celda label="Días entre lavados" valor={a.brechas >= 5 && a.dias_entre_lavados != null ? a.dias_entre_lavados.toFixed(1) : '—'}
               sub={a.brechas >= 5 ? `${entero(a.brechas)} regresos medidos` : 'Muy pocos regresos para promediar'}/>
        <Celda label="Gasto por cliente" valor={dinero(dividir(a.ventas_identificadas, a.clientes_activos))}
               v={variacion(dividir(a.ventas_identificadas, a.clientes_activos), sinBase ? null : dividir(b.ventas_identificadas, b.clientes_activos), 'mas_es_mejor', sinBase)}/>
        <Celda label="Vehículos que repiten" valor={`${entero(a.vehiculos_que_repiten)} / ${entero(a.vehiculos_activos)}`} sub="Placas con más de un día de lavado"/>
      </div>

      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Retención</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {(['30', '60', '90'] as const).map(n => {
            const r = a.retencion[n]
            const ok = r && r.cohorte >= MUESTRA_MINIMA
            return (
              <div key={n} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>A {n} días</div>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 22, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                  {ok ? porcentaje(r.retenidos / r.cohorte, 0) : '—'}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {ok ? `${entero(r.retenidos)} de ${entero(r.cohorte)} volvieron` : `Muestra insuficiente (${entero(r?.cohorte ?? 0)} clientes con ${n} días cumplidos)`}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <details style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Cómo se calcula</summary>
        <div style={{ marginTop: 6 }}>
          <b>Activo</b>: al menos un lavado en el período. <b>Nuevo</b>: su primer lavado de toda la historia cae en el período.
          {' '}<b>Recurrente</b>: activo, con un lavado anterior al período. <b>Retenido a N días</b>: de los clientes cuyo primer
          lavado del período fue el día d, los que volvieron a lavar entre d+1 y d+N; sólo cuentan quienes ya cumplieron d+N.
          {' '}<b>Días entre lavados</b>: brecha entre días distintos de lavado del mismo cliente. <b>Gasto por cliente</b>: ventas a
          clientes identificados ÷ clientes activos. Un lavado es un carro: una factura con tres carros son tres lavados.
        </div>
      </details>
    </div>
  )
}
