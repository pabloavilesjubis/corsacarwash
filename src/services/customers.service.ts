import { supabase } from '../lib/supabase'
import type { Customer, Vehicle } from '../types'

export interface CustomerWithStats extends Customer {
  vehicle_count?: number
  last_visit_days?: number
  lifetime_value?: number
  membership_status?: 'active' | 'expiring' | 'none'
  membership_plan?: string
}

/**
 * Busca clientes con debounce de 300ms.
 * Usa ilike sobre nombre, email, teléfono normalizado.
 */
export async function searchCustomers(
  query: string,
  _segment?: string,
  limit = 100
): Promise<CustomerWithStats[]> {
  let q = supabase
    .from('customers' as any)
    .select(`
      *,
      vehicles:vehicles(count),
      customer_memberships:customer_memberships(
        id, status, expires_at,
        membership_plans:plan_id(name)
      )
    `)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (query.trim()) {
    const s = query.trim()
    q = q.or(
      `first_name.ilike.%${s}%,last_name.ilike.%${s}%,legal_name.ilike.%${s}%,trade_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`
    )
  }

  const { data, error } = await q
  if (error) throw error

  return (data ?? []).map((c: any) => {
    const memberships = c.customer_memberships ?? []
    const activeMembership = memberships.find((m: any) => m.status === 'active')
    const expiringMembership = memberships.find((m: any) => m.status === 'past_due')

    return {
      ...c,
      vehicle_count: Array.isArray(c.vehicles) ? c.vehicles.length : (c.vehicles?.[0]?.count ?? 0),
      membership_status: activeMembership ? 'active' : expiringMembership ? 'expiring' : 'none',
      membership_plan: activeMembership?.membership_plans?.name ?? expiringMembership?.membership_plans?.name ?? null,
    }
  })
}

export async function getCustomerVehicles(customerId: string): Promise<Vehicle[]> {
  const { data, error } = await supabase
    .from('vehicles' as any)
    .select('*')
    .eq('customer_id', customerId)
    .eq('active', true)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as Vehicle[]
}

export async function getCustomerMetrics(customerId: string) {
  const { data, error } = await supabase
    .from('v_customer_metrics' as any)
    .select('*')
    .eq('customer_id', customerId)
    .single()
  if (error) return null
  return data
}

export async function createCustomer(payload: {
  first_name?: string
  last_name?: string
  legal_name?: string
  phone?: string
  email?: string
  customer_type: 'individual' | 'company'
  organization_id: string
}) {
  const { data, error } = await (supabase as any)
    .from('customers')
    .insert([payload])
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateCustomer(id: string, patch: Partial<Customer>) {
  const { data, error } = await (supabase as any)
    .from('customers')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getMembershipPlans(organizationId: string) {
  const { data, error } = await supabase
    .from('membership_plans' as any)
    .select('id, name, price, billing_cycle, vehicle_type_id')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .order('price')
  if (error) throw error
  return data ?? []
}

export async function checkPlateConflict(plate: string, currentCustomerId: string) {
  const normalized = plate.toUpperCase().replace(/\s+/g, ' ').trim()
  const { data, error } = await supabase
    .from('vehicles' as any)
    .select('id, customer_id, customers:customer_id(first_name, last_name, legal_name, trade_name)')
    .eq('normalized_plate', normalized)
    .eq('active', true)
    .neq('customer_id', currentCustomerId)
    .maybeSingle()
  if (error) throw error
  return data as any
}

export async function addVehicleToCustomer(payload: {
  customer_id: string
  organization_id: string
  plate: string
  brand?: string
  model?: string
  vehicle_type_id?: string
}) {
  const { data, error } = await (supabase as any)
    .from('vehicles')
    .insert([{
      ...payload,
      normalized_plate: payload.plate.toUpperCase().replace(/\s+/g, ' ').trim(),
      active: true,
    }])
    .select()
    .single()
  if (error) throw error
  return data
}

export async function transferVehicleOwnership(vehicleId: string, newCustomerId: string) {
  const { data, error } = await (supabase.rpc as any)('transfer_vehicle_ownership', {
    p_vehicle_id: vehicleId,
    p_new_customer_id: newCustomerId,
  })
  if (error) throw error
  return data
}
