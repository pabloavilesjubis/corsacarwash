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

/** Los tres tamaños que son, a la vez, las tres tarifas del POS (0040). */
export type TamanoVehiculo = 'S' | 'M' | 'L'

/**
 * De la categoría del catálogo al tamaño que cobra el POS.
 *
 * `xl` cae en L: es el más grande que existe en la tarifa. Antes de la 0040 el
 * catálogo tenía seis carrocerías, y algún vehículo viejo puede seguir
 * apuntando a una de ellas — por eso la traducción vive acá y no se asume que
 * el tipo ya sea S, M o L.
 */
export function tamanoDeCategoria(categoria?: string | null): TamanoVehiculo {
  if (categoria === 'small') return 'S'
  if (categoria === 'medium') return 'M'
  return 'L'
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

/**
 * Un tipo de vehículo por tamaño, para el selector de alta.
 *
 * Después de la 0040 el catálogo activo son exactamente tres, así que esto
 * devuelve esos tres. Si la migración todavía no se corrió, agrupa las
 * carrocerías por categoría y se queda con una de cada una: el selector
 * muestra S, M y L igual, y el alta sigue guardando un tipo válido.
 */
export async function fetchTamanosVehiculo(organizationId: string): Promise<
  { id: string; tamano: TamanoVehiculo; nombre: string }[]
> {
  const tipos = await fetchVehicleTypes(organizationId)
  const orden: TamanoVehiculo[] = ['S', 'M', 'L']
  const porTamano = new Map<TamanoVehiculo, { id: string; tamano: TamanoVehiculo; nombre: string }>()

  for (const t of tipos) {
    const tamano = tamanoDeCategoria(t.size_category)
    // El primero de cada tamaño gana: fetchVehicleTypes viene por sort_order,
    // así que es el más representativo del catálogo.
    if (!porTamano.has(tamano)) porTamano.set(tamano, { id: t.id, tamano, nombre: t.name })
  }

  return orden.filter(t => porTamano.has(t)).map(t => porTamano.get(t)!)
}

/**
 * Qué tamaño es cada tipo, incluidos los desactivados.
 *
 * Sin los inactivos, un vehículo registrado antes de la 0040 no tendría
 * traducción y el POS no podría preseleccionarle la tarifa.
 */
export async function fetchMapaTamanos(organizationId: string): Promise<Record<string, TamanoVehiculo>> {
  const { data, error } = await (supabase as any)
    .from('vehicle_types')
    .select('id, size_category')
    .eq('organization_id', organizationId)
  if (error) return {}

  const mapa: Record<string, TamanoVehiculo> = {}
  for (const t of (data ?? []) as any[]) mapa[t.id] = tamanoDeCategoria(t.size_category)
  return mapa
}
