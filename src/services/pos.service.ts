import { supabase } from '../lib/supabase'

export interface PlateSearchResult {
  vehicle: {
    id: string
    plate: string
    normalized_plate: string
    brand?: string
    model?: string
    year?: number
    color?: string
    notes?: string
    vehicle_type_id?: string
  }
  customer: {
    id: string
    customer_type: string
    first_name?: string
    last_name?: string
    legal_name?: string
    trade_name?: string
    dui?: string
    nit?: string
    nrc?: string
    phone?: string
    email?: string
  }
  membership: {
    id: string | null
    status: string
    plan_name: string | null
    expires_at: string | null
    covers_service: boolean
  } | null
  ar_overdue: boolean
  ar_overdue_amount: number
  days_since_last_visit: number | null
  lifetime_orders: number
}

export async function searchByPlate(plate: string): Promise<PlateSearchResult | null> {
  const normalized = plate.toUpperCase().replace(/\s+/g, ' ').trim()

  const { data: vehicle, error: ve } = await supabase
    .from('vehicles' as any)
    .select('*')
    .eq('normalized_plate', normalized)
    .eq('active', true)
    .maybeSingle()

  if (ve) throw ve
  if (!vehicle) return null

  const v = vehicle as any

  // Load customer
  const { data: customer, error: ce } = await supabase
    .from('customers' as any)
    .select('*')
    .eq('id', v.customer_id)
    .single()

  if (ce) throw ce
  const c = customer as any

  // Load active membership
  const { data: membershipRaw } = await supabase
    .from('customer_memberships' as any)
    .select('id, status, expires_at, membership_plans:plan_id(name)')
    .eq('customer_id', c.id)
    .eq('status', 'active')
    .maybeSingle()

  const membership = membershipRaw as any

  // Load customer metrics
  const { data: metricsRaw } = await supabase
    .from('v_customer_metrics' as any)
    .select('days_since_last_visit, total_orders, lifetime_value, segment')
    .eq('customer_id', c.id)
    .maybeSingle()

  const metrics = metricsRaw as any

  // Check AR overdue (> 60 days)
  let arOverdue = false
  let arOverdueAmount = 0
  const { data: arRaw } = await supabase
    .from('ar_aging' as any)
    .select('amount_60_plus')
    .eq('customer_id', c.id)
    .maybeSingle()

  const ar = arRaw as any
  if (ar && ar.amount_60_plus > 0) {
    arOverdue = true
    arOverdueAmount = ar.amount_60_plus
  }

  return {
    vehicle: v,
    customer: c,
    membership: membership ? {
      id: membership.id,
      status: membership.status,
      plan_name: membership.membership_plans?.name ?? null,
      expires_at: membership.expires_at,
      covers_service: true,
    } : null,
    ar_overdue: arOverdue,
    ar_overdue_amount: arOverdueAmount,
    days_since_last_visit: metrics?.days_since_last_visit ?? null,
    lifetime_orders: metrics?.total_orders ?? 0,
  }
}

export async function getServiceCatalog(organizationId: string) {
  const { data, error } = await supabase
    .from('services' as any)
    .select('id, name, description, base_duration_minutes, category_id, service_categories:category_id(name)')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .order('name')

  if (error) throw error
  return (data ?? []) as any[]
}

export async function getServicePrice(serviceId: string, vehicleTypeId: string, branchId: string): Promise<number | null> {
  const { data, error } = await (supabase.rpc as any)('get_service_price', {
    p_service_id: serviceId,
    p_vehicle_type_id: vehicleTypeId,
    p_branch_id: branchId,
  })
  if (error) return null
  return data
}

export async function getVehicleTypes(organizationId: string) {
  const { data, error } = await supabase
    .from('vehicle_types' as any)
    .select('id, name, slug')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .order('display_order')
  if (error) throw error
  return (data ?? []) as any[]
}

export async function getAvailableEmployees(branchId: string, date?: string) {
  const { data, error } = await supabase
    .from('employee_shifts' as any)
    .select('id, employee_id, status, employees:employee_id(id, first_name, last_name, employee_number)')
    .eq('branch_id', branchId)
    .eq('shift_date', date ?? new Date().toISOString().split('T')[0])
    .in('status', ['active', 'break'])
    .order('created_at')

  if (error) throw error
  return (data ?? []).map((s: any) => ({
    shiftId: s.id,
    employeeId: s.employee_id,
    name: `${s.employees?.first_name ?? ''} ${s.employees?.last_name ?? ''}`.trim(),
    number: s.employees?.employee_number ?? '',
    available: s.status === 'active',
  }))
}

export async function getEquipmentByBranch(branchId: string) {
  const { data, error } = await supabase
    .from('equipment' as any)
    .select('id, name, code, status')
    .eq('branch_id', branchId)
    .eq('type', 'machine')
    .eq('active', true)
    .order('code')
  if (error) throw error
  return (data ?? []) as any[]
}

export interface CreateOrderPayload {
  branch_id: string
  customer_id: string
  vehicle_id: string
  service_id: string
  vehicle_type_id?: string
  equipment_id?: string
  employee_id?: string
  additional_service_ids?: string[]
  payment_method: string
  amount_paid: number
  notes?: string
}

export async function createWorkOrder(payload: CreateOrderPayload) {
  const { data, error } = await (supabase.rpc as any)('create_work_order', payload)
  if (error) throw error
  return data
}
