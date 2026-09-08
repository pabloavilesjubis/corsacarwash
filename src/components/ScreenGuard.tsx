/**
 * CORSA Carwash — Guard de acceso por pantalla
 *
 * SEGURIDAD: esto es defensa en profundidad de UI, no la autorización real.
 * Sin el guard, hoy cualquier sesión válida abre /receivables o /settings
 * escribiendo la URL; el guard cierra esa puerta. Los DATOS los sigue
 * protegiendo RLS del lado del servidor.
 */

import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { firstAccessibleScreen } from '../lib/screens'

function NoAccess({ reason }: { reason: 'screen' | 'no-roles' }) {
  return (
    <div className="page-inner">
      <div className="empty-state">
        <div className="empty-state-title">
          {reason === 'no-roles'
            ? 'Tu usuario todavía no tiene ningún rol asignado'
            : 'No tenés acceso a esta sección'}
        </div>
        <div className="empty-state-sub">
          {reason === 'no-roles'
            ? 'Pedile a un administrador que te asigne un rol desde Usuarios y roles.'
            : 'Si necesitás entrar, pedile acceso a un administrador.'}
        </div>
      </div>
    </div>
  )
}

/** Envuelve una ruta y exige un código de permiso para renderizarla. */
export function ScreenGuard({
  permission,
  children,
}: {
  permission: string
  children: ReactNode
}) {
  const { hasPermission, permissions } = useAuth()

  if (hasPermission(permission)) return <>{children}</>

  // Distinguimos "no tenés esta pantalla" de "no tenés ningún permiso",
  // que casi siempre significa un usuario recién creado sin rol.
  return <NoAccess reason={permissions.size === 0 ? 'no-roles' : 'screen'}/>
}

/**
 * Entrada de la app: manda a la primera pantalla que el usuario puede ver.
 * Antes esto era un `<Navigate to="/dashboard">` fijo, que dejaba a un
 * Operador (sin acceso al resumen) en una pantalla vacía.
 */
export function HomeRedirect() {
  const { hasPermission } = useAuth()
  const target = firstAccessibleScreen(hasPermission)

  if (!target) return <NoAccess reason="no-roles"/>
  return <Navigate to={target.path} replace/>
}
