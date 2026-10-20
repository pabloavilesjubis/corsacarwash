/**
 * Beneficio corporativo al dar de alta o editar un cliente (0080): la empresa
 * aliada y el número de carnet. Lo usan el alta rápida de caja y el
 * formulario de Clientes. Sin empresa elegida no se inscribe nada.
 */
import { useEffect, useState } from 'react'
import { listarBeneficiosActivos, type BeneficioElegido } from '../../lib/beneficios/beneficios'

/** Sin empresas aliadas activas no se dibuja nada, ni el título de la sección. */
export function CampoBeneficio({ valor, onCambio, titulo, style }: {
  valor: BeneficioElegido
  onCambio: (b: BeneficioElegido) => void
  titulo?: React.ReactNode
  style?: React.CSSProperties
}) {
  const [empresas, setEmpresas] = useState<{ id: string; name: string }[] | null>(null)

  useEffect(() => {
    let vivo = true
    listarBeneficiosActivos().then(e => { if (vivo) setEmpresas(e) }).catch(() => { if (vivo) setEmpresas([]) })
    return () => { vivo = false }
  }, [])

  if (empresas && empresas.length === 0) return null

  return (
    <div style={style}>
    {titulo}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      <label className="field" style={{ flex: '1 1 55%', minWidth: 0 }}>
        <span>Empresa aliada</span>
        <select className="corsa-input" value={valor.benefitId} disabled={!empresas}
                onChange={e => onCambio({ ...valor, benefitId: e.target.value })}>
          <option value="">{empresas ? 'Sin beneficio' : 'Cargando…'}</option>
          {(empresas ?? []).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      {valor.benefitId && (
        <label className="field" style={{ flex: '1 1 35%', minWidth: 0 }}>
          <span>Carnet *</span>
          <input className="corsa-input font-mono" value={valor.carnet} maxLength={30} autoComplete="off"
                 onChange={e => onCambio({ ...valor, carnet: e.target.value.toUpperCase() })}/>
        </label>
      )}
    </div>
    </div>
  )
}
