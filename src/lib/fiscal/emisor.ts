/**
 * CORSA Carwash — El emisor que se imprime, leído de `fiscal_issuer_config`
 *
 * Es la misma fila de la que el Worker fiscal arma el emisor del DTE. Leerla
 * de ahí —y no de una constante en el código— es lo que garantiza que el NIT,
 * el NRC y la dirección del papel sean los del documento sellado: cambiar un
 * dato en la base cambia los dos a la vez.
 *
 * No hay datos fiscales de respaldo. Si la fila falta o está incompleta:
 *   - un documento fiscal (factura carta, ticket con DTE) NO se imprime, y el
 *     error dice qué falta: «Configuración fiscal del emisor incompleta…»;
 *   - el ticket sin DTE sale sólo con la marca y rotulado «Sin validez
 *     fiscal»: es también la orden del equipo en piso y no puede frenarse.
 */

import { supabase } from '../supabase'
import { findDepartamento, findMunicipio } from '../mh-catalogs'
import type { TicketEmisor } from '../ticket/corsaTicket'

/** La marca, sin datos fiscales. Para cupones y para el ticket sin DTE. */
export const MARCA: TicketEmisor = { nombreComercial: 'CORSA CARWASH' }

/** Las columnas de `fiscal_issuer_config` que se imprimen. */
export interface FilaEmisor {
  nit: string | null
  nrc: string | null
  nombre: string | null
  nombre_comercial: string | null
  cod_actividad: string | null
  desc_actividad: string | null
  departamento: string | null
  municipio: string | null
  complemento: string | null
  telefono: string | null
  correo: string | null
}

const COLUMNAS = 'nit, nrc, nombre, nombre_comercial, cod_actividad, desc_actividad, ' +
  'departamento, municipio, complemento, telefono, correo'

/**
 * Sin éstos no se imprime un documento fiscal. Son los que el Worker exige
 * para emitir (corsa-fiscal-api, validation/emisor.ts); el teléfono lo piden
 * los schemas de los cuatro tipos de DTE.
 */
const OBLIGATORIOS: (keyof FilaEmisor)[] = [
  'nit', 'nrc', 'nombre', 'cod_actividad', 'desc_actividad',
  'departamento', 'municipio', 'complemento', 'telefono', 'correo',
]

export class ConfiguracionFiscalIncompleta extends Error {
  readonly faltantes: string[]
  constructor(faltantes: string[]) {
    super(`Configuración fiscal del emisor incompleta: ${faltantes.join('; ')}. ` +
      'No se imprime el documento fiscal hasta completarla.')
    this.name = 'ConfiguracionFiscalIncompleta'
    this.faltantes = faltantes
  }
}

export type EstadoEmisor =
  | { completo: true; emisor: TicketEmisor }
  | { completo: false; faltantes: string[] }

/** 06231909241018 → 0623-190924-101-8. Otro largo se deja como está. */
export function formatearNit(nit: string): string {
  const d = nit.replace(/\D/g, '')
  return d.length === 14 ? `${d.slice(0, 4)}-${d.slice(4, 10)}-${d.slice(10, 13)}-${d.slice(13)}` : nit
}

/** 3491162 → 349116-2: el último dígito es el verificador. */
export function formatearNrc(nrc: string): string {
  const d = nrc.replace(/\D/g, '')
  return d.length >= 2 ? `${d.slice(0, -1)}-${d.slice(-1)}` : nrc
}

const vacio = (v: unknown) => v == null || String(v).trim() === ''

/**
 * La fila en la forma que imprime el ticket, o lo que le falta. El DTE lleva
 * la dirección como códigos de catálogo; en el papel tienen que leerse, así
 * que un código que el catálogo no conoce cuenta como faltante.
 */
export function revisarFilaEmisor(fila: FilaEmisor | null): EstadoEmisor {
  if (!fila) {
    return { completo: false, faltantes: ['la sucursal no tiene una fila activa en fiscal_issuer_config'] }
  }
  const faltantes = OBLIGATORIOS.filter(c => vacio(fila[c])).map(c => `falta ${c}`)
  const dep = vacio(fila.departamento) ? undefined : findDepartamento(fila.departamento as string)
  const mun = vacio(fila.municipio) || !dep
    ? undefined
    : findMunicipio(fila.departamento as string, fila.municipio as string)
  if (!vacio(fila.departamento) && !dep) faltantes.push(`departamento ${fila.departamento} no está en el catálogo`)
  if (dep && !vacio(fila.municipio) && !mun) faltantes.push(`municipio ${fila.municipio} no está en el catálogo`)
  if (faltantes.length > 0) return { completo: false, faltantes }

  return {
    completo: true,
    emisor: {
      nombreComercial: fila.nombre_comercial || MARCA.nombreComercial,
      razonSocial: fila.nombre as string,
      nit: formatearNit(fila.nit as string),
      nrc: formatearNrc(fila.nrc as string),
      direccion: [fila.complemento, mun?.nombre, dep?.nombre].filter(Boolean).join(', '),
      telefono: fila.telefono as string,
      correo: fila.correo as string,
      codActividad: fila.cod_actividad as string,
      descActividad: fila.desc_actividad as string,
    },
  }
}

/**
 * Una lectura por sucursal mientras la pestaña está abierta. Se guarda la
 * promesa, así dos impresiones simultáneas no piden dos veces; un fallo de red
 * no se guarda, para que la próxima impresión lo vuelva a intentar.
 */
const cache = new Map<string, Promise<EstadoEmisor>>()

export function cargarEmisor(branchId: string | null | undefined): Promise<EstadoEmisor> {
  if (!branchId) return Promise.resolve({ completo: false, faltantes: ['no hay sucursal seleccionada'] })
  const guardado = cache.get(branchId)
  if (guardado) return guardado

  const lectura = (async (): Promise<EstadoEmisor> => {
    const { data, error } = await (supabase as any)
      .from('fiscal_issuer_config')
      .select(COLUMNAS)
      .eq('branch_id', branchId)
      .eq('activo', true)
      .maybeSingle()
    if (error) throw error
    return revisarFilaEmisor((data ?? null) as FilaEmisor | null)
  })()

  lectura.catch(() => cache.delete(branchId))
  cache.set(branchId, lectura)
  return lectura
}

/** El emisor completo, o un error que dice qué falta. Para documentos fiscales. */
export async function exigirEmisor(branchId: string | null | undefined): Promise<TicketEmisor> {
  let estado: EstadoEmisor
  try {
    estado = await cargarEmisor(branchId)
  } catch {
    throw new Error('No se pudo leer la configuración fiscal del emisor. Revisá la conexión y reintentá.')
  }
  if (!estado.completo) throw new ConfiguracionFiscalIncompleta(estado.faltantes)
  return estado.emisor
}

/**
 * El emisor de un ticket. Con DTE es un documento fiscal y se exige completo.
 * Sin DTE, si la configuración no alcanza, sale con la marca sola: el ticket
 * lo rotula «Sin validez fiscal» al no tener NIT (ver corsaTicket).
 */
export async function emisorParaTicket(
  branchId: string | null | undefined, conDte: boolean,
): Promise<TicketEmisor> {
  if (conDte) return exigirEmisor(branchId)
  const estado = await cargarEmisor(branchId).catch(() => null)
  return estado?.completo ? estado.emisor : MARCA
}
