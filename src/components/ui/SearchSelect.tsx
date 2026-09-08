/**
 * CORSA Carwash — Selector con búsqueda por tecleado
 *
 * Para catálogos que no caben en un <select>: CAT-019 tiene 769 actividades y
 * desplegarlas todas obliga al cajero a scrollear a ciegas. Acá se escribe y
 * la lista se filtra por código o por nombre.
 *
 * El filtro ignora acentos a propósito: nadie escribe "reparación" con tilde
 * cuando está apurado, y sin eso la búsqueda no encontraría nada.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

export interface SearchSelectItem {
  codigo: string
  nombre: string
}

/** Cuántas coincidencias se dibujan; más que esto es scroll inútil. */
const MAX_RESULTS = 60

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export function SearchSelect({
  items, value, onChange, placeholder = 'Escribí para buscar…', id, disabled,
}: {
  items: SearchSelectItem[]
  value: string
  onChange: (codigo: string) => void
  placeholder?: string
  id?: string
  disabled?: boolean
}) {
  const selected = useMemo(
    () => items.find(i => i.codigo === value) ?? null,
    [items, value]
  )

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const q = normalize(query.trim())
    if (!q) return items.slice(0, MAX_RESULTS)
    const words = q.split(/\s+/)
    return items
      .filter(i => {
        const hay = normalize(`${i.codigo} ${i.nombre}`)
        return words.every(w => hay.includes(w))
      })
      .slice(0, MAX_RESULTS)
  }, [items, query])

  useEffect(() => { setCursor(0) }, [query])

  // Cerrar al hacer clic afuera
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Mantener visible la opción resaltada al navegar con el teclado
  useEffect(() => {
    if (!open) return
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const choose = (codigo: string) => {
    onChange(codigo)
    setQuery('')
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setCursor(c => Math.min(c + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && matches[cursor]) { e.preventDefault(); choose(matches[cursor].codigo) }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        id={id}
        className="corsa-input"
        disabled={disabled}
        // Cerrado muestra lo elegido; al escribir pasa a modo búsqueda.
        value={open ? query : (selected ? `${selected.codigo} · ${selected.nombre}` : '')}
        placeholder={placeholder}
        onFocus={() => { setQuery(''); setOpen(true) }}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={id ? `${id}-list` : undefined}
      />

      {open && (
        <div
          id={id ? `${id}-list` : undefined}
          ref={listRef}
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 3px)', left: 0, right: 0, zIndex: 60,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.14)', maxHeight: 240, overflowY: 'auto',
          }}
        >
          {matches.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Sin coincidencias para “{query}”
            </div>
          ) : matches.map((i, idx) => (
            <button
              key={i.codigo}
              type="button"
              role="option"
              aria-selected={i.codigo === value}
              onMouseEnter={() => setCursor(idx)}
              onClick={() => choose(i.codigo)}
              style={{
                width: '100%', display: 'block', textAlign: 'left', cursor: 'pointer',
                padding: '7px 12px', border: 'none',
                background: idx === cursor ? 'var(--subtle-bg)' : 'transparent',
                borderBottom: idx < matches.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }} className="font-mono">
                {i.codigo}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--text-primary)', marginLeft: 8 }}>
                {i.nombre}
              </span>
            </button>
          ))}
          {matches.length === MAX_RESULTS && (
            <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-secondary)', borderTop: '1px solid var(--border)' }}>
              Mostrando {MAX_RESULTS} de muchas — seguí escribiendo para afinar.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
