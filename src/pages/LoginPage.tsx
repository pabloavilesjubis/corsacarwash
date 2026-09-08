import React, { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { CorsaLogo } from '../components/ui/CorsaLogo'

export function LoginPage() {
  const { signIn, session, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (loading) return null
  if (session) return <Navigate to="/dashboard" replace/>

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await signIn(email, password)
    if (error) setError(error)
    setSubmitting(false)
  }

  return (
    <div className="login-page">
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <CorsaLogo size={38}/>
          <span className="login-logo-text">CORSA</span>
        </div>
        <p className="login-subtitle">Sistema Operativo Digital</p>

        {/* Error */}
        {error && (
          <div className="login-error" role="alert">{error}</div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <label htmlFor="email" className="login-label">Correo electrónico</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="usuario@corsacarwash.com"
            className="login-input"
            required
            aria-required="true"
            disabled={submitting}
          />

          <label htmlFor="password" className="login-label">Contraseña</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            className="login-input"
            required
            aria-required="true"
            disabled={submitting}
          />

          <button
            id="btn-login"
            type="submit"
            className="login-btn"
            disabled={submitting || !email || !password}
          >
            {submitting ? (
              <>
                <div className="spinner" style={{ width: 16, height: 16, borderTopColor: '#fff' }}/>
                Ingresando…
              </>
            ) : 'Ingresar'}
          </button>
        </form>

        <p className="login-footer">Acceso exclusivo para personal autorizado de CORSA Carwash</p>
      </div>
    </div>
  )
}
