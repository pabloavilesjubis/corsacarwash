/**
 * CORSA Carwash — Core TypeScript types
 * 
 * These types match the database schema exactly.
 * Generated types should come from: supabase gen types typescript
 * This file provides hand-crafted types for use in the frontend
 * until the generated types are available.
 */

// ─────────────────────────────────────────────
// BASE
// ─────────────────────────────────────────────

export type UUID = string

export interface TimestampedRecord {
  created_at: string
  updated_at: string
}

// ─────────────────────────────────────────────
// ORGANIZATION
// ─────────────────────────────────────────────

export interface Organization {
  id: UUID
  legal_name: string
  trade_name: string | null
  code: string
  country: string
  timezone: string
  currency: string
  tax_id: string | null
  phone: string | null
  email: string | null
  address: string | null
  logo_path: string | null
  active: boolean
  created_at: string
  updated_at: string
}

// ─────────────────────────────────────────────
// BRANCH
// ─────────────────────────────────────────────

export interface Branch {
  id: UUID
  organization_id: UUID
  code: string
  name: string
  address: string | null
  phone: string | null
  email: string | null
  timezone: string
  opening_time: string | null
  closing_time: string | null
  active: boolean
  created_at: string
  updated_at: string
}

// ─────────────────────────────────────────────
// PROFILE (User)
// ─────────────────────────────────────────────

export interface Profile {
  id: UUID
  organization_id: UUID
  first_name: string
  last_name: string
  display_name: string | null
  phone: string | null
  avatar_path: string | null
  default_branch_id: UUID | null
  active: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
}

// ─────────────────────────────────────────────
// RBAC
// ─────────────────────────────────────────────

export interface Role {
  id: UUID
  organization_id: UUID
  name: string
  description: string | null
  is_system: boolean
  active: boolean
}

export interface Permission {
  id: UUID
  code: string
  description: string | null
  module: string
}

// ─────────────────────────────────────────────
// CUSTOMER
// ─────────────────────────────────────────────

export type CustomerType = 'individual' | 'company'

export interface Customer {
  id: UUID
  organization_id: UUID
  customer_type: CustomerType
  first_name: string | null
  last_name: string | null
  legal_name: string | null
  trade_name: string | null
  dui: string | null
  normalized_dui: string | null
  nit: string | null
  normalized_nit: string | null
  nrc: string | null
  phone: string | null
  normalized_phone: string | null
  whatsapp: string | null
  email: string | null
  address: string | null
  billing_address: string | null
  preferred_branch_id: UUID | null
  source: string | null
  notes: string | null
  active: boolean
  created_at: string
  updated_at: string
  created_by: UUID | null
  updated_by: UUID | null
}

export type CustomerWithDisplayName = Customer & {
  display_name: string
}

// ─────────────────────────────────────────────
// VEHICLE
// ─────────────────────────────────────────────

export interface VehicleType {
  id: UUID
  organization_id: UUID
  code: string
  name: string
  size_category: 'small' | 'medium' | 'large' | 'xl'
  active: boolean
  sort_order: number
}

export interface Vehicle {
  id: UUID
  organization_id: UUID
  customer_id: UUID
  vehicle_type_id: UUID
  plate: string | null
  normalized_plate: string | null
  brand: string | null
  model: string | null
  year: number | null
  color: string | null
  vin: string | null
  notes: string | null
  active: boolean
  created_at: string
  updated_at: string
}

// ─────────────────────────────────────────────
// SERVICES
// ─────────────────────────────────────────────

export interface ServiceCategory {
  id: UUID
  organization_id: UUID
  name: string
  sort_order: number
  active: boolean
}

export interface Service {
  id: UUID
  organization_id: UUID
  category_id: UUID | null
  code: string
  name: string
  description: string | null
  estimated_minutes: number | null
  taxable: boolean
  active: boolean
  sort_order: number
}

export interface ServicePrice {
  id: UUID
  organization_id: UUID
  branch_id: UUID | null
  service_id: UUID
  vehicle_type_id: UUID
  price: number
  effective_from: string
  effective_to: string | null
  active: boolean
}

// ─────────────────────────────────────────────
// WORK ORDER
// ─────────────────────────────────────────────

export type WorkOrderStatus =
  | 'received'
  | 'waiting'
  | 'washing'
  | 'drying_detailing'
  | 'quality_control'
  | 'ready'
  | 'paid'
  | 'delivered'
  | 'cancelled'

export type WorkOrderPaymentStatus = 'pending' | 'partial' | 'paid' | 'refunded'

export interface WorkOrder {
  id: UUID
  organization_id: UUID
  branch_id: UUID
  order_number: string
  customer_id: UUID | null
  vehicle_id: UUID | null
  appointment_id: UUID | null
  source: 'walk_in' | 'appointment' | 'fleet' | 'online' | 'phone'
  priority: 'normal' | 'high' | 'vip'
  status: WorkOrderStatus
  checked_in_at: string | null
  started_at: string | null
  completed_at: string | null
  ready_at: string | null
  delivered_at: string | null
  cancelled_at: string | null
  subtotal: number
  discount_total: number
  tax_total: number
  tip_total: number
  total: number
  payment_status: WorkOrderPaymentStatus
  notes: string | null
  created_by: UUID | null
  created_at: string
  updated_at: string
}

export interface WorkOrderItem {
  id: UUID
  work_order_id: UUID
  service_id: UUID
  description_snapshot: string
  price_snapshot: number
  quantity: number
  unit_price: number
  discount_amount: number
  tax_amount: number
  total: number
  membership_covered: boolean
  membership_usage_id: UUID | null
  sort_order: number
  created_at: string
}

// ─────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────

export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'voided' | 'refunded'

export interface PaymentMethod {
  id: UUID
  organization_id: UUID
  branch_id: UUID | null
  code: string
  name: string
  type: 'cash' | 'card' | 'bank_transfer' | 'corporate_credit' | 'membership' | 'coupon' | 'other'
  requires_reference: boolean
  active: boolean
  sort_order: number
}

export interface Payment {
  id: UUID
  organization_id: UUID
  branch_id: UUID
  payment_method_id: UUID
  amount: number
  amount_tendered: number | null
  change_given: number | null
  currency: string
  status: PaymentStatus
  external_reference: string | null
  authorization_code: string | null
  received_by: UUID | null
  created_at: string
}

// ─────────────────────────────────────────────
// CREATE WORK ORDER RPC payload
// ─────────────────────────────────────────────

export interface CreateWorkOrderPayload {
  p_branch_id: UUID
  p_customer_id: UUID | null
  p_vehicle_id: UUID | null
  p_source?: string
  p_priority?: string
  p_notes?: string | null
  p_services?: Array<{
    service_id: UUID
    quantity: number
    unit_price: number
    discount_amount?: number
  }>
}

export interface CreateWorkOrderResult {
  order_id: UUID
  order_number: string
  subtotal: number
  tax_total: number
  total: number
}

// ─────────────────────────────────────────────
// REGISTER PAYMENT RPC payload
// ─────────────────────────────────────────────

export interface RegisterPaymentItem {
  payment_method_id: UUID
  amount: number
  amount_tendered?: number
  external_reference?: string
  authorization_code?: string
  idempotency_key?: string
}

// ─────────────────────────────────────────────
// DASHBOARD KPIs
// ─────────────────────────────────────────────

export interface DashboardKPIs {
  today: {
    total_orders: number
    completed_orders: number
    cancelled_orders: number
    gross_revenue: number
    avg_ticket: number
    total_discounts: number
  }
  yesterday: {
    total_orders: number
    gross_revenue: number
  }
  open_orders: {
    count: number
    by_status: Record<WorkOrderStatus, number>
  }
  date: string
}

// ─────────────────────────────────────────────
// MEMBERSHIP
// ─────────────────────────────────────────────

export type MembershipStatus = 'pending' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'expired'

export interface CustomerMembership {
  id: UUID
  customer_id: UUID
  plan_id: UUID
  vehicle_id: UUID | null
  starts_at: string
  expires_at: string
  next_billing_at: string | null
  status: MembershipStatus
  price_snapshot: number
  auto_renew: boolean
}

// ─────────────────────────────────────────────
// DATABASE GENERATED TYPES PLACEHOLDER
// Run: supabase gen types typescript --local > src/types/database.types.ts
// ─────────────────────────────────────────────
export type Database = {
  public: {
    Tables: Record<string, unknown>
    Views: Record<string, unknown>
    Functions: Record<string, unknown>
    Enums: Record<string, unknown>
  }
}
