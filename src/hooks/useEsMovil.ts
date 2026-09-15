/**
 * CORSA Carwash — ¿estamos en teléfono?
 *
 * Un solo lugar decide qué cuenta como móvil, y de él cuelga todo el modelo
 * móvil. La regla para no romper el escritorio es simple y hay que sostenerla:
 * arriba del corte, la app tiene que renderizar EXACTAMENTE el mismo árbol de
 * componentes que antes de que existiera este archivo. Nada de media queries
 * sueltas dentro de las pantallas de escritorio: si hay que cambiar algo para
 * el teléfono, se cambia en src/mobile/, no acá.
 *
 * 820 px y no 768: la Surface del local y las tablets en horizontal trabajan
 * bien con el layout de escritorio, y el sidebar todavía entra. Abajo de eso
 * el sidebar se come la pantalla y empieza a tener sentido el modelo de
 * teléfono.
 */
import { useEffect, useState } from 'react'

export const CORTE_MOVIL = 820

/**
 * Forzar una vista sin cambiar el tamaño de la ventana: ?vista=movil o
 * ?vista=escritorio. Es lo que usa el diseñador de /dev/disenador, y también
 * sirve para mirar el teléfono en una pestaña normal.
 *
 * Se guarda en sessionStorage porque al navegar dentro de la app el query
 * param se pierde, y sin esto la vista forzada duraría una sola pantalla.
 */
function claveDeVista(): string {
  // sessionStorage es del tab, y el iframe del diseñador comparte el tab con
  // la página que lo contiene. Con una sola clave, forzar «móvil» adentro del
  // marco dejaría la app en móvil al volver a navegar en ese mismo tab. Cada
  // contexto guarda la suya y el problema no existe.
  return window.self !== window.top ? 'corsa:vista:marco' : 'corsa:vista'
}

function vistaForzada(): 'movil' | 'escritorio' | null {
  try {
    const param = new URLSearchParams(window.location.search).get('vista')
    if (param === 'movil' || param === 'escritorio') {
      sessionStorage.setItem(claveDeVista(), param)
      return param
    }
    const guardada = sessionStorage.getItem(claveDeVista())
    if (guardada === 'movil' || guardada === 'escritorio') return guardada
  } catch {
    // Ventana privada o almacenamiento bloqueado: se decide por ancho y listo.
  }
  return null
}

function medir(): boolean {
  const forzada = vistaForzada()
  if (forzada) return forzada === 'movil'
  return window.innerWidth < CORTE_MOVIL
}

export function useEsMovil(): boolean {
  const [esMovil, setEsMovil] = useState(medir)

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${CORTE_MOVIL - 1}px)`)
    const alCambiar = () => setEsMovil(medir())
    mq.addEventListener('change', alCambiar)
    // El resize también se escucha: dentro del iframe del diseñador el cambio
    // de dispositivo cambia el ancho sin cruzar necesariamente el corte.
    window.addEventListener('resize', alCambiar)
    return () => {
      mq.removeEventListener('change', alCambiar)
      window.removeEventListener('resize', alCambiar)
    }
  }, [])

  return esMovil
}
