/**
 * CORSA Carwash — los 10 clientes con más lavados.
 *
 * Acumulado desde el inicio, no sólo hoy: cuenta cada lavado (PRO, ÉLITE,
 * SIGNATURE) de órdenes no anuladas, al contado o al crédito, con un lavado
 * por carro en las órdenes de varios. Lo cuenta la base (v_customer_metrics,
 * 0072); acá sólo se muestra. Las ventas a Consumidor Final no tienen cliente
 * al que sumarlas.
 */
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

interface FilaTop {
  customer_id: string
  display_name: string
  total_washes: number
  total_orders: number
  days_since_last_visit: number | null
}

function ultimaVisita(dias: number | null): string {
  if (dias == null) return '—'
  if (dias === 0) return 'Hoy'
  if (dias === 1) return 'Ayer'
  return `Hace ${dias} d`
}

export function TopClientesLavados() {
  const [filas, setFilas] = useState<FilaTop[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let vivo = true
    ;(supabase as any)
      .from('v_customer_metrics')
      .select('customer_id, display_name, total_washes, total_orders, days_since_last_visit')
      .gt('total_washes', 0)
      .order('total_washes', { ascending: false })
      .order('display_name', { ascending: true })
      .limit(10)
      .then(({ data, error: e }: { data: FilaTop[] | null; error: unknown }) => {
        if (!vivo) return
        if (e) { setError(true); setFilas([]); return }
        setFilas(data ?? [])
      })
    return () => { vivo = false }
  }, [])

  const max = Math.max(1, ...(filas ?? []).map(f => Number(f.total_washes)))

  return (
    <div id="top-clientes-lavados" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>10 clientes con más lavados</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Acumulado · contado y crédito</div>
      </div>

      {filas === null ? (
        <div className="loading-center"><div className="spinner"/></div>
      ) : filas.length === 0 ? (
        <div className="empty-state"><div className="empty-state-sub">
          {error ? 'No se pudieron cargar los lavados por cliente.' : 'Todavía no hay lavados registrados a nombre de un cliente.'}
        </div></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filas.map((f, i) => (
            <div key={f.customer_id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 22, textAlign: 'right', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span className="truncate" title={f.display_name} style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{f.display_name}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    Última visita: {ultimaVisita(f.days_since_last_visit)}
                  </span>
                </div>
                <div style={{ marginTop: 4, height: 5, borderRadius: 3, background: 'var(--subtle-bg)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(Number(f.total_washes) / max) * 100}%`, background: 'var(--corsa-green)', borderRadius: 3 }}/>
                </div>
              </div>
              <div style={{ width: 44, textAlign: 'right', fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 17, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                {f.total_washes}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
