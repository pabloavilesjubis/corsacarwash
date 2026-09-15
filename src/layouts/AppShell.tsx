import { Suspense, lazy } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { useAuth } from '../hooks/useAuth'
import { useEsMovil } from '../hooks/useEsMovil'

// Se carga sólo si hace falta: en la computadora del local, el modelo móvil
// entero —cáscara, estilos y pantallas— nunca se descarga.
const MovilShell = lazy(() => import('../mobile/MovilShell').then(m => ({ default: m.MovilShell })))

function LoadingFull() {
  return (
    <div className="loading-center" style={{ height: '100vh' }}>
      <div className="spinner"/>
      <span style={{ color: 'var(--text-secondary)' }}>Cargando…</span>
    </div>
  )
}

export function AppShell() {
  const { session, loading } = useAuth()
  const esMovil = useEsMovil()

  if (loading) return <LoadingFull/>
  if (!session) return <Navigate to="/login" replace/>

  // La única bifurcación entre los dos modelos. Arriba del corte el árbol que
  // sigue es idéntico al que había antes de que existiera src/mobile: esa es
  // la garantía de que el teléfono no puede romper la computadora.
  if (esMovil) {
    return (
      <Suspense fallback={<LoadingFull/>}>
        <MovilShell/>
      </Suspense>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar/>
      <main className="main-content">
        <Suspense fallback={
          <div className="loading-center"><div className="spinner"/></div>
        }>
          <Outlet/>
        </Suspense>
      </main>
    </div>
  )
}
