/**
 * El brandmark de CORSA: dos píldoras inclinadas que se entrelazan.
 *
 * Es el mismo dibujo que el favicon (public/favicon.svg), con las mismas
 * proporciones a propósito — si divergieran serían dos marcas parecidas en
 * lugar de una sola. Acá la segunda píldora va en el acento porque el riel es
 * oscuro y el contraste hace que la marca se lea; en la pestaña van las dos
 * en blanco, que es como está definido el brandmark.
 */
export function CorsaLogo({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 40 24" width={size} height={size * 0.6} fill="none">
      <rect x="1" y="4" width="20" height="16" rx="8"
        transform="rotate(-18 11 12)" stroke="#FFFFFF" strokeWidth="2.4"/>
      <rect x="19" y="4" width="20" height="16" rx="8"
        transform="rotate(-18 29 12)" stroke="var(--corsa-orange)" strokeWidth="2.4"/>
    </svg>
  )
}
