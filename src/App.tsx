import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from './hooks/useAuth'
import { ThemeProvider } from './contexts/ThemeContext'
import { AppShell } from './layouts/AppShell'
import { ScreenGuard, HomeRedirect } from './components/ScreenGuard'
import { adaptativa } from './mobile/registro'

// Lazy-loaded pages
const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })))
const CustomersPage = lazy(() => import('./pages/CustomersPage').then(m => ({ default: m.CustomersPage })))
const POSPage = lazy(() => import('./pages/POSPage').then(m => ({ default: m.POSPage })))
const OrdersPage = lazy(() => import('./pages/OrdersPage').then(m => ({ default: m.OrdersPage })))
const PlaceholderPage = lazy(() => import('./pages/PlaceholderPage').then(m => ({ default: m.PlaceholderPage })))
const FlotillasPage = lazy(() => import('./pages/FlotillasPage').then(m => ({ default: m.FlotillasPage })))
const UsersPage = lazy(() => import('./pages/UsersPage').then(m => ({ default: m.UsersPage })))
const SalesPage = lazy(() => import('./pages/SalesPage').then(m => ({ default: m.SalesPage })))
const PosAdminPage = lazy(() => import('./pages/PosAdminPage').then(m => ({ default: m.PosAdminPage })))
const CouponsPage = lazy(() => import('./pages/CouponsPage').then(m => ({ default: m.CouponsPage })))
const SoftwarePage = lazy(() => import('./pages/SoftwarePage').then(m => ({ default: m.SoftwarePage })))
const SegurosPage = lazy(() => import('./pages/SegurosPage').then(m => ({ default: m.SegurosPage })))
// Banco de pruebas del ticket térmico. Sólo en desarrollo: no es una pantalla
// del sistema, así que no pasa por ScreenGuard ni aparece en el sidebar.
const TicketPreviewPage = lazy(() => import('./pages/TicketPreviewPage').then(m => ({ default: m.TicketPreviewPage })))
// Banco de trabajo del modelo móvil. También sólo en desarrollo: monta la app
// dentro de marcos del tamaño de cada teléfono.
const DisenadorPage = lazy(() => import('./pages/dev/DisenadorPage').then(m => ({ default: m.DisenadorPage })))

// Pantallas con versión de teléfono. adaptativa() elige una u otra por ancho,
// por dentro del ScreenGuard: el permiso se verifica una sola vez, arriba, y
// la versión de escritorio queda exactamente como estaba.
const Dashboard = adaptativa('dashboard', DashboardPage)

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          {/* Global toasts — CORSA brand colors */}
          <Toaster
            position="top-right"
            toastOptions={{
              duration: 4000,
              style: {
                fontFamily: "var(--font-body)",
                fontSize: 14,
                borderRadius: 14,
              },
              success: {
                style: {
                  background: '#E3F5EA', color: '#1B7A4C', border: '1px solid #2FAE73',
                },
                iconTheme: { primary: '#1B7A4C', secondary: '#E3F5EA' },
              },
              error: {
                style: {
                  background: '#FBE9E7', color: '#B03A33', border: '1px solid #E2564E',
                },
                iconTheme: { primary: '#B03A33', secondary: '#FBE9E7' },
              },
            }}
          />

          <Suspense fallback={
            <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="spinner"/>
            </div>
          }>
            <Routes>
              {/* Public */}
              <Route path="/login" element={<LoginPage/>}/>
              {import.meta.env.DEV && (
                <Route path="/dev/ticket" element={<TicketPreviewPage/>}/>
              )}
              {import.meta.env.DEV && (
                <Route path="/dev/disenador" element={<DisenadorPage/>}/>
              )}

              {/* Protected — with AppShell.
                  Cada ruta pasa por ScreenGuard: sin el permiso de su pantalla
                  no alcanza con escribir la URL. Los códigos viven en
                  src/lib/screens.ts, que también alimenta el sidebar. */}
              <Route element={<AppShell/>}>
                <Route path="/dashboard"   element={<ScreenGuard permission="screens.dashboard"><Dashboard/></ScreenGuard>}/>
                <Route path="/sales"       element={<ScreenGuard permission="screens.sales"><SalesPage/></ScreenGuard>}/>
                <Route path="/pos-admin"   element={<ScreenGuard permission="screens.pos_admin"><PosAdminPage/></ScreenGuard>}/>
                <Route path="/coupons"     element={<ScreenGuard permission="screens.coupons"><CouponsPage/></ScreenGuard>}/>
                <Route path="/rain"        element={<ScreenGuard permission="screens.rain"><SegurosPage/></ScreenGuard>}/>
                <Route path="/customers"   element={<ScreenGuard permission="screens.customers"><CustomersPage/></ScreenGuard>}/>
                <Route path="/pos"         element={<ScreenGuard permission="screens.pos"><POSPage/></ScreenGuard>}/>
                <Route path="/orders"      element={<ScreenGuard permission="screens.orders"><OrdersPage/></ScreenGuard>}/>
                <Route path="/analytics"   element={<ScreenGuard permission="screens.analytics"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/receivables" element={<ScreenGuard permission="screens.receivables"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/payables"    element={<ScreenGuard permission="screens.payables"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/fleets"      element={<ScreenGuard permission="screens.fleets"><FlotillasPage/></ScreenGuard>}/>
                <Route path="/memberships" element={<ScreenGuard permission="screens.memberships"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/settings"    element={<ScreenGuard permission="screens.settings"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/users"       element={<ScreenGuard permission="users.manage"><UsersPage/></ScreenGuard>}/>
                <Route path="/software"    element={<ScreenGuard permission="screens.software"><SoftwarePage/></ScreenGuard>}/>

                {/* Entrada y catch-all: a la primera pantalla accesible,
                    no a /dashboard fijo (un Operador no lo tiene). */}
                <Route path="/" element={<HomeRedirect/>}/>
                <Route path="*" element={<HomeRedirect/>}/>
              </Route>
            </Routes>
          </Suspense>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
