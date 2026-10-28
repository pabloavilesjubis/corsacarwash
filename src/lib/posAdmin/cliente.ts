/**
 * CORSA — el cliente en el POS administrativo: la misma base de clientes que
 * la caja, con las columnas que piden el FCF y el CCF.
 */

import { supabase } from '../supabase'

export interface ClienteAdmin {
  id: string
  customer_type: string
  first_name: string | null
  last_name: string | null
  trade_name: string | null
  legal_name: string | null
  nit: string | null
  nrc: string | null
  dui: string | null
  email: string | null
  phone: string | null
  fiscal_document_type: string | null
  fiscal_doc_type: string | null
  fiscal_doc_number: string | null
  cod_actividad: string | null
  desc_actividad: string | null
  fiscal_departamento: string | null
  fiscal_municipio: string | null
  fiscal_complemento: string | null
  billing_email: string | null
}

const COLUMNAS = 'id, customer_type, first_name, last_name, trade_name, legal_name, nit, nrc, dui, email, phone, ' +
  'fiscal_document_type, fiscal_doc_type, fiscal_doc_number, cod_actividad, desc_actividad, ' +
  'fiscal_departamento, fiscal_municipio, fiscal_complemento, billing_email'

export function nombreCliente(c: ClienteAdmin): string {
  if (c.customer_type === 'company') return c.legal_name || c.trade_name || '—'
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
}

/** Por nombre, razón social, nombre comercial, NIT o DUI. */
export async function buscarClientes(texto: string): Promise<ClienteAdmin[]> {
  // Coma y paréntesis rompen el filtro .or() de PostgREST.
  const term = texto.trim().replace(/[,()*]/g, ' ').trim()
  if (term.length < 2) return []
  const { data } = await (supabase as any)
    .from('customers')
    .select(COLUMNAS)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,trade_name.ilike.%${term}%,legal_name.ilike.%${term}%,nit.ilike.%${term}%,dui.ilike.%${term}%`)
    .eq('active', true)
    .limit(8)
  return data ?? []
}

export async function cargarCliente(id: string): Promise<ClienteAdmin | null> {
  const { data } = await (supabase as any).from('customers').select(COLUMNAS).eq('id', id).maybeSingle()
  return data ?? null
}
