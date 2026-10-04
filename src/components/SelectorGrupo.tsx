/**
 * Elegir el grupo empresarial de un cliente (0054), o crear uno nuevo sin
 * salir de la ficha: el caso común es dar de alta a la segunda empresa de una
 * familia y querer unirla en el mismo paso.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { crearGrupo, listarGrupos, type GrupoEmpresarial } from '../lib/grupos/grupos'

const NUEVO = '__nuevo__'

export function SelectorGrupo({ orgId, value, onChange }: {
  orgId: string
  /** '' = sin grupo. */
  value: string
  onChange: (groupId: string) => void
}) {
  const [grupos, setGrupos] = useState<GrupoEmpresarial[]>([])
  const [creando, setCreando] = useState(false)
  const [nombre, setNombre] = useState('')
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    listarGrupos().then(setGrupos).catch(() => setGrupos([]))
  }, [])

  const crear = async () => {
    if (!nombre.trim()) return
    setGuardando(true)
    try {
      const g = await crearGrupo(orgId, nombre)
      setGrupos(gs => [...gs, g].sort((a, b) => a.name.localeCompare(b.name)))
      onChange(g.id)
      setCreando(false); setNombre('')
      toast.success(`Grupo «${g.name}» creado`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo crear el grupo')
    }
    setGuardando(false)
  }

  if (creando) return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input id="grupo-nuevo-nombre" className="corsa-input" autoFocus value={nombre}
             onChange={e => setNombre(e.target.value)} placeholder="Nombre del grupo (ej. Grupo Jubis)"
             onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); crear() } }}/>
      <button type="button" className="btn btn-primary" onClick={crear} disabled={guardando || !nombre.trim()}>
        {guardando ? '…' : 'Crear'}
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => { setCreando(false); setNombre('') }}>×</button>
    </div>
  )

  return (
    <select id="grupo-empresarial" className="corsa-input" value={value}
            onChange={e => e.target.value === NUEVO ? setCreando(true) : onChange(e.target.value)}>
      <option value="">— Sin grupo —</option>
      {grupos.map(g => (
        <option key={g.id} value={g.id}>{g.name}{g.miembros ? ` · ${g.miembros} cliente${g.miembros === 1 ? '' : 's'}` : ''}</option>
      ))}
      <option value={NUEVO}>＋ Crear grupo nuevo…</option>
    </select>
  )
}
