import { BRANDMARK_PATH, BRANDMARK_VIEWBOX, BRANDMARK_RATIO } from '../../brand/brandmark'

/**
 * El brandmark de CORSA.
 *
 * Sale de la misma definición que los iconos del PWA y el favicon
 * (src/brand/brandmark.ts), vectorizada del arte oficial. Antes este
 * componente tenía su propia copia del dibujo, y por eso la marca del riel y
 * la de la pestaña terminaron siendo dos cosas distintas.
 *
 * `size` es el ANCHO. La marca es tres veces más ancha que alta, así que fijar
 * el alto —como haría un icono cuadrado— la dejaría enorme al lado del texto.
 */
export function CorsaLogo({ size = 34, color = 'currentColor' }: {
  size?: number
  color?: string
}) {
  return (
    <svg
      width={size}
      height={size / BRANDMARK_RATIO}
      viewBox={`0 0 ${BRANDMARK_VIEWBOX.ancho} ${BRANDMARK_VIEWBOX.alto}`}
      role="img"
      aria-label="CORSA"
    >
      <path d={BRANDMARK_PATH} fill={color} fillRule="evenodd"/>
    </svg>
  )
}
