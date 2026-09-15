/**
 * CORSA Carwash — armazón del teléfono
 *
 * No es el sidebar angosto: es otro armazón. El menú lateral de escritorio
 * tiene quince entradas y en un teléfono ninguna se alcanza con el pulgar, así
 * que abajo van las cuatro que se usan en el turno y el resto vive en una hoja
 * que sube. Cuáles son las cuatro sale de los permisos del usuario, igual que
 * el sidebar: un Operador no tiene «Resumen del día» y su barra no puede
 * ofrecérselo.
 *
 * Este componente NO se monta nunca en escritorio — AppShell elige uno u otro,
 * y el de computadora quedó exactamente como estaba.
 */
import { Suspense, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { SCREENS, firstAccessibleScreen, type ScreenDef } from '../lib/screens'
import { estaAdaptada } from './registro'
import type { Branch } from '../types'
import './movil.css'
import './responsivo.css'

// ─── Iconos ──────────────────────────────────────────────────
// Propios, y no importados del sidebar, para que el modelo móvil no dependa de
// un archivo de escritorio que alguien podría reordenar.
function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

const ICONOS: Record<string, React.ReactNode> = {
  pos:       <Svg><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 15h3"/></Svg>,
  pos_admin: <Svg><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10"/><path d="M7 13h6"/></Svg>,
  orders:    <Svg><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></Svg>,
  dashboard: <Svg><line x1="5" y1="20" x2="5" y2="11"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="19" y1="20" x2="19" y2="14"/></Svg>,
  sales:     <Svg><path d="M3 17l6-6 4 4 7-7"/><path d="M21 8v5h-5"/></Svg>,
  coupons:   <Svg><path d="M3 9a2 2 0 0 0 0 6v3h18v-3a2 2 0 0 1 0-6V6H3z"/><path d="M12 7v10"/></Svg>,
  customers: <Svg><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></Svg>,
  fleets:    <Svg><rect x="1" y="7" width="14" height="10" rx="1"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></Svg>,
  users:     <Svg><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/></Svg>,
  mas:       <Svg><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></Svg>,
}

function icono(key: string) {
  return ICONOS[key] ?? <Svg><circle cx="12" cy="12" r="8"/></Svg>
}

/**
 * Las cuatro de abajo, en orden de uso en el turno. Es una preferencia, no una
 * lista fija: se queda con las primeras que el usuario realmente pueda ver.
 */
const PREFERIDAS = ['pos', 'dashboard', 'sales', 'customers', 'orders', 'coupons']

function iniciales(nombre: string): string {
  return nombre.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('')
}

// ─── Hoja «Más» ──────────────────────────────────────────────
function HojaMas({ pantallas, alCerrar }: { pantallas: ScreenDef[]; alCerrar: () => void }) {
  const { profile, signOut, accessibleBranches, currentBranch, setCurrentBranch } = useAuth()
  const nombre = [(profile as any)?.first_name, (profile as any)?.last_name].filter(Boolean).join(' ')

  return (
    <>
      <div className="corsa-movil__velo" onClick={alCerrar}/>
      <div className="corsa-movil__hoja" role="dialog" aria-label="Más pantallas">
        <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--border)', margin: '6px auto 10px' }}/>

        {accessibleBranches.length > 1 && (
          <div style={{ padding: '4px 20px 12px' }}>
            <div className="corsa-movil__etiqueta" style={{ marginBottom: 6 }}>Sucursal</div>
            <select
              value={(currentBranch as Branch | null)?.id ?? ''}
              onChange={e => {
                const b = accessibleBranches.find(x => x.id === e.target.value)
                if (b) setCurrentBranch(b as Branch)
              }}
              style={{
                width: '100%', padding: '11px 12px', fontSize: 15,
                border: '1px solid var(--border)', borderRadius: 7,
                background: 'var(--surface)', color: 'var(--text-primary)',
              }}
            >
              {accessibleBranches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}

        {pantallas.map(p => (
          <NavLink key={p.key} to={p.path} className="corsa-movil__hoja-item" onClick={alCerrar}>
            <span style={{ color: 'var(--text-secondary)', display: 'flex' }}>{icono(p.key)}</span>
            <span style={{ flex: 1 }}>{p.label}</span>
            {/* Se dice cuáles todavía se ven en formato de computadora, en vez
                de que el usuario lo descubra al entrar. */}
            {!estaAdaptada(p.key) && (
              <span style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>escritorio</span>
            )}
          </NavLink>
        ))}

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
          <button className="corsa-movil__hoja-item" onClick={signOut} style={{ color: 'var(--color-danger-text)' }}>
            <span style={{ display: 'flex' }}>
              <Svg><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></Svg>
            </span>
            Cerrar sesión{nombre ? ` · ${nombre}` : ''}
          </button>
        </div>
      </div>
    </>
  )
}

// ─── Armazón ─────────────────────────────────────────────────
export function MovilShell() {
  const { profile, currentBranch, hasPermission } = useAuth()
  const location = useLocation()
  const [hoja, setHoja] = useState(false)

  const accesibles = SCREENS.filter(s => !s.hidden && hasPermission(s.permission))
  const principales = PREFERIDAS
    .map(k => accesibles.find(s => s.key === k))
    .filter((s): s is ScreenDef => !!s)
    .slice(0, 4)
  const enHoja = accesibles.filter(s => !principales.includes(s))

  const actual = accesibles.find(s => s.path === location.pathname)
    ?? firstAccessibleScreen(hasPermission)
  // `??` no alcanza: un first_name vacío no es null, y dejaba la cabecera
  // diciendo «Sucursal Escalón ·» con nada después.
  const nombre = ((profile as any)?.first_name || '').trim() || 'equipo'
  const sucursal = (currentBranch as Branch | null)?.name ?? ''

  return (
    <div className="corsa-movil">
      <header className="corsa-movil__header">
        <div style={{ minWidth: 0 }}>
          <div className="corsa-movil__titulo">{actual?.label ?? 'CORSA'}</div>
          <div className="corsa-movil__subtitulo">
            {sucursal ? `${sucursal} · ${nombre}` : nombre}
          </div>
        </div>
        <button className="corsa-movil__avatar" onClick={() => setHoja(true)} aria-label="Menú">
          {iniciales(nombre)}
        </button>
      </header>

      <main className="corsa-movil__contenido">
        {/* Una pantalla sin versión de teléfono se muestra igual, con su aviso:
            esconderla dejaría sin acceso a quien la necesita hoy. */}
        <Suspense fallback={<div className="loading-center"><div className="spinner"/></div>}>
          {actual && !estaAdaptada(actual.key) ? (
            <>
              <div className="corsa-movil__pendiente">
                Vista de computadora — esta pantalla todavía no se adaptó al teléfono
              </div>
              <div className="corsa-movil__escritorio"><Outlet/></div>
            </>
          ) : (
            <Outlet/>
          )}
        </Suspense>
      </main>

      <nav className="corsa-movil__tabs">
        {principales.map(p => (
          <NavLink
            key={p.key}
            to={p.path}
            className={({ isActive }) => `corsa-movil__tab${isActive ? ' activo' : ''}`}
          >
            {icono(p.key)}
            <span>{p.label.split(' ')[0]}</span>
          </NavLink>
        ))}
        {enHoja.length > 0 && (
          <button className="corsa-movil__tab" onClick={() => setHoja(true)}>
            {icono('mas')}
            <span>Más</span>
          </button>
        )}
      </nav>

      {hoja && <HojaMas pantallas={enHoja} alCerrar={() => setHoja(false)}/>}
    </div>
  )
}
