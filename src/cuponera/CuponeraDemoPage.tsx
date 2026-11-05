/**
 * El portal de la Cuponera Digital con datos de demostración (/dev/cuponera,
 * sólo en desarrollo). ?sesion=1 entra directo al tablero.
 */
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CuponeraPortal } from './CuponeraPortal'
import { crearDemo } from './demo'

export function CuponeraDemoPage() {
  const [params] = useSearchParams()
  const api = useMemo(() => crearDemo({ conSesion: params.get('sesion') === '1' }), [params])
  return <CuponeraPortal api={api}/>
}
