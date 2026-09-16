/**
 * CORSA Carwash — Configuración
 *
 * El índice de la sección. Hoy tiene una sola entrada —Notificaciones— y
 * existe igual: la ruta /settings ya estaba en el menú apuntando a un
 * marcador de posición, y dejarla ahí mientras la pantalla de notificaciones
 * vive en otro lado haría que nadie la encontrara.
 *
 * Lo que se agregue después —parámetros del cierre, reglas de servicio— entra
 * como otra tarjeta acá.
 */
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

interface Seccion {
  path: string
  icono: string
  titulo: string
  descripcion: string
  permiso?: string
}

const SECCIONES: Seccion[] = [
  {
    path: '/settings/notificaciones',
    icono: '🔔',
    titulo: 'Notificaciones',
    descripcion: 'Activá los avisos de lavados, fallas y cierre del día en tu teléfono o '
               + 'computadora, y administrá tus dispositivos.',
  },
]

export function ConfiguracionPage() {
  const { hasPermission } = useAuth()
  const visibles = SECCIONES.filter(s => !s.permiso || hasPermission(s.permiso))

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>
            Configuración
          </h1>
          <div className="page-header-sub">Ajustes de CORSA para vos y para tus dispositivos.</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {visibles.map(s => (
          <Link key={s.path} to={s.path} className="card" style={{
            display: 'flex', gap: 12, alignItems: 'flex-start',
            textDecoration: 'none', color: 'inherit',
          }}>
            <span style={{ fontSize: 22, lineHeight: 1.1 }}>{s.icono}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 16,
                color: 'var(--text-primary)',
              }}>
                {s.titulo}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
                {s.descripcion}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
