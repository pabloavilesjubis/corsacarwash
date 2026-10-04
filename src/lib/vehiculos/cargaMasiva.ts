/**
 * CORSA — carga masiva de vehículos desde un Excel.
 *
 * La única columna obligatoria es la placa: sin placa no hay a qué carro
 * atarle un lavado. Todo lo demás —marca, modelo, color, año, tamaño— se
 * carga si viene y se deja vacío si no: el carro entra igual. El tamaño, si
 * falta o no se entiende, queda M (es la tarifa intermedia y se corrige en la
 * ficha).
 *
 * Destino: un cliente (todos los carros a él) o un grupo empresarial, donde
 * cada fila puede decir a qué empresa del grupo va (columna «Empresa», por
 * NIT, DUI o nombre); la que no lo dice, o no se encuentra, queda del grupo
 * sin cliente (0067) y se le asigna después desde Grupos empresariales.
 *
 * Una placa que ya está registrada no se duplica ni se le cambia el dueño:
 * se marca y se salta. Lo mismo una placa repetida dentro del archivo.
 */
import { normalizar, type Celda } from '../clientes/cargaMasiva'
import type { TamanoVehiculo } from '../../services/customers.service'

type Campo = 'placa' | 'marca' | 'modelo' | 'color' | 'anio' | 'tamano' | 'empresa'

/** Encabezados reconocidos (normalizados) por campo. */
const ALIAS: Record<Campo, string[]> = {
  placa:   ['placa', 'placas', 'no placa', 'numero de placa', 'plate'],
  marca:   ['marca', 'brand'],
  modelo:  ['modelo', 'model', 'linea'],
  color:   ['color'],
  anio:    ['ano', 'anio', 'year', 'ano del vehiculo', 'modelo ano'],
  tamano:  ['tamano', 'tamano s m l', 'talla', 'tipo', 'tipo de vehiculo', 'categoria', 'size'],
  empresa: ['empresa', 'cliente', 'nit', 'dui', 'nit o nombre', 'empresa nit o nombre', 'razon social', 'propietario', 'dueno'],
}

export interface DestinoMiembro { id: string; nombre: string; nit?: string | null; dui?: string | null }

export interface FilaVehiculo {
  /** Número de fila en el Excel (la 1 es el encabezado). */
  fila: number
  placa: string
  marca: string | null
  modelo: string | null
  color: string | null
  anio: number | null
  tamano: TamanoVehiculo
  /** Lo que decía la columna Empresa, tal cual. */
  empresaTexto: string | null
  /** A qué cliente va (se resuelve con el destino). Null en un grupo = sin cliente. */
  clienteId: string | null
  clienteNombre: string | null
  /** Con destino grupo: el grupo dueño del carro. */
  grupoId: string | null
  estado: 'nuevo' | 'existe' | 'repetida' | 'sin_placa'
  avisos: string[]
}

export interface PlacaExistente { normalized_plate: string; cliente: string }

const texto = (c: Celda): string => {
  if (c == null) return ''
  if (c instanceof Date) return ''
  return String(c).trim()
}

export const normalizarPlaca = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '')
const soloDigitos = (s: string) => s.replace(/\D/g, '')

/** S, M o L desde lo que haya escrito: la letra, la palabra o la carrocería. */
export function tamanoDe(valor: string): TamanoVehiculo | null {
  const v = normalizar(valor)
  if (!v) return null
  if (['s', 'p', 'pequeno', 'pequeño', 'chico', 'small', 'hatchback', 'compacto', 'moto', 'motocicleta'].includes(v)) return 'S'
  if (['m', 'mediano', 'medium', 'sedan', 'sedán', 'crossover'].includes(v)) return 'M'
  if (['l', 'g', 'grande', 'large', 'xl', 'suv', 'pickup', 'pick up', 'camioneta', 'van', 'microbus', 'panel', 'camion'].includes(v)) return 'L'
  if (v.startsWith('s ')) return 'S'
  if (v.startsWith('m ')) return 'M'
  if (v.startsWith('l ')) return 'L'
  return null
}

function mapear(encabezado: Celda[]): { indices: Partial<Record<Campo, number>>; ignoradas: string[] } {
  const indices: Partial<Record<Campo, number>> = {}
  const ignoradas: string[] = []
  encabezado.forEach((c, i) => {
    const h = normalizar(texto(c))
    if (!h) return
    const campo = (Object.keys(ALIAS) as Campo[]).find(k => ALIAS[k].includes(h))
    if (campo && indices[campo] == null) indices[campo] = i
    else ignoradas.push(texto(c))
  })
  return { indices, ignoradas }
}

/**
 * Lee la hoja. El destino se resuelve aparte (resolverDestino), porque se
 * elige después de ver el archivo.
 */
export function interpretarVehiculos(hoja: Celda[][], existentes: PlacaExistente[]): {
  filas: FilaVehiculo[]
  ignoradas: string[]
  conEmpresa: boolean
} {
  const inicio = hoja.findIndex(r => r.some(c => texto(c)))
  if (inicio < 0) throw new Error('El archivo está vacío.')
  const { indices, ignoradas } = mapear(hoja[inicio])
  if (indices.placa == null) {
    throw new Error('No se encontró la columna «Placa». Revisá que la primera fila sean los encabezados.')
  }

  const yaEnBase = new Map(existentes.map(e => [e.normalized_plate, e.cliente]))
  const vistas = new Set<string>()
  const val = (r: Celda[], c: Campo) => (indices[c] == null ? '' : texto(r[indices[c]!]))

  const filas: FilaVehiculo[] = []
  hoja.slice(inicio + 1).forEach((r, i) => {
    if (!r.some(c => texto(c))) return
    const fila = inicio + i + 2
    const placa = val(r, 'placa').toUpperCase().replace(/\s+/g, ' ')
    const norm = normalizarPlaca(placa)
    const avisos: string[] = []

    const tamTxt = val(r, 'tamano')
    let tamano = tamanoDe(tamTxt)
    if (!tamano) {
      avisos.push(tamTxt ? `Tamaño «${tamTxt}» no reconocido: queda M` : 'Sin tamaño: queda M')
      tamano = 'M'
    }
    const anioTxt = val(r, 'anio')
    let anio: number | null = null
    if (anioTxt) {
      const n = Number(soloDigitos(anioTxt))
      if (n >= 1900 && n <= 2100) anio = n
      else avisos.push(`Año «${anioTxt}» no válido: se deja vacío`)
    }

    let estado: FilaVehiculo['estado'] = 'nuevo'
    if (!norm) estado = 'sin_placa'
    else if (yaEnBase.has(norm)) { estado = 'existe'; avisos.unshift(`Ya registrada a ${yaEnBase.get(norm)}`) }
    else if (vistas.has(norm)) { estado = 'repetida'; avisos.unshift('Placa repetida en el archivo') }
    if (norm) vistas.add(norm)

    filas.push({
      fila, placa, tamano, anio, avisos, estado,
      marca: val(r, 'marca') || null,
      modelo: val(r, 'modelo') || null,
      color: val(r, 'color') || null,
      empresaTexto: val(r, 'empresa') || null,
      clienteId: null, clienteNombre: null, grupoId: null,
    })
  })
  return { filas, ignoradas, conEmpresa: indices.empresa != null }
}

/**
 * A qué cliente va cada fila. Con un cliente, todas a él. Con un grupo, la
 * columna Empresa busca al miembro por NIT, DUI o nombre; si no hay o no se
 * encuentra, el carro queda del grupo sin cliente.
 */
export function resolverDestino(
  filas: FilaVehiculo[],
  destino: { tipo: 'cliente'; cliente: DestinoMiembro | null } | { tipo: 'grupo'; grupoId: string | null; grupoNombre: string; miembros: DestinoMiembro[] },
): FilaVehiculo[] {
  if (destino.tipo === 'cliente') {
    return filas.map(f => ({ ...f, clienteId: destino.cliente?.id ?? null, clienteNombre: destino.cliente?.nombre ?? null, grupoId: null }))
  }
  const { miembros, grupoId, grupoNombre } = destino
  const buscar = (t: string): DestinoMiembro | null => {
    const d = soloDigitos(t)
    if (d.length >= 9) {
      const m = miembros.find(x => (x.nit && soloDigitos(x.nit) === d) || (x.dui && soloDigitos(x.dui) === d))
      if (m) return m
    }
    const n = normalizar(t)
    if (!n) return null
    return miembros.find(x => normalizar(x.nombre) === n)
      ?? miembros.find(x => normalizar(x.nombre).includes(n) || n.includes(normalizar(x.nombre)))
      ?? null
  }
  return filas.map(f => {
    const avisos = f.avisos.filter(a => !a.startsWith('Empresa '))
    const m = f.empresaTexto ? buscar(f.empresaTexto) : null
    if (f.empresaTexto && !m) avisos.push(`Empresa «${f.empresaTexto}» no está en el grupo: queda sin cliente`)
    return {
      ...f, avisos, grupoId,
      clienteId: m?.id ?? null,
      clienteNombre: m ? m.nombre : grupoId ? `${grupoNombre} · sin cliente` : null,
    }
  })
}
