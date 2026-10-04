/**
 * CORSA — carga masiva de clientes desde Excel.
 *
 * Toma las filas del directorio (las 10 columnas de abajo) y las convierte en
 * fichas listas para `customers`, sin tocar la base. La pantalla muestra el
 * resultado fila por fila y sólo inserta cuando el usuario confirma.
 *
 *   Nombre / Razón social · Nombre comercial · NIT · NRC · Documento ·
 *   Cód. actividad · Giro · Teléfono · Correo · Dirección
 *
 * QUÉ SE HACE CON UN DATO MALO
 * Un dato obligatorio que falta (el nombre) descarta la fila. Un dato
 * opcional mal escrito (un NIT de 12 dígitos, un correo sin @) se deja afuera
 * con un aviso y la fila se importa igual: la base rechazaría el insert
 * entero por los CHECK de 0029, y perder el cliente por su NIT es peor que
 * guardarlo sin NIT y completarlo después.
 *
 * CCF
 * Un cliente queda como CCF sólo si la ficha cumple TODO lo que la base exige
 * para eso (customers_ccf_requires_fiscal_data). Si no, queda como ticket y
 * el aviso dice qué le falta. La dirección del Excel es texto libre: el
 * departamento y el municipio se infieren de los nombres que aparezcan en
 * ella, y si no se encuentran sin ambigüedad, quedan vacíos.
 */

import {
  DEPARTAMENTOS, MUNICIPIOS_POR_DEPARTAMENTO, findActividad, onlyDigits, MH_PATTERNS,
} from '../mh-catalogs'
import type { CustomerWritableFields } from '../../services/customers.service'

export type Celda = string | number | boolean | Date | null | undefined

/** Los campos del Excel, por su nombre interno. */
type Campo =
  | 'nombre' | 'comercial' | 'nit' | 'nrc' | 'documento'
  | 'actividad' | 'giro' | 'telefono' | 'correo' | 'direccion'

/**
 * Encabezados aceptados para cada campo, ya normalizados (minúsculas, sin
 * tildes ni signos). Se aceptan variantes para que una plantilla con «Razón
 * social» o «Teléfono 1» no obligue a renombrar columnas.
 */
const ENCABEZADOS: Record<Campo, string[]> = {
  nombre:    ['nombre razon social', 'nombre', 'razon social', 'cliente', 'nombre o razon social'],
  comercial: ['nombre comercial', 'comercial'],
  nit:       ['nit'],
  nrc:       ['nrc', 'registro', 'no registro', 'numero de registro'],
  documento: ['documento', 'dui', 'documento de identidad', 'no documento'],
  actividad: ['cod actividad', 'codigo actividad', 'codigo de actividad', 'actividad', 'cod actividad economica'],
  giro:      ['giro', 'descripcion actividad', 'actividad economica'],
  telefono:  ['telefono', 'tel', 'celular', 'telefono 1'],
  correo:    ['correo', 'email', 'e mail', 'correo electronico'],
  direccion: ['direccion', 'domicilio', 'direccion fiscal'],
}

export const COLUMNAS_PLANTILLA = [
  'Nombre / Razón social', 'Nombre comercial', 'NIT', 'NRC', 'Documento',
  'Cód. actividad', 'Giro', 'Teléfono', 'Correo', 'Dirección',
]

export type EstadoFila = 'nuevo' | 'duplicado' | 'error'

export interface FilaInterpretada {
  /** Número de fila en el Excel (la 1 es el encabezado). */
  fila: number
  nombre: string
  estado: EstadoFila
  ficha: CustomerWritableFields | null
  /** Lo que impide importar la fila. */
  errores: string[]
  /** Lo que se dejó afuera o se dedujo; la fila se importa igual. */
  avisos: string[]
}

export interface ClienteExistente {
  normalized_nit: string | null
  normalized_dui: string | null
  nombre: string
}

export interface ResultadoInterpretacion {
  filas: FilaInterpretada[]
  /** Columnas del Excel que no se reconocieron (se ignoran). */
  ignoradas: string[]
}

// ─── Utilidades de texto ─────────────────────────────────────

export function normalizar(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * El texto de una celda. Un NIT o DUI escrito como número en Excel pierde el
 * cero inicial (06142402091999 → 6142402091999): `largo` lo repone.
 */
function texto(c: Celda, largo?: number): string {
  if (c === null || c === undefined) return ''
  if (typeof c === 'number') {
    const s = String(c)
    return largo && /^\d+$/.test(s) && s.length < largo ? s.padStart(largo, '0') : s
  }
  if (c instanceof Date) return ''
  return String(c).replace(/\s+/g, ' ').trim()
}

// ─── Empresa o persona ───────────────────────────────────────

const SUFIJOS_EMPRESA = new RegExp(
  '\\b(' + [
    's ?a', 's ?a ?de ?c ?v', 'sa de cv', 's de r ?l', 'ltda', 'limitada', 'inc', 'corp', 'corporacion',
    'cooperativa', 'asociacion', 'fundacion', 'sociedad', 'cia', 'compania', 'alcaldia', 'ministerio',
    'universidad', 'colegio', 'iglesia', 'hospital', 'banco', 'grupo', 'distribuidora', 'comercial',
    'industrias', 'servicios', 'inversiones', 'constructora', 'transportes', 'farmacia',
  ].join('|') + ')\\b',
)

export function pareceEmpresa(nombre: string): boolean {
  return SUFIJOS_EMPRESA.test(normalizar(nombre))
}

/**
 * Nombre y apellidos de una persona. En El Salvador lo usual es dos nombres y
 * dos apellidos: con cuatro o más palabras, dos y el resto; con tres, uno y
 * dos (es más común un nombre y dos apellidos que al revés).
 */
export function partirNombre(completo: string): { first_name: string; last_name: string | null } {
  const p = completo.split(' ').filter(Boolean)
  if (p.length <= 1) return { first_name: completo, last_name: null }
  const n = p.length >= 4 ? 2 : 1
  return { first_name: p.slice(0, n).join(' '), last_name: p.slice(n).join(' ') }
}

// ─── Dirección → departamento y municipio ────────────────────

/** Una palabra suelta del catálogo («Ilopango») buscada como palabra entera. */
function contiene(haystack: string, aguja: string): boolean {
  return (' ' + haystack + ' ').includes(' ' + normalizar(aguja) + ' ')
}

/**
 * Departamento y municipio de una dirección escrita a mano.
 *
 * Se busca el nombre de un municipio del catálogo; si aparece en un solo
 * departamento (o el departamento también está escrito), se toma. Si el texto
 * nombra dos municipios distintos, o uno que existe en dos departamentos sin
 * decir cuál, se deja vacío: un código equivocado es un CCF con la dirección
 * de otro lugar.
 */
export function inferirUbicacion(direccion: string): { departamento: string; municipio: string } | null {
  const t = normalizar(direccion)
  if (!t) return null

  const deptosNombrados = DEPARTAMENTOS.filter(d => contiene(t, d.nombre)).map(d => d.codigo)
  const candidatos: { departamento: string; municipio: string; largo: number }[] = []
  for (const [depto, munis] of Object.entries(MUNICIPIOS_POR_DEPARTAMENTO)) {
    for (const m of munis) {
      if (contiene(t, m.nombre)) candidatos.push({ departamento: depto, municipio: m.codigo, largo: normalizar(m.nombre).length })
    }
  }
  if (candidatos.length === 0) return null

  // «Santa Tecla, La Libertad»: La Libertad es el departamento pero también
  // un municipio. Si hay otro municipio nombrado, el que se llama como un
  // departamento escrito en el texto es el departamento, no el municipio.
  const nombresDepto = new Set(DEPARTAMENTOS.filter(d => deptosNombrados.includes(d.codigo)).map(d => normalizar(d.nombre)))
  const nombreDe = (c: { departamento: string; municipio: string }) =>
    normalizar(MUNICIPIOS_POR_DEPARTAMENTO[c.departamento].find(m => m.codigo === c.municipio)!.nombre)
  const sinHomonimos = candidatos.filter(c => !nombresDepto.has(nombreDe(c)))
  const base = sinHomonimos.length > 0 ? sinHomonimos : candidatos

  // Un nombre que está DENTRO de otro que también apareció no cuenta: «San
  // Juan Opico» le gana a un «Opico» suelto. Dos municipios distintos
  // («Apopa y Mejicanos») siguen siendo dos, y eso es ambiguo.
  let elegidos = base.filter(c => !base.some(o =>
    o !== c && o.largo > c.largo && (' ' + nombreDe(o) + ' ').includes(' ' + nombreDe(c) + ' ')))
  if (deptosNombrados.length > 0) {
    const enDepto = elegidos.filter(c => deptosNombrados.includes(c.departamento))
    if (enDepto.length > 0) elegidos = enDepto
  }
  const distintos = new Set(elegidos.map(c => `${c.departamento}-${c.municipio}`))
  if (distintos.size !== 1) return null
  return { departamento: elegidos[0].departamento, municipio: elegidos[0].municipio }
}

// ─── La fila ─────────────────────────────────────────────────

function mapearEncabezados(encabezado: Celda[]): { indices: Partial<Record<Campo, number>>; ignoradas: string[] } {
  const indices: Partial<Record<Campo, number>> = {}
  const ignoradas: string[] = []
  encabezado.forEach((c, i) => {
    const original = texto(c)
    const n = normalizar(original)
    if (!n) return
    const campo = (Object.keys(ENCABEZADOS) as Campo[]).find(k => indices[k] === undefined && ENCABEZADOS[k].includes(n))
    if (campo) indices[campo] = i
    else ignoradas.push(original)
  })
  return { indices, ignoradas }
}

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function interpretarFila(fila: number, celda: (campo: Campo, largo?: number) => string): FilaInterpretada {
  const errores: string[] = []
  const avisos: string[] = []
  const nombre = celda('nombre')

  if (!nombre) {
    return { fila, nombre: '', estado: 'error', ficha: null, errores: ['Sin nombre o razón social'], avisos }
  }

  // ── Documentos ──
  let nit: string | null = null
  const nitTexto = celda('nit', 14)
  if (nitTexto) {
    const d = onlyDigits(nitTexto)
    // Un NIT-DUI de 9 dígitos escrito como número pierde el cero igual que el de 14.
    const dPad = d.length === 8 ? d.padStart(9, '0') : d.length === 13 ? d.padStart(14, '0') : d
    if (MH_PATTERNS.nit.test(dPad)) nit = dPad === d ? nitTexto : dPad
    else avisos.push(`NIT «${nitTexto}» no tiene 14 ni 9 dígitos: se omitió`)
  }

  let nrc: string | null = null
  const nrcTexto = celda('nrc')
  if (nrcTexto) {
    if (MH_PATTERNS.nrc.test(onlyDigits(nrcTexto))) nrc = nrcTexto
    else avisos.push(`NRC «${nrcTexto}» no es válido (hasta 8 dígitos): se omitió`)
  }

  let dui: string | null = null
  const docTexto = celda('documento', 9)
  if (docTexto) {
    const d = onlyDigits(docTexto)
    const conCero = d.length === 8 ? d.padStart(9, '0') : d
    if (conCero.length === 9 && /^[\d\s-]+$/.test(docTexto)) {
      dui = `${conCero.slice(0, 8)}-${conCero.slice(8)}`
    } else if (d.length === 14 && !nit) {
      nit = d
      avisos.push('El documento tiene 14 dígitos: se guardó como NIT')
    } else {
      avisos.push(`Documento «${docTexto}» no es un DUI (9 dígitos): se omitió`)
    }
  }
  // Desde 2021 el DUI es también el NIT de la persona (NIT-DUI homologado).
  if (!nit && dui && nrc) {
    nit = onlyDigits(dui)
    avisos.push('Sin NIT: se usó el DUI como NIT (homologado)')
  }

  // ── Actividad ──
  let codActividad: string | null = null
  const actTexto = celda('actividad', 5)
  if (actTexto) {
    const d = onlyDigits(actTexto)
    if (MH_PATTERNS.codActividad.test(d)) codActividad = d
    else avisos.push(`Código de actividad «${actTexto}» no es válido: se omitió`)
  }
  let descActividad: string | null = celda('giro') || null
  if (descActividad && descActividad.length > 150) {
    descActividad = descActividad.slice(0, 150)
    avisos.push('El giro pasaba de 150 caracteres: se recortó')
  }
  if (!descActividad && codActividad) descActividad = findActividad(codActividad)?.nombre ?? null

  // ── Contacto ──
  const telefono = celda('telefono') || null
  let correo: string | null = celda('correo') || null
  if (correo) {
    // Un directorio suele traer dos correos en la misma celda: se toma el primero.
    const primero = correo.split(/[;,\s]+/).find(Boolean) ?? ''
    if (CORREO.test(primero) && primero.length <= 100) {
      if (primero !== correo) avisos.push('Había más de un correo: se tomó el primero')
      correo = primero.toLowerCase()
    } else {
      avisos.push(`Correo «${correo}» no es válido: se omitió`)
      correo = null
    }
  }

  // ── Dirección ──
  const direccion = celda('direccion') || null
  const ubicacion = direccion ? inferirUbicacion(direccion) : null
  const complemento = direccion ? direccion.slice(0, 200) : null

  // ── Tipo ──
  const esEmpresa = pareceEmpresa(nombre)
  const comercial = celda('comercial') || null
  const nombres = esEmpresa
    ? { legal_name: nombre, trade_name: comercial, first_name: null, last_name: null }
    : { ...partirNombre(nombre), legal_name: null, trade_name: comercial }

  // ── ¿Alcanza para CCF? ── (lo mismo que exige customers_ccf_requires_fiscal_data)
  const faltaCcf: string[] = []
  if (!nit) faltaCcf.push('NIT')
  if (!nrc) faltaCcf.push('NRC')
  if (!codActividad) faltaCcf.push('código de actividad')
  if (!descActividad) faltaCcf.push('giro')
  if (!ubicacion) faltaCcf.push('departamento y municipio')
  if (!complemento) faltaCcf.push('dirección')
  if (onlyDigits(telefono).length < 8) faltaCcf.push('teléfono')
  if (!correo) faltaCcf.push('correo')
  const ccf = faltaCcf.length === 0
  if (nrc && !ccf) avisos.push(`Tiene NRC pero le falta ${faltaCcf.join(', ')} para CCF: queda como ticket`)
  if (direccion && !ubicacion) avisos.push('No se pudo deducir departamento y municipio de la dirección')

  return {
    fila, nombre, estado: errores.length ? 'error' : 'nuevo', errores, avisos,
    ficha: {
      customer_type: esEmpresa ? 'company' : 'individual',
      ...nombres,
      phone: telefono,
      email: correo,
      dui, nit, nrc,
      address: direccion,
      fiscal_document_type: ccf ? 'ccf' : 'fcf',
      cod_actividad: codActividad,
      desc_actividad: descActividad,
      fiscal_departamento: ubicacion?.departamento ?? null,
      fiscal_municipio: ubicacion?.municipio ?? null,
      fiscal_complemento: complemento,
    },
  }
}

/**
 * Interpreta la hoja entera: la primera fila con un «Nombre» reconocible es
 * el encabezado. Marca duplicados contra la base y dentro del mismo archivo
 * (mismo NIT, mismo DUI, o mismo nombre cuando no hay documentos).
 */
export function interpretarHoja(filas: Celda[][], existentes: ClienteExistente[]): ResultadoInterpretacion {
  const inicio = filas.findIndex(f => mapearEncabezados(f).indices.nombre !== undefined)
  if (inicio < 0) {
    throw new Error('No se encontró la columna «Nombre / Razón social». Revisá que la primera fila sean los encabezados.')
  }
  const { indices, ignoradas } = mapearEncabezados(filas[inicio])

  const nits = new Set(existentes.map(e => e.normalized_nit).filter(Boolean) as string[])
  const duis = new Set(existentes.map(e => e.normalized_dui).filter(Boolean) as string[])
  const nombres = new Set(existentes.map(e => normalizar(e.nombre)).filter(Boolean))

  const resultado: FilaInterpretada[] = []
  for (let i = inicio + 1; i < filas.length; i++) {
    const f = filas[i]
    if (!f || f.every(c => texto(c) === '')) continue
    const celda = (campo: Campo, largo?: number) => {
      const idx = indices[campo]
      return idx === undefined ? '' : texto(f[idx], largo)
    }
    const r = interpretarFila(i + 1, celda)

    if (r.ficha) {
      const nit = onlyDigits(r.ficha.nit)
      const dui = onlyDigits(r.ficha.dui)
      const nom = normalizar(r.nombre)
      const repetido =
        (nit && nits.has(nit)) ? `Ya existe un cliente con NIT ${r.ficha.nit}`
        : (dui && duis.has(dui)) ? `Ya existe un cliente con DUI ${r.ficha.dui}`
        : (!nit && !dui && nombres.has(nom)) ? 'Ya existe un cliente con ese nombre'
        : null
      if (repetido) {
        r.estado = 'duplicado'
        r.errores.push(repetido)
      } else {
        // Las filas siguientes del mismo archivo chocan contra ésta.
        if (nit) nits.add(nit)
        if (dui) duis.add(dui)
        nombres.add(nom)
      }
    }
    resultado.push(r)
  }
  return { filas: resultado, ignoradas }
}
