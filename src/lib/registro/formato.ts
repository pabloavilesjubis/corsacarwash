/**
 * CORSA — piezas comunes de los formularios públicos de registro: el de
 * clientes por QR (RegistroPage, 0055) y el de empleados con beneficio
 * corporativo (BeneficioRegistroPage, 0079). Las mismas reglas que validan
 * public_customer_signup y public_benefit_signup.
 */

export type Tamano = 'S' | 'M' | 'L'

export interface Vehiculo { placa: string; marca: string; modelo: string; color: string; tamano: Tamano | '' }

export const TAMANOS: { id: Tamano; nombre: string; ejemplo: string }[] = [
  { id: 'S', nombre: 'Pequeño', ejemplo: 'Sedán, hatchback' },
  { id: 'M', nombre: 'Mediano', ejemplo: 'SUV, crossover' },
  { id: 'L', nombre: 'Grande', ejemplo: 'Pickup, van, SUV grande' },
]

export const vacio = (): Vehiculo => ({ placa: '', marca: '', modelo: '', color: '', tamano: '' })
export const digitos = (s: string) => s.replace(/[^0-9]/g, '')

/** 7777-8888 mientras se escribe si es de El Salvador; de otro país, sólo dígitos. */
export function formatoTelefono(s: string, pais: string) {
  if (digitos(pais) !== '503') return digitos(s).slice(0, 14)
  const d = digitos(s).slice(0, 8)
  return d.length > 4 ? `${d.slice(0, 4)}-${d.slice(4)}` : d
}
/** «+503» mientras se escribe: el + fijo y hasta 4 dígitos. */
export function formatoPais(s: string) {
  return '+' + digitos(s).slice(0, 4)
}
/** ¿El teléfono es válido para ese país? Igual que en public_customer_signup (0056). */
export function telefonoValido(tel: string, pais: string) {
  const p = digitos(pais), t = digitos(tel)
  if (!p) return false
  if (p === '503') return t.length === 8
  return t.length >= 4 && (p + t).length <= 15
}
/** 01234567-8 mientras se escribe. */
export function formatoDui(s: string) {
  const d = digitos(s).slice(0, 9)
  return d.length > 8 ? `${d.slice(0, 8)}-${d.slice(8)}` : d
}
