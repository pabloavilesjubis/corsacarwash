import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from './hooks/useAuth'
import { ThemeProvider } from './contexts/ThemeContext'
import { AppShell } from './layouts/AppShell'
import { ScreenGuard, HomeRedirect } from './components/ScreenGuard'
import { adaptativa } from './mobile/registro'
import { PuenteNotificaciones } from './components/PuenteNotificaciones'

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
const AnalisisMaquinasPage = lazy(() => import('./pages/AnalisisMaquinasPage').then(m => ({ default: m.AnalisisMaquinasPage })))
const ConfiguracionPage = lazy(() => import('./pages/ConfiguracionPage').then(m => ({ default: m.ConfiguracionPage })))
const NotificacionesPage = lazy(() => import('./pages/NotificacionesPage').then(m => ({ default: m.NotificacionesPage })))
const CierreDiarioPage = lazy(() => import('./pages/CierreDiarioPage').then(m => ({ default: m.CierreDiarioPage })))
// Banco de pruebas del ticket térmico. Sólo en desarrollo: no es una pantalla
// del sistema, así que no pasa por ScreenGuard ni aparece en el sidebar.
const TicketPreviewPage = lazy(() => import('./pages/TicketPreviewPage').then(m => ({ default: m.TicketPreviewPage })))
// Banco de trabajo del modelo móvil. También sólo en desarrollo: monta la app
// dentro de marcos del tamaño de cada teléfono.
const DisenadorPage = lazy(() => import('./pages/dev/DisenadorPage').then(m => ({ default: m.DisenadorPage })))
const PantallaPage = lazy(() => import('./pages/dev/PantallaPage').then(m => ({ default: m.PantallaPage })))

// Pantallas con versión de teléfono. adaptativa() elige una u otra por ancho,
// por dentro del ScreenGuard: el permiso se verifica una sola vez, arriba, y
// la versión de escritorio queda exactamente como estaba.
const Dashboard = adaptativa('dashboard', DashboardPage)

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          {/* Sin interfaz: sincroniza la suscripción push y atiende la
              navegación que pide el Service Worker al tocar una notificación.
              Va adentro del router y del AuthProvider porque necesita las dos
              cosas. */}
          <PuenteNotificaciones/>

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
              {/* Ésta SÍ va en producción: el problema a diagnosticar ocurre en
                  el teléfono contra el CORSA desplegado, y una herramienta que
                  sólo existe en desarrollo no sirve para eso. No expone nada
                  —sólo mide la pantalla del propio aparato— y no pide sesión,
                  porque el error puede estar antes de poder entrar. */}
              <Route path="/dev/pantalla" element={<PantallaPage/>}/>

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
                <Route path="/machines"    element={<ScreenGuard permission="plc.read"><AnalisisMaquinasPage/></ScreenGuard>}/>
                <Route path="/customers"   element={<ScreenGuard permission="screens.customers"><CustomersPage/></ScreenGuard>}/>
                <Route path="/pos"         element={<ScreenGuard permission="screens.pos"><POSPage/></ScreenGuard>}/>
                <Route path="/orders"      element={<ScreenGuard permission="screens.orders"><OrdersPage/></ScreenGuard>}/>
                <Route path="/analytics"   element={<ScreenGuard permission="screens.analytics"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/receivables" element={<ScreenGuard permission="screens.receivables"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/payables"    element={<ScreenGuard permission="screens.payables"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/fleets"      element={<ScreenGuard permission="screens.fleets"><FlotillasPage/></ScreenGuard>}/>
                <Route path="/memberships" element={<ScreenGuard permission="screens.memberships"><PlaceholderPage/></ScreenGuard>}/>
                <Route path="/settings"    element={<ScreenGuard permission="screens.settings"><ConfiguracionPage/></ScreenGuard>}/>
                {/* Notificaciones cuelga de Configuración pero NO pide
                    screens.settings: es donde cada quien administra SUS
                    dispositivos, y un Operador que recibe avisos de las
                    máquinas tiene que poder apagarlos. El permiso de la
                    pantalla es el mismo con el que ve las máquinas. */}
                <Route path="/settings/notificaciones" element={<ScreenGuard permission="plc.read"><NotificacionesPage/></ScreenGuard>}/>
                {/* La ruta exacta a la que lleva el push de cierre. */}
                <Route path="/dashboard/cierre-diario" element={<ScreenGuard permission="plc.read"><CierreDiarioPage/></ScreenGuard>}/>
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
