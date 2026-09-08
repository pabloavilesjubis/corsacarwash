/**
 * Sidebar SVG Logo — dos óvalos rotados, blanco y naranja
 */
export function CorsaLogo({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 40 24" width={size} height={size * 0.6} fill="none">
      <rect x="1" y="4" width="20" height="16" rx="8"
        transform="rotate(-18 11 12)" stroke="#FFFFFF" strokeWidth="2.4"/>
      <rect x="19" y="4" width="20" height="16" rx="8"
        transform="rotate(-18 29 12)" stroke="#FF6A28" strokeWidth="2.4"/>
    </svg>
  )
}
