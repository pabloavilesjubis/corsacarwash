/**
 * Pestaña «Productos y servicios» del POS administrativo (0081): lo que se
 * puede facturar desde ahí y que no es un lavado. Sólo la ve quien tiene el
 * POS administrativo; la caja nunca lo ofrece.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import {
  activarItem, guardarItem, listarCatalogo, problemaDeItem, type DatosItem, type ItemCatalogo,
} from '../../lib/posAdmin/catalogo'

const money = (n: number) => 'US$' + n.toFixed(2)

function ItemModal({ item, orgId, onGuardado, onCerrar }: {
  item: ItemCatalogo | null; orgId: string; onGuardado: () => void; onCerrar: () => void
}) {
  const [d, setD] = useState<DatosItem>(() => ({
    name: item?.name ?? '',
    description: item?.description ?? '',
    item_type: item?.item_type ?? 'servicio',
    default_price: item?.default_price != null ? item.default_price.toFixed(2) : '',
    active: item?.active ?? true,
  }))
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar])

  const guardar = async () => {
    const problema = problemaDeItem(d)
    if (problema) { toast.error(problema); return }
    setGuardando(true)
    try {
      await guardarItem(orgId, d, item?.id)
      toast.success(item ? 'Cambios guardados ✓' : `${d.item_type === 'producto' ? 'Producto' : 'Servicio'} agregado ✓`)
      onGuardado()
    } catch (err: any) {
      toast.error(err?.message ?? 'No se pudo guardar')
    }
    setGuardando(false)
  }

  return createPortal(
    <div onClick={e => { if (e.target === e.currentTarget) onCerrar() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>
            {item ? 'Editar' : 'Nuevo producto o servicio'}
          </div>
          <button onClick={onCerrar} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="panel-section-label">Tipo</div>
            <div className="filter-pills">
              {([['servicio', 'Servicio'], ['producto', 'Producto']] as const).map(([id, label]) => (
                <button key={id} type="button" className={`filter-pill${d.item_type === id ? ' active' : ''}`}
                        onClick={() => setD({ ...d, item_type: id })}>{label}</button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6 }}>
              Un producto sale en el DTE como bien; un servicio, como servicio.
            </div>
          </div>
          <div className="field">
            <label>Nombre *</label>
            <input className="corsa-input" value={d.name} maxLength={120} autoFocus
                   placeholder={d.item_type === 'producto' ? 'Ambientador, shampoo para auto…' : 'Pulido de faros, lavado de tapicería…'}
                   onChange={e => setD({ ...d, name: e.target.value })}/>
          </div>
          <div className="field">
            <label>Descripción</label>
            <input className="corsa-input" value={d.description} maxLength={300}
                   onChange={e => setD({ ...d, description: e.target.value })}/>
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label>Precio sugerido (con IVA)</label>
            <input className="corsa-input" type="number" step="0.01" min="0" value={d.default_price}
                   placeholder="Opcional" onChange={e => setD({ ...d, default_price: e.target.value })}/>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            El precio se puede cambiar al facturar. En un CCF el IVA se desglosa solo.
          </div>
          {item && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={d.active} onChange={e => setD({ ...d, active: e.target.checked })}/>
              Activo (se puede facturar)
            </label>
          )}
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCerrar} className="btn btn-ghost">Cancelar</button>
          <button onClick={guardar} className="btn btn-primary" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function CatalogoAdmin() {
  const { profile } = useAuth()
  const orgId = (profile as any)?.organization_id ?? null
  const [items, setItems] = useState<ItemCatalogo[]>([])
  const [cargando, setCargando] = useState(true)
  const [buscar, setBuscar] = useState('')
  const [verInactivos, setVerInactivos] = useState(false)
  const [editando, setEditando] = useState<ItemCatalogo | 'nuevo' | null>(null)

  const cargar = useCallback(async () => {
    try { setItems(await listarCatalogo()) }
    catch (err: any) { toast.error(err?.message ?? 'No se pudo cargar el catálogo') }
    setCargando(false)
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const alternar = async (it: ItemCatalogo) => {
    try { await activarItem(it.id, !it.active); toast.success(it.active ? 'Desactivado' : 'Activado ✓'); cargar() }
    catch (err: any) { toast.error(err?.message ?? 'No se pudo actualizar') }
  }

  const q = buscar.trim().toLowerCase()
  const visibles = items
    .filter(i => verInactivos || i.active)
    .filter(i => !q || i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q))
  const inactivos = items.filter(i => !i.active).length

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="corsa-input" value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar…" style={{ width: 220 }}/>
          {inactivos > 0 && (
            <label style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={verInactivos} onChange={e => setVerInactivos(e.target.checked)}/> Ver inactivos ({inactivos})
            </label>
          )}
        </div>
        <button id="btn-nuevo-item" className="btn btn-primary" onClick={() => setEditando('nuevo')} disabled={!orgId}>
          + Agregar producto o servicio
        </button>
      </div>

      {cargando ? (
        <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
      ) : visibles.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">{items.length === 0 ? 'Todavía no hay productos ni servicios' : 'Sin coincidencias'}</div>
          {items.length === 0 && <div className="empty-state-sub">Agregá el primero para poder facturarlo desde la pestaña Facturar.</div>}
        </div>
      ) : visibles.map(it => (
        <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--border)', opacity: it.active ? 1 : 0.55, flexWrap: 'wrap' }}>
          <span className={`badge ${it.item_type === 'producto' ? 'badge-orange' : 'badge-neutral'}`} style={{ flexShrink: 0 }}>
            {it.item_type === 'producto' ? 'Producto' : 'Servicio'}
          </span>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{it.name}</div>
            {it.description && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.description}</div>}
          </div>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 15, fontVariantNumeric: 'tabular-nums', minWidth: 90, textAlign: 'right' }}>
            {it.default_price != null ? money(it.default_price) : <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>Sin precio</span>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setEditando(it)}>Editar</button>
            <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => alternar(it)}>
              {it.active ? 'Desactivar' : 'Activar'}
            </button>
          </div>
        </div>
      ))}

      {editando && orgId && (
        <ItemModal item={editando === 'nuevo' ? null : editando} orgId={orgId}
          onCerrar={() => setEditando(null)} onGuardado={() => { setEditando(null); cargar() }}/>
      )}
    </div>
  )
}
