/**
 * CORSA Carwash — Authentication context and hook
 *
 * SECURITY:
 * - Session is managed by Supabase (memory + secure storage).
 * - We do NOT store tokens in localStorage.
 * - On logout, we clear all client state and redirect.
 * - Profile/permissions are loaded after session is confirmed.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile, Branch } from '../types'

interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: Profile | null
  permissions: Set<string>
  currentBranch: Branch | null
  accessibleBranches: Branch[]
  loading: boolean
  error: string | null
  setCurrentBranch: (branch: Branch) => void
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  hasPermission: (permission: string) => boolean
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [permissions, setPermissions] = useState<Set<string>>(new Set())
  const [currentBranch, setCurrentBranchState] = useState<Branch | null>(null)
  const [accessibleBranches, setAccessibleBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * Load profile and permissions after authentication
   * SECURITY: uses RLS — server enforces org isolation
   */
  const loadUserData = useCallback(async (userId: string) => {
    try {
      // Load profile
      const { data: profileData, error: profileError } = await supabase
        .from('profiles' as any)
        .select('*')
        .eq('id', userId)
        .single()

      if (profileError || !profileData) {
        setError('No se pudo cargar el perfil de usuario')
        return
      }

      setProfile(profileData as Profile)

      // Load permissions via RBAC
      const { data: permData } = await supabase
        .from('user_roles' as any)
        .select(`
          role:roles(
            role_permissions(
              permission:permissions(code)
            )
          )
        `)
        .eq('user_id', userId)

      const permSet = new Set<string>()
      if (permData) {
        for (const ur of permData as any[]) {
          for (const rp of ur.role?.role_permissions ?? []) {
            if (rp.permission?.code) {
              permSet.add(rp.permission.code)
            }
          }
        }
      }
      setPermissions(permSet)

      // Load accessible branches
      const { data: branchesRaw } = await (supabase.rpc as any)('get_accessible_branch_ids')
      const branchesData = branchesRaw as string[] | null
      if (branchesData && branchesData.length > 0) {
        const { data: branches } = await supabase
          .from('branches' as any)
          .select('*')
          .in('id', branchesData)
          .eq('active', true)
          .order('name')

        const branchesList = branches as any[] | null
        if (branchesList && branchesList.length > 0) {
          setAccessibleBranches(branchesList as Branch[])
          const profData = profileData as any
          const defaultBranch = branchesList.find(b => b.id === profData.default_branch_id)
            ?? branchesList[0]
          if (defaultBranch) {
            setCurrentBranchState(defaultBranch as Branch)
          }
        }
      }
    } catch (err) {
      // Log generic error — never expose internal details to user
      console.error('Error loading user data')
      setError('Error al cargar datos de usuario')
    }
  }, [])

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) {
        loadUserData(session.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session)
        setUser(session?.user ?? null)
        if (session?.user) {
          loadUserData(session.user.id)
        } else {
          // Clear all state on logout
          setProfile(null)
          setPermissions(new Set())
          setCurrentBranchState(null)
          setAccessibleBranches([])
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [loadUserData])

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      // SECURITY: credentials never logged, never sent in URL
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        // Return generic message — do not expose internal error details to UI
        return { error: 'Email o contraseña incorrectos' }
      }
      return { error: null }
    } catch {
      return { error: 'Error al iniciar sesión' }
    }
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    // Clear all in-memory state
    setProfile(null)
    setPermissions(new Set())
    setCurrentBranchState(null)
    setAccessibleBranches([])
    setSession(null)
    setUser(null)
    // Full redirect to clear any cached state
    window.location.href = '/login'
  }, [])

  const setCurrentBranch = useCallback((branch: Branch) => {
    setCurrentBranchState(branch)
  }, [])

  const hasPermission = useCallback((permission: string): boolean => {
    return permissions.has(permission)
  }, [permissions])

  return (
    <AuthContext.Provider value={{
      session, user, profile, permissions, currentBranch,
      accessibleBranches, loading, error,
      setCurrentBranch, signIn, signOut, hasPermission
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
