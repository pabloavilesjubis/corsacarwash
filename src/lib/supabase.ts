/**
 * CORSA Carwash — Supabase client
 *
 * SECURITY:
 * - Only the anon key is used here (safe for browser).
 * - The service_role key NEVER appears in this file or any frontend code.
 * - All sensitive mutations go through RPC (security definer) functions.
 *
 * Session management:
 * - Supabase handles JWT in memory + refresh tokens in httpOnly-like storage.
 * - We do NOT store tokens in localStorage manually.
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/database.types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. Copy .env.example to .env.local and fill in your values.'
  )
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    // TODO(security): Consider MFA enforcement for admin/financial roles in Phase 2
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
})

export type SupabaseClient = typeof supabase
