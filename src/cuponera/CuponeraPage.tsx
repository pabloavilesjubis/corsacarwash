/** Entrada del portal de la Cuponera Digital (/cuponera). */
import { portalApi } from '../services/cuponera.service'
import { CuponeraPortal } from './CuponeraPortal'

export function CuponeraPage() {
  return <CuponeraPortal api={portalApi}/>
}
