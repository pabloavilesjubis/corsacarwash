import { supabase } from '../lib/supabase'
import type { DashboardKPIs } from '../types'

export async function fetchDashboardKPIs(branchId: string, date?: string): Promise<DashboardKPIs> {
  const { data, error } = await (supabase.rpc as any)('get_dashboard_kpis', {
    p_branch_id: branchId,
    p_date: date ?? new Date().toISOString().split('T')[0],
  })
  if (error) throw error
  return data as DashboardKPIs
}

export async function fetchServicePerformanceToday(branchId: string) {
  const today = new Date()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString()

  const { data, error } = await supabase
    .from('v_service_performance' as any)
    .select('service_name, category_name, times_sold, total_revenue')
    .eq('branch_id', branchId)
    .gte('month', monthStart)
    .order('times_sold', { ascending: false })
    .limit(10)

  if (error) throw error
  return data ?? []
}

export async function fetchMembershipsExpiringSoon(_organizationId: string) {
  const { data, error } = await supabase
    .from('v_memberships_expiring_soon' as any)
    .select('*')
    .order('expires_at', { ascending: true })
    .limit(10)

  if (error) throw error
  return data ?? []
}

export async function fetchDailySalesLastWeek(branchId: string) {
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const { data, error } = await supabase
    .from('v_daily_sales' as any)
    .select('sale_date, total_orders, gross_revenue, completed_orders')
    .eq('branch_id', branchId)
    .gte('sale_date', sevenDaysAgo.toISOString().split('T')[0])
    .order('sale_date', { ascending: true })

  if (error) throw error
  return data ?? []
}

export async function fetchActiveWorkOrders(branchId: string) {
  const { data, error } = await supabase
    .from('work_orders' as any)
    .select(`
      id, order_number, status, total, created_at,
      checked_in_at, started_at, ready_at, delivered_at
    `)
    .eq('branch_id', branchId)
    .not('status', 'in', '("delivered","cancelled")')
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw error
  return data ?? []
}

export async function fetchEquipmentStatus(branchId: string) {
  const { data, error } = await supabase
    .from('equipment' as any)
    .select('id, name, code, status, type')
    .eq('branch_id', branchId)
    .eq('type', 'machine')
    .eq('active', true)
    .order('code')

  if (error) throw error
  return data ?? []
}

export async function fetchOpenCashDiscrepancy(branchId: string) {
  // Get last closed cash session and check for unjustified difference
  const { data, error } = await supabase
    .from('cash_sessions' as any)
    .select('id, status, difference, difference_justification, closed_at')
    .eq('branch_id', branchId)
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(1)

  if (error) return null
  const last = (data as any)?.[0]
  if (!last) return null
  // Has unjustified difference
  if (last.difference && Math.abs(last.difference) > 0.01 && !last.difference_justification) {
    return last
  }
  return null
}
