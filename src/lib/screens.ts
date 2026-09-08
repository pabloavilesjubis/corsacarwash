/**
 * CORSA Carwash — Registro central de pantallas
 *
 * Única fuente de verdad de "qué pantallas existen y qué permiso pide cada una".
 * La consumen el ruteo (guard), el sidebar (qué enlaces mostrar) y la pantalla
 * de Usuarios y roles (qué casillas ofrecer).
 *
 * SEGURIDAD: esto es un gate de UI. La autorización real vive en el servidor
 * (RLS + RPC security-definer). Ocultar un enlace no protege datos; lo que los
 * protege son las policies. Acá sólo evitamos mostrar lo que igual fallaría.
 *
 * Nota sobre los códigos de permiso:
 * - Las pantallas usan permisos `screens.*` dedicados, independientes de los
 *   permisos de acción, para que quitarle a un rol la pantalla "Clientes" no
 *   le rompa la búsqueda de clientes dentro del POS.
 * - "Usuarios y roles" es la excepción: se controla con `users.manage`, el
 *   mismo permiso que exigen sus RPC. Si usara un `screens.users` aparte,
 *   un rol podría ver la pantalla y recibir 403 en todo lo que hiciera.
 */

export type ScreenSection = 'caja' | 'administracion'

export interface ScreenDef {
  /** Clave estable; también es la clave del icono en el sidebar. */
  key: string
  path: string
  label: string
  /** Código de permiso requerido para navegar a la pantalla. */
  permission: string
  section: ScreenSection
}

export const SCREENS: readonly ScreenDef[] = [
  { key: 'pos',         path: '/pos',         label: 'Nueva orden',              permission: 'screens.pos',         section: 'caja' },
  { key: 'orders',      path: '/orders',      label: 'Órdenes de trabajo',       permission: 'screens.orders',      section: 'caja' },

  { key: 'dashboard',   path: '/dashboard',   label: 'Resumen del día',          permission: 'screens.dashboard',   section: 'administracion' },
  { key: 'sales',       path: '/sales',       label: 'Ventas',                   permission: 'screens.sales',       section: 'administracion' },
  { key: 'customers',   path: '/customers',   label: 'Clientes',                 permission: 'screens.customers',   section: 'administracion' },
  { key: 'analytics',   path: '/analytics',   label: 'Inteligencia de negocio',  permission: 'screens.analytics',   section: 'administracion' },
  { key: 'receivables', path: '/receivables', label: 'Cuentas por cobrar',       permission: 'screens.receivables', section: 'administracion' },
  { key: 'payables',    path: '/payables',    label: 'Cuentas por pagar',        permission: 'screens.payables',    section: 'administracion' },
  { key: 'fleets',      path: '/fleets',      label: 'Flotillas corporativas',   permission: 'screens.fleets',      section: 'administracion' },
  { key: 'memberships', path: '/memberships', label: 'Membresías',               permission: 'screens.memberships', section: 'administracion' },
  { key: 'settings',    path: '/settings',    label: 'Configuración',            permission: 'screens.settings',    section: 'administracion' },
  { key: 'users',       path: '/users',       label: 'Usuarios y roles',         permission: 'users.manage',        section: 'administracion' },
] as const

/** Permisos que la pantalla de roles ofrece como "acceso a pantallas". */
export const SCREEN_PERMISSION_CODES: readonly string[] = SCREENS.map(s => s.permission)

export function screensOfSection(section: ScreenSection): ScreenDef[] {
  return SCREENS.filter(s => s.section === section)
}

/**
 * Orden de preferencia para la pantalla de entrada.
 *
 * Es distinto del orden del sidebar a propósito: ahí "Caja" va primero porque
 * es el módulo de uso diario, pero al entrar al sistema el destino natural es
 * el resumen. Quien no tenga resumen (un Operador, por ejemplo) cae en la
 * primera pantalla que sí pueda ver.
 */
const HOME_PREFERENCE: readonly string[] = ['dashboard', 'pos', 'orders']

/**
 * Primera pantalla accesible, para redirigir al entrar.
 * Devuelve null si el usuario no tiene ninguna — caso real cuando alguien
 * queda sin rol asignado.
 */
export function firstAccessibleScreen(
  hasPermission: (code: string) => boolean
): ScreenDef | null {
  for (const key of HOME_PREFERENCE) {
    const screen = SCREENS.find(s => s.key === key)
    if (screen && hasPermission(screen.permission)) return screen
  }
  return SCREENS.find(s => hasPermission(s.permission)) ?? null
}
