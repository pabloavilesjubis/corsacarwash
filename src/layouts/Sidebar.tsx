import React from 'react'
import { NavLink } from 'react-router-dom'
import { CorsaLogo } from '../components/ui/CorsaLogo'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../contexts/ThemeContext'
import { screensOfSection, type ScreenDef } from '../lib/screens'
import type { Branch } from '../types'

// ─── Icons ─────────────────────────────────────────────────
function Icon({ d, paths, children }: {
  d?: string
  paths?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8"
      style={{ flexShrink: 0 }}>
      {d && <path d={d}/>}
      {paths}
      {children}
    </svg>
  )
}

const icons = {
  dashboard: (
    <Icon>
      <line x1="4" y1="20" x2="4" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="20" y1="20" x2="20" y2="14"/>
    </Icon>
  ),
  customers: (
    <Icon>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </Icon>
  ),
  users: (
    <Icon>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M22 11h-6"/>
      <path d="M19 8v6"/>
    </Icon>
  ),
  analytics: (
    <Icon>
      <path d="M3 3v18h18"/>
      <path d="M18 17V9"/>
      <path d="M13 17V5"/>
      <path d="M8 17v-3"/>
    </Icon>
  ),
  receivable: (
    <Icon>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </Icon>
  ),
  payable: (
    <Icon>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </Icon>
  ),
  fleets: (
    <Icon>
      <rect x="1" y="7" width="14" height="10"/>
      <path d="M15 10h4l3 3v4h-7z"/>
      <circle cx="6" cy="18" r="1.6"/>
      <circle cx="17.5" cy="18" r="1.6"/>
    </Icon>
  ),
  memberships: (
    <Icon>
      <circle cx="12" cy="8" r="5"/>
      <polyline points="8.5 13 7 22 12 19 17 22 15.5 13"/>
    </Icon>
  ),
  settings: (
    <Icon>
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </Icon>
  ),
  pos: (
    <Icon>
      <rect x="2" y="7" width="20" height="13" rx="1.5"/>
      <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
    </Icon>
  ),
  orders: (
    <Icon>
      <path d="M9 11l3 3L22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </Icon>
  ),
  sun: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4"/>
      <line x1="12" y1="2" x2="12" y2="4"/>
      <line x1="12" y1="20" x2="12" y2="22"/>
      <line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/>
      <line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/>
      <line x1="2" y1="12" x2="4" y2="12"/>
      <line x1="20" y1="12" x2="22" y2="12"/>
      <line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/>
      <line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/>
    </svg>
  ),
}

// Icono por clave de pantalla (src/lib/screens.ts). El "+" del POS es propio
// porque la acción es "crear", no "ver la caja".
const screenIcons: Record<string, React.ReactNode> = {
  pos: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  orders: icons.orders,
  sales: icons.receivable,
  dashboard: icons.dashboard,
  customers: icons.customers,
  analytics: icons.analytics,
  receivables: icons.receivable,
  payables: icons.payable,
  fleets: icons.fleets,
  memberships: icons.memberships,
  settings: icons.settings,
  users: icons.users,
}

function getInitials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2)
    .map(w => w[0].toUpperCase()).join('')
}

// ─── Sidebar Item ────────────────────────────────────────────
function SidebarLink({ to, icon, label, exact = false }: {
  to: string; icon: React.ReactNode; label: string; exact?: boolean
}) {
  return (
    <NavLink
      to={to}
      end={exact}
      className={({ isActive }) =>
        `sidebar-item${isActive ? ' active' : ''}`
      }
    >
      <span className="sidebar-icon">{icon}</span>
      <span>{label}</span>
    </NavLink>
  )
}

// ─── Section Header ──────────────────────────────────────────
function SectionActive({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="sidebar-item active-section" style={{ cursor: 'default' }}>
      <span className="sidebar-icon" style={{ color: '#FF6A28' }}>{icon}</span>
      <span>{label}</span>
    </div>
  )
}

// ─── Branch Selector ─────────────────────────────────────────
function BranchSelector() {
  const { accessibleBranches, currentBranch, setCurrentBranch } = useAuth()
  if (accessibleBranches.length <= 1) {
    return null
  }
  return (
    <select
      id="branch-selector"
      value={currentBranch?.id ?? ''}
      onChange={e => {
        const branch = accessibleBranches.find(b => b.id === e.target.value)
        if (branch) setCurrentBranch(branch as Branch)
      }}
      style={{
        width: '100%',
        background: 'rgba(255,255,255,0.08)',
        color: '#fff',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 6,
        padding: '7px 10px',
        fontSize: 13,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {accessibleBranches.map(b => (
        <option key={b.id} value={b.id} style={{ background: '#023530' }}>
          {(b as Branch).name}
        </option>
      ))}
    </select>
  )
}

// ─── Main Sidebar ────────────────────────────────────────────
export function Sidebar() {
  const { profile, currentBranch, signOut, hasPermission } = useAuth()
  const { isDark, toggleTheme } = useTheme()

  const displayName = profile
    ? `${profile.first_name} ${profile.last_name}`.trim()
    : 'Usuario'
  const initials = getInitials(displayName)
  const branchName = (currentBranch as Branch | null)?.name ?? 'CORSA'

  const visible = (section: 'caja' | 'administracion') =>
    screensOfSection(section).filter(sc => hasPermission(sc.permission))

  const caja = visible('caja')
  const admin = visible('administracion')

  const renderLink = (sc: ScreenDef) => (
    <SidebarLink key={sc.key} to={sc.path} icon={screenIcons[sc.key]} label={sc.label}/>
  )

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <CorsaLogo size={34}/>
        <span className="sidebar-logo-text">CORSA</span>
      </div>

      {/* Navegación — derivada de src/lib/screens.ts y filtrada por permisos.
          Una sección sin ninguna pantalla visible no se dibuja. */}
      {caja.length > 0 && (
        <div className="sidebar-section">
          <SectionActive icon={icons.pos} label="Caja"/>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 4 }}>
            {caja.map(renderLink)}
          </div>
        </div>
      )}

      {caja.length > 0 && admin.length > 0 && <div className="sidebar-divider"/>}

      {admin.length > 0 && (
        <div className="sidebar-section">
          <SectionActive icon={icons.dashboard} label="Administración"/>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 4 }}>
            {admin.map(renderLink)}
          </div>
        </div>
      )}

      <div style={{ flex: 1 }}/>

      {/* Branch selector */}
      <BranchSelector/>

      {/* Theme toggle */}
      <button
        id="btn-theme-toggle"
        className="sidebar-theme-toggle"
        onClick={toggleTheme}
        aria-label={isDark ? 'Cambiar a modo día' : 'Cambiar a modo noche'}
      >
        {icons.sun}
        <span className="sidebar-theme-toggle-label">Turno {isDark ? 'noche' : 'día'}</span>
        <div className="sidebar-toggle-track">
          <div className="sidebar-toggle-dot" style={{ left: isDark ? 16 : 2 }}/>
        </div>
      </button>

      {/* User */}
      <div className="sidebar-user">
        <div className="sidebar-avatar">{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div className="sidebar-user-name">{displayName}</div>
          <div className="sidebar-user-role">{branchName}</div>
        </div>
        <button
          id="btn-logout"
          onClick={signOut}
          title="Cerrar sesión"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 18, padding: '2px 4px', marginLeft: 'auto' }}
          aria-label="Cerrar sesión"
        >
          →
        </button>
      </div>
    </aside>
  )
}
