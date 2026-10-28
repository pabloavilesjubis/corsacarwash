/**
 * Elegir el cliente en el POS administrativo: buscarlo en la base o darlo de
 * alta con el mismo formulario rápido de la caja.
 */
import { useEffect, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { ModalNuevoCliente } from '../pos/AltaRapida'
import { buscarClientes, cargarCliente, nombreCliente, type ClienteAdmin } from '../../lib/posAdmin/cliente'

export function BuscadorCliente({ cliente, onElegir, conAlta }: {
  cliente: ClienteAdmin | null
  onElegir: (c: ClienteAdmin | null) => void
  /** Muestra «+ Nuevo cliente». */
  conAlta?: boolean
}) {
  const { profile } = useAuth()
  const orgId = (profile as any)?.organization_id ?? null
  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState<ClienteAdmin[]>([])
  const [alta, setAlta] = useState(false)

  useEffect(() => {
    if (cliente || query.trim().length < 2) { setResultados([]); return }
    let vivo = true
    const t = setTimeout(() => { buscarClientes(query).then(r => { if (vivo) setResultados(r) }) }, 300)
    return () => { vivo = false; clearTimeout(t) }
  }, [query, cliente])

  if (cliente) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 14, border: '1.5px solid var(--corsa-green)', background: 'rgba(2,53,48,0.05)', marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{nombreCliente(cliente)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {[cliente.nit ? `NIT ${cliente.nit}` : cliente.dui ? `DUI ${cliente.dui}` : null, cliente.billing_email || cliente.email]
              .filter(Boolean).join(' · ') || 'Sin datos de contacto'}
          </div>
        </div>
        <button onClick={() => { onElegir(null); setQuery('') }} aria-label="Quitar cliente"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>×</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
      <div style={{ position: 'relative', flex: 1 }}>
        <input className="corsa-input" value={query} onChange={e => setQuery(e.target.value)}
               placeholder="Buscá por nombre, razón social, NIT o DUI…" autoFocus/>
        {resultados.length > 0 && (
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', maxHeight: 240, overflowY: 'auto' }}>
            {resultados.map(c => (
              <button key={c.id} onClick={() => { onElegir(c); setResultados([]) }}
                style={{ width: '100%', textAlign: 'left', padding: '9px 13px', border: 'none', background: 'transparent', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{nombreCliente(c)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {c.nit ? `NIT ${c.nit}` : c.dui ? `DUI ${c.dui}` : c.customer_type === 'company' ? 'Empresa' : 'Persona'}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {conAlta && orgId && (
        <button className="btn btn-ghost" onClick={() => setAlta(true)} style={{ whiteSpace: 'nowrap' }}>+ Nuevo cliente</button>
      )}
      {alta && orgId && (
        <ModalNuevoCliente orgId={orgId} onCancelar={() => setAlta(false)}
          onCreado={async c => { setAlta(false); onElegir(await cargarCliente(c.id)) }}/>
      )}
    </div>
  )
}
