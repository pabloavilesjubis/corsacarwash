import { useLocation } from 'react-router-dom'

const PAGE_LABELS: Record<string, string> = {
  '/analytics': 'Inteligencia de negocio',
  '/receivables': 'Cuentas por cobrar',
  '/payables': 'Cuentas por pagar',
  '/fleets': 'Flotillas corporativas',
  '/memberships': 'Membresías',
  '/settings': 'Configuración',
}

export function PlaceholderPage() {
  const { pathname } = useLocation()
  const label = PAGE_LABELS[pathname] ?? pathname

  return (
    <div className="page-inner" style={{ alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 80px)' }}>
      <div style={{ textAlign: 'center', maxWidth: 480 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 16, background: 'var(--subtle-bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px',
        }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.4">
            <rect x="3" y="3" width="7" height="7"/>
            <rect x="14" y="3" width="7" height="7"/>
            <rect x="3" y="14" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/>
          </svg>
        </div>
        <h2 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 22, color: 'var(--text-primary)', marginBottom: 8 }}>
          {label}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Esta sección está planificada para la próxima fase del proyecto.
          La arquitectura y el modelo de datos ya están preparados en el backend.
        </p>
      </div>
    </div>
  )
}
