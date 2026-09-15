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

/**
 * Campos que la ficha de cliente puede escribir.
 * Los fiscales van juntos porque el CHECK de CCF en la base los evalúa como
 * conjunto: mandar la mitad hace fallar el insert entero.
 */
export interface CustomerWritableFields {
  customer_type: 'individual' | 'company'
  first_name?: string | null
  last_name?: string | null
  legal_name?: string | null
  trade_name?: string | null
  phone?: string | null
  email?: string | null
  dui?: string | null
  nit?: string | null
  nrc?: string | null
  address?: string | null
  notes?: string | null
  // Fiscales — ver 0029_customer_fiscal_dte.sql
  fiscal_document_type?: 'fcf' | 'ccf'
  fiscal_doc_type?: string | null
  fiscal_doc_number?: string | null
  cod_actividad?: string | null
  desc_actividad?: string | null
  fiscal_departamento?: string | null
  fiscal_municipio?: string | null
  fiscal_complemento?: string | null
  billing_email?: string | null
}

export async function createCustomer(payload: CustomerWritableFields & {
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

/**
 * Tipos de vehículo del catálogo (0008). Hacen falta para dar de alta uno:
 * la columna es obligatoria, así que sin tipo el alta no entra.
 */
export async function fetchVehicleTypes(organizationId: string) {
  const { data, error } = await (supabase as any)
    .from('vehicle_types')
    .select('id, code, name, size_category')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .order('sort_order')
  if (error) throw error
  return (data ?? []) as { id: string; code: string; name: string; size_category: string }[]
}

export async function addVehicleToCustomer(payload: {
  customer_id: string
  organization_id: string
  plate: string
  brand?: string | null
  model?: string | null
  color?: string | null
  /** Si no viene, se usa el primero del catálogo: el tipo es obligatorio en la base. */
  vehicle_type_id?: string
}) {
  let tipo = payload.vehicle_type_id
  if (!tipo) {
    const tipos = await fetchVehicleTypes(payload.organization_id)
    tipo = tipos[0]?.id
    if (!tipo) throw new Error('No hay tipos de vehículo configurados')
  }

  // `normalized_plate` NO se manda: en la base es una columna generada
  // (0008_vehicles.sql). Escribirla hace que Postgres rechace el insert
  // entero, así que el alta de vehículos fallaba siempre desde la app.
  const { data, error } = await (supabase as any)
    .from('vehicles')
    .insert([{
      customer_id: payload.customer_id,
      organization_id: payload.organization_id,
      vehicle_type_id: tipo,
      plate: payload.plate.toUpperCase().trim(),
      brand: payload.brand || null,
      model: payload.model || null,
      color: payload.color || null,
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
