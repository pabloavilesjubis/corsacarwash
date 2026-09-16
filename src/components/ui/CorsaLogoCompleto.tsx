import { LOGO_PATH, LOGO_VIEWBOX, LOGO_RATIO } from '../../brand/logoCompleto'

/**
 * El logo completo: símbolo + CORSA + CARWASH.
 *
 * Una sola pieza, como está en el arte. Componerlo con el símbolo y texto HTML
 * al lado parecería equivalente pero no lo es: el tipo de letra, el interlineado
 * y la separación entre las tres partes están definidos en el logo, y con CSS
 * saldría un parecido, no la marca.
 *
 * `width` manda; el alto se deriva de la proporción. Va en `currentColor` para
 * que herede del contenedor — en la pantalla de ingreso, blanco.
 */
export function CorsaLogoCompleto({ width = 190, color = 'currentColor' }: {
  width?: number
  color?: string
}) {
  return (
    <svg
      width={width}
      height={width / LOGO_RATIO}
      viewBox={`0 0 ${LOGO_VIEWBOX.ancho} ${LOGO_VIEWBOX.alto}`}
      role="img"
      aria-label="CORSA Carwash"
    >
      <path d={LOGO_PATH} fill={color} fillRule="evenodd"/>
    </svg>
  )
}
