/**
 * Editor de precios negociados: PRO, ÉLITE y SIGNATURE (único o por tamaño)
 * más el aspirado. Lo usan las flotillas (0050) y los grupos empresariales
 * (0054), que negocian con el mismo modelo.
 */
import { SERVICIOS_FLOTILLA, type LineasEditables } from '../lib/flotillas/precios'

export function EditorPrecios({ lineas, setLineas, aspirado, setAspirado }: {
  lineas: LineasEditables
  setLineas: (f: (l: LineasEditables) => LineasEditables) => void
  aspirado: { activo: boolean; precio: string }
  setAspirado: (a: { activo: boolean; precio: string }) => void
}) {
  const cambiar = (codigo: keyof LineasEditables, campo: string, valor: string | boolean) =>
    setLineas(l => ({ ...l, [codigo]: { ...l[codigo], [campo]: valor } }))

  const montoInput = (valor: string, onChange: (v: string) => void, label?: string) => (
    <div className="field" style={{ flex: 1, minWidth: 0 }}>
      {label && <label>{label}</label>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>$</span>
        <input className="corsa-input" type="number" step="0.50" min="0" value={valor} onChange={e => onChange(e.target.value)}/>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {SERVICIOS_FLOTILLA.map(({ codigo, nombre }) => {
        const l = lineas[codigo]
        return (
          <div key={codigo} style={{ border: `1.5px solid ${l.activo ? 'var(--corsa-green)' : 'var(--border)'}`, borderRadius: 12, padding: '10px 12px', background: l.activo ? 'var(--surface)' : 'var(--subtle-bg)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', flex: 1 }}>
                <input type="checkbox" id={`linea-${codigo}`} checked={l.activo}
                       onChange={e => cambiar(codigo, 'activo', e.target.checked)}
                       style={{ accentColor: 'var(--corsa-green)' }}/>
                <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, color: l.activo ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{nombre}</span>
              </label>
              {l.activo && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={l.porTamano}
                         onChange={e => cambiar(codigo, 'porTamano', e.target.checked)}
                         style={{ accentColor: 'var(--corsa-green)' }}/>
                  Precio por tamaño
                </label>
              )}
            </div>
            {l.activo && (
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                {l.porTamano ? (<>
                  {montoInput(l.S, v => cambiar(codigo, 'S', v), 'S · Pequeño')}
                  {montoInput(l.M, v => cambiar(codigo, 'M', v), 'M · Mediano')}
                  {montoInput(l.L, v => cambiar(codigo, 'L', v), 'L · Grande')}
                </>) : (
                  <div style={{ maxWidth: 200, flex: 1 }}>{montoInput(l.unico, v => cambiar(codigo, 'unico', v), 'Cualquier tamaño')}</div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <div style={{ marginTop: 4 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
          <input type="checkbox" checked={aspirado.activo}
                 onChange={e => setAspirado({ ...aspirado, activo: e.target.checked })}
                 style={{ accentColor: 'var(--corsa-green)' }}/>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Incluir aspirado de interiores</span>
        </label>
        {aspirado.activo && (
          <div style={{ marginTop: 10, maxWidth: 200 }}>
            {montoInput(aspirado.precio, v => setAspirado({ ...aspirado, precio: v }), 'Aspirado · cualquier tamaño')}
          </div>
        )}
      </div>
    </div>
  )
}
