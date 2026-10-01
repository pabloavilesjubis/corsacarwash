/**
 * CORSA Carwash — Contabilidad: lógica compartida por los formularios, sin
 * componentes (así comunes.tsx conserva el recargado en caliente).
 */

import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import {
  fetchEstadoServicio, type EstadoServicio, type Persona, type ResultadoFiscal,
} from '../../services/fiscal.service'

/** Contra qué ambiente de Hacienda emite el servicio fiscal. */
export function useServicioFiscal(): EstadoServicio | null {
  const [estado, setEstado] = useState<EstadoServicio | null>(null)
  useEffect(() => { fetchEstadoServicio().then(setEstado) }, [])
  return estado
}

/**
 * El número de documento tiene que tener la forma de su tipo. Hacienda no lo
 * cruza —acepta un DUI declarado como pasaporte—, así que es acá o nunca.
 */
export function problemaDeDocumento(tipo: string, numero: string): string | null {
  const n = numero.trim()
  if (!n) return 'Falta el número de documento'
  if (tipo === '13' && !/^\d{9}$/.test(n)) return 'Un DUI son 9 dígitos, sin guion'
  if (tipo === '36' && !/^(\d{14}|\d{9})$/.test(n)) return 'Un NIT son 14 dígitos (o 9 si es el DUI homologado)'
  if ((tipo === '03' || tipo === '02') && /^\d{9}$/.test(n)) {
    return 'Ese número tiene forma de DUI. Si es un DUI, elegí DUI como tipo de documento.'
  }
  if (n.length < 3) return 'El número de documento es demasiado corto'
  return null
}

/** Cuenta al usuario qué pasó con lo que mandó, en sus términos. */
export function avisarResultado(r: ResultadoFiscal, que: string): 'listo' | 'pendiente' | 'rechazado' | 'error' {
  if (r.estado === 'ACCEPTED') {
    toast.success(`${que} aceptado por Hacienda${r.numeroControl ? ` · ${r.numeroControl}` : ''}`)
    return 'listo'
  }
  if (r.estado === 'REJECTED') return 'rechazado'
  if (r.reintentable) {
    toast(`Hacienda no respondió. ${que} queda pendiente y se puede reintentar desde el historial.`, { icon: '⏳', duration: 7000 })
    return 'pendiente'
  }
  return 'error'
}

/** Una llave por formulario: el doble clic y el reintento reusan la misma. */
export function nuevaLlave(): string {
  return crypto.randomUUID()
}

/** El responsable se recuerda en este navegador: casi siempre es la misma persona. */
const CLAVE_RESPONSABLE = 'corsa.contabilidad.responsable'

export function responsableRecordado(): Persona {
  try {
    const crudo = localStorage.getItem(CLAVE_RESPONSABLE)
    if (crudo) return JSON.parse(crudo) as Persona
  } catch { /* sin almacenamiento: se escribe de nuevo */ }
  return { nombre: '', tipoDocumento: '13', numDocumento: '' }
}

export function recordarResponsable(p: Persona) {
  try { localStorage.setItem(CLAVE_RESPONSABLE, JSON.stringify(p)) } catch { /* no es crítico */ }
}
