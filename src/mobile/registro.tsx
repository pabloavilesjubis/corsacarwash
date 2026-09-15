/**
 * CORSA Carwash — qué pantallas están adaptadas al teléfono, y cómo
 *
 * Hay dos formas de estar adaptada, y la diferencia importa:
 *
 *  · CON COMPONENTE PROPIO. La pantalla del teléfono es otra pantalla, no la
 *    de computadora encogida. Es lo que corresponde cuando lo que alguien
 *    necesita en el local es distinto de lo que necesita sentado — el Resumen
 *    del día es el caso: en el teléfono no van ni el mapa de calor ni los
 *    últimos 7 días.
 *
 *  · RESPONSIVA EN SU LUGAR. La misma pantalla, que se acomoda al ancho. Es lo
 *    correcto cuando la tarea es la misma en los dos lados: cobrar es cobrar,
 *    y una segunda versión del POS sería una segunda versión de la lógica de
 *    cobro, que es exactamente lo que no hay que tener.
 *
 * Lo que este registro decide es si la cáscara móvil tiene que avisar «esto
 * todavía se ve como en computadora» y encerrar la pantalla en un contenedor
 * de 900 px con scroll lateral. Una pantalla ya adaptada que no esté anotada
 * acá se ve cortada a la derecha aunque su CSS esté perfecto.
 */
import { lazy, Suspense, type ComponentType } from 'react'
import { useEsMovil } from '../hooks/useEsMovil'

/** Clave de pantalla (src/lib/screens.ts) → componente hecho para el teléfono. */
export const PANTALLAS_MOVIL: Record<string, ComponentType> = {
  dashboard: lazy(() => import('./DashboardMovil').then(m => ({ default: m.DashboardMovil }))),
}

/**
 * Pantallas que se adaptan solas al ancho, sin componente aparte.
 *
 * Anotar una acá es afirmar algo verificable: que en 390 px se usa sin scroll
 * horizontal y sin controles fuera de alcance. Si no es cierto, sacala de la
 * lista y la cáscara vuelve a avisarlo — es preferible el aviso a que alguien
 * descubra en el local que no podía llegar al botón de cobrar.
 */
export const PANTALLAS_RESPONSIVAS: readonly string[] = [
  'pos',
  'sales',
  'customers',
  'coupons',
  'users',
  'pos_admin',
  'fleets',
  'software',
  'orders',
  // Nace responsiva: la tabla es de computadora y la lista de teléfono es la
  // misma pantalla, con el detalle en hoja.
  'rain',
]

/** ¿Tiene una pantalla hecha para el teléfono? Lo consulta el ruteo. */
export function tieneVersionMovil(key: string): boolean {
  return key in PANTALLAS_MOVIL
}

/** ¿Se puede usar en un teléfono, de una forma u otra? Lo consulta la cáscara. */
export function estaAdaptada(key: string): boolean {
  return tieneVersionMovil(key) || PANTALLAS_RESPONSIVAS.includes(key)
}

/**
 * Elige entre la pantalla de escritorio y la de teléfono.
 *
 * Va POR DENTRO del ScreenGuard de cada ruta a propósito: el permiso se
 * verifica una sola vez, arriba, y ninguna de las dos versiones puede quedar
 * fuera de esa verificación por olvido.
 */
export function adaptativa(key: string, Escritorio: ComponentType): ComponentType {
  const Movil = PANTALLAS_MOVIL[key]

  return function PantallaAdaptativa() {
    const esMovil = useEsMovil()

    // Sin versión móvil se muestra la de escritorio, no un error: la pantalla
    // sigue estando disponible mientras se la adapta.
    if (!esMovil || !Movil) return <Escritorio/>

    return (
      <Suspense fallback={<div className="loading-center"><div className="spinner"/></div>}>
        <Movil/>
      </Suspense>
    )
  }
}
