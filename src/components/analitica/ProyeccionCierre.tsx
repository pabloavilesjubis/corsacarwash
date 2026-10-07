/**
 * Proyección de cierre del mes en curso (bi_proyeccion, 0075).
 *
 * El ritmo es el promedio de los días operativos COMPLETOS del mes (desde la
 * primera venta, si el POS empezó a mitad de mes). La meta y los días que
 * abre CORSA se configuran acá mismo, para quien tenga settings.manage.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import type { Proyeccion } from '../../services/analitica.service'
import { fetchCalendario, guardarCalendario, guardarMeta } from '../../services/analitica.service'
import { dinero, dividir, entero, porcentaje } from '../../lib/analitica/variacion'
import { diasDe } from '../../lib/analitica/periodos'

const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

function Dato({ label, valor, sub }: { label: string; valor: string; sub?: string | null }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 20, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{valor}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Avance({ label, actual, meta, proyeccion, formato }: {
  label: string; actual: number; meta: number; proyeccion: number | null; formato: (n: number) => string
}) {
  const f = Math.min(1, actual / meta)
  const fp = proyeccion != null ? Math.min(1, proyeccion / meta) : null
  const llega = proyeccion != null && proyeccion >= meta
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5, gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{label}: {porcentaje(actual / meta, 0)} de {formato(meta)}</span>
        {proyeccion != null && (
          <span style={{ color: llega ? 'var(--color-success-text)' : 'var(--color-warning-text)', fontWeight: 600 }}>
            {llega ? 'Al ritmo actual se alcanza' : `Al ritmo actual cierra en ${porcentaje(proyeccion / meta, 0)}`}
          </span>
        )}
      </div>
      <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'var(--subtle-bg)', overflow: 'hidden' }}>
        {fp != null && <div style={{ position: 'absolute', inset: 0, width: `${fp * 100}%`, background: 'var(--border)' }}/>}
        <div style={{ position: 'absolute', inset: 0, width: `${f * 100}%`, background: 'var(--corsa-green)' }}/>
      </div>
    </div>
  )
}

function Configuracion({ orgId, proyeccion, onGuardado }: { orgId: string; proyeccion: Proyeccion; onGuardado: () => void }) {
  const [ventas, setVentas] = useState(proyeccion.meta_ventas != null ? String(proyeccion.meta_ventas) : '')
  const [lavados, setLavados] = useState(proyeccion.meta_lavados != null ? String(proyeccion.meta_lavados) : '')
  const [abiertos, setAbiertos] = useState<number[] | null>(null)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => { fetchCalendario().then(c => setAbiertos(c ?? [0, 1, 2, 3, 4, 5, 6])).catch(() => setAbiertos([0, 1, 2, 3, 4, 5, 6])) }, [])

  const guardar = async () => {
    const v = ventas.trim() ? Number(ventas) : null
    const l = lavados.trim() ? Number(lavados) : null
    if ((v != null && !(v > 0)) || (l != null && !(Number.isInteger(l) && l > 0))) {
      toast.error('Las metas tienen que ser mayores que cero (los lavados, un número entero)'); return
    }
    if (abiertos && abiertos.length === 0) { toast.error('Marcá al menos un día operativo'); return }
    setGuardando(true)
    try {
      await guardarMeta(orgId, proyeccion.mes, v, l)
      if (abiertos) await guardarCalendario(orgId, abiertos)
      toast.success('Meta y días operativos guardados')
      onGuardado()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar')
    }
    setGuardando(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 12 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 160px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Meta de ventas del mes (US$)</span>
          <input className="corsa-input" type="number" min="1" step="100" value={ventas} onChange={e => setVentas(e.target.value)} placeholder="Sin meta"/>
        </label>
        <label className="field" style={{ flex: '1 1 160px' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Meta de lavados del mes</span>
          <input className="corsa-input" type="number" min="1" step="10" value={lavados} onChange={e => setLavados(e.target.value)} placeholder="Sin meta"/>
        </label>
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>Días que abre CORSA</div>
        <div className="filter-pills">
          {DIAS.map((d, i) => {
            const on = abiertos?.includes(i) ?? false
            return (
              <button key={d} type="button" className={`filter-pill${on ? ' active' : ''}`} disabled={!abiertos}
                      onClick={() => setAbiertos(a => a ? (a.includes(i) ? a.filter(x => x !== i) : [...a, i].sort()) : a)}>{d}</button>
            )
          })}
        </div>
      </div>
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={guardar} disabled={guardando}>
        {guardando ? 'Guardando…' : 'Guardar'}
      </button>
    </div>
  )
}

export function ProyeccionCierre({ p, orgId, puedeConfigurar, onRecargar }: {
  p: Proyeccion
  orgId: string
  puedeConfigurar: boolean
  onRecargar: () => void
}) {
  const [configurando, setConfigurando] = useState(false)
  const transcurridos = diasDe({ desde: p.mes, hasta: p.hoy })
  const faltaVentas = p.meta_ventas != null ? Math.max(0, p.meta_ventas - p.ventas_acumuladas) : null
  const faltaLavados = p.meta_lavados != null ? Math.max(0, p.meta_lavados - p.lavados_acumulados) : null
  const sinRitmo = p.ventas_por_dia == null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
        <Dato label="Ventas acumuladas" valor={dinero(p.ventas_acumuladas)}/>
        <Dato label="Lavados acumulados" valor={entero(p.lavados_acumulados)}/>
        <Dato label="Promedio diario" valor={dinero(p.ventas_por_dia)}
              sub={p.lavados_por_dia != null ? `${p.lavados_por_dia.toFixed(1)} lavados por día operativo` : null}/>
        <Dato label="Proyección de ventas" valor={dinero(p.proyeccion_ventas, 0)}/>
        <Dato label="Proyección de lavados" valor={entero(p.proyeccion_lavados)}/>
        <Dato label="Días" valor={`${transcurridos} / ${diasDe({ desde: p.mes, hasta: p.fin_de_mes })}`}
              sub={`${p.dias_restantes} operativos por delante, contando hoy`}/>
      </div>

      {sinRitmo && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Todavía no hay un día operativo completo con ventas este mes: la proyección aparece desde mañana.
        </div>
      )}

      {p.meta_ventas != null && <Avance label="Ventas" actual={p.ventas_acumuladas} meta={p.meta_ventas} proyeccion={p.proyeccion_ventas} formato={n => dinero(n, 0)}/>}
      {p.meta_lavados != null && <Avance label="Lavados" actual={p.lavados_acumulados} meta={p.meta_lavados} proyeccion={p.proyeccion_lavados} formato={entero}/>}

      {(faltaVentas != null || faltaLavados != null) && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Ritmo necesario para la meta:{' '}
          {p.dias_restantes > 0 ? (
            <strong style={{ color: 'var(--text-primary)' }}>
              {[faltaVentas != null ? `${dinero(dividir(faltaVentas, p.dias_restantes))} por día` : null,
                faltaLavados != null ? `${entero(dividir(faltaLavados, p.dias_restantes))} lavados por día` : null].filter(Boolean).join(' · ')}
            </strong>
          ) : 'no quedan días operativos este mes.'}
        </div>
      )}

      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Promedio de los días operativos completos{p.promedio_desde && p.promedio_desde !== p.mes ? ` desde el ${p.promedio_desde.slice(8)} (primera venta del mes en el sistema)` : ''}, multiplicado por los días operativos que faltan.{' '}
        {p.calendario_configurado ? 'Días operativos según la configuración.' : 'Días operativos deducidos de la actividad de las últimas 8 semanas (no hay calendario configurado).'}
        {p.meta_ventas == null && p.meta_lavados == null && ' Sin meta configurada para este mes.'}
      </div>

      {puedeConfigurar && (
        configurando
          ? <Configuracion orgId={orgId} proyeccion={p} onGuardado={() => { setConfigurando(false); onRecargar() }}/>
          : <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setConfigurando(true)}>Configurar meta y días operativos</button>
      )}
    </div>
  )
}
