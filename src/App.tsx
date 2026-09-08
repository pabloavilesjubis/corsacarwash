import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from './hooks/useAuth'
import { ThemeProvider } from './contexts/ThemeContext'
import { AppShell } from './layouts/AppShell'

// Lazy-loaded pages
const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })))
const CustomersPage = lazy(() => import('./pages/CustomersPage').then(m => ({ default: m.CustomersPage })))
const POSPage = lazy(() => import('./pages/POSPage').then(m => ({ default: m.POSPage })))
const OrdersPage = lazy(() => import('./pages/OrdersPage').then(m => ({ default: m.OrdersPage })))
const PlaceholderPage = lazy(() => import('./pages/PlaceholderPage').then(m => ({ default: m.PlaceholderPage })))
const FlotillasPage = lazy(() => import('./pages/FlotillasPage').then(m => ({ default: m.FlotillasPage })))
const UsersPage = lazy(() => import('./pages/UsersPage').then(m => ({ default: m.UsersPage })))

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
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontSize: 14,
                borderRadius: 6,
              },
              success: {
                style: {
                  background: '#E4F5EE', color: '#157A52', border: '1px solid #1E9E6B',
                },
                iconTheme: { primary: '#157A52', secondary: '#E4F5EE' },
              },
              error: {
                style: {
                  background: '#FBE7E7', color: '#B23232', border: '1px solid #E24B4B',
                },
                iconTheme: { primary: '#B23232', secondary: '#FBE7E7' },
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

              {/* Protected — with AppShell */}
              <Route element={<AppShell/>}>
                <Route path="/dashboard" element={<DashboardPage/>}/>
                <Route path="/customers" element={<CustomersPage/>}/>
                <Route path="/pos" element={<POSPage/>}/>
                <Route path="/orders" element={<OrdersPage/>}/>
                <Route path="/analytics" element={<PlaceholderPage/>}/>
                <Route path="/receivables" element={<PlaceholderPage/>}/>
                <Route path="/payables" element={<PlaceholderPage/>}/>
                <Route path="/fleets" element={<FlotillasPage/>}/>
                <Route path="/memberships" element={<PlaceholderPage/>}/>
                <Route path="/settings" element={<PlaceholderPage/>}/>
                <Route path="/users" element={<UsersPage/>}/>
              </Route>

              {/* Default */}
              <Route path="/" element={<Navigate to="/dashboard" replace/>}/>
              <Route path="*" element={<Navigate to="/dashboard" replace/>}/>
            </Routes>
          </Suspense>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
