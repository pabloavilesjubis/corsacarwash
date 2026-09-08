import { Suspense } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { useAuth } from '../hooks/useAuth'

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

  if (loading) return <LoadingFull/>
  if (!session) return <Navigate to="/login" replace/>

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
