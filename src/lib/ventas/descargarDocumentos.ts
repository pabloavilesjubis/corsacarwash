/**
 * CORSA — Documentos de ventas en ZIP: el JSON y el PDF de cada DTE de un rango.
 *
 * Entran todos los DTE del rango (CCF y FCF, también los invalidados), con el
 * número de control como nombre, uno detrás del otro:
 *
 *   DTE-01-M001P001-000000000000101.json
 *   DTE-01-M001P001-000000000000101.pdf
 *   DTE-01-M001P001-000000000000102.json
 *   …
 *
 * Los PDF los genera /api/documentos (la misma factura carta del correo) por
 * lotes de 20, varios a la vez. El ZIP se arma en el navegador mientras llegan:
 * los JSON comprimidos (bajan a la quinta parte) y los PDF guardados tal cual,
 * porque ya vienen comprimidos y volver a comprimirlos sólo gasta tiempo.
 */
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate'
import { supabase } from '../supabase'
import { fetchDtesDelRango } from './exportarContadores'

const POR_LOTE = 20
const LOTES_A_LA_VEZ = 3
const INTENTOS = 3

export interface Progreso { listos: number; total: number }
export interface ResultadoZip { documentos: number; incompletos: string[]; bytes: number }

interface Archivo { id: string; numero_control: string; json: string | null; pdf: string | null; error?: string }

async function pedirLote(ids: string[], token: string, signal: AbortSignal): Promise<Archivo[]> {
  let ultimo: unknown
  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      const res = await fetch('/api/documentos', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ accion: 'lote', ids }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.ok) return json.archivos as Archivo[]
      // Sin sesión o sin permiso no tiene sentido reintentar.
      if (res.status === 401 || res.status === 403 || res.status === 400) throw Object.assign(new Error(json.error ?? 'No autorizado'), { final: true })
      ultimo = new Error(json.error ?? `El servidor respondió ${res.status}`)
    } catch (e: any) {
      if (signal.aborted || e?.final) throw e
      ultimo = e
    }
    await new Promise(r => setTimeout(r, 1500 * intento))
  }
  throw ultimo instanceof Error ? ultimo : new Error('No se pudieron generar los documentos')
}

function base64ABytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Nombre seguro para el ZIP; el número de control ya lo es, pero por las dudas. */
const nombreArchivo = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_')

export async function descargarDocumentosZip(desde: string, hasta: string, opts: {
  signal: AbortSignal
  onProgreso: (p: Progreso) => void
}): Promise<ResultadoZip | null> {
  const dtes = await fetchDtesDelRango(desde, hasta)
  if (dtes.length === 0) return null
  // Consecutivos: por número de control (tipo, establecimiento, correlativo).
  dtes.sort((a, b) => a.numero_control.localeCompare(b.numero_control))

  const token = (await supabase.auth.getSession()).data.session?.access_token
  if (!token) throw new Error('La sesión venció. Volvé a ingresar.')

  const carpeta = `documentos-ventas-${desde}_${hasta}`
  const partes: Uint8Array[] = []
  let errorZip: Error | null = null
  const zip = new Zip((err, chunk) => {
    if (err) { errorZip = err; return }
    partes.push(chunk)
  })

  // Los lotes llegan en cualquier orden; al ZIP entran en el del correlativo.
  const lotes: string[][] = []
  for (let i = 0; i < dtes.length; i += POR_LOTE) lotes.push(dtes.slice(i, i + POR_LOTE).map(d => d.fiscal_document_id))
  const llegados = new Map<number, Archivo[]>()
  let siguiente = 0
  let listos = 0
  const incompletos: string[] = []
  const numeroDe = new Map(dtes.map(d => [d.fiscal_document_id, d.numero_control]))
  opts.onProgreso({ listos: 0, total: dtes.length })

  const volcar = () => {
    while (llegados.has(siguiente)) {
      const porId = new Map(llegados.get(siguiente)!.map(a => [a.id, a]))
      llegados.delete(siguiente)
      for (const id of lotes[siguiente]) {
        const a = porId.get(id)
        const nc = numeroDe.get(id) ?? id
        const base = `${carpeta}/${nombreArchivo(nc)}`
        if (a?.json) {
          const f = new ZipDeflate(`${base}.json`, { level: 6 })
          zip.add(f)
          f.push(strToU8(a.json), true)
        }
        if (a?.pdf) {
          const f = new ZipPassThrough(`${base}.pdf`)
          zip.add(f)
          f.push(base64ABytes(a.pdf), true)
        }
        if (!a?.json || !a?.pdf) incompletos.push(`${nc}: ${!a ? 'sin JSON ni PDF' : !a.json ? 'sin JSON' : 'sin PDF'}`)
      }
      siguiente++
    }
  }

  let proximo = 0
  await Promise.all(Array.from({ length: Math.min(LOTES_A_LA_VEZ, lotes.length) }, async () => {
    while (proximo < lotes.length) {
      if (opts.signal.aborted) throw new DOMException('Cancelado', 'AbortError')
      const k = proximo++
      // Un lote que falla aun después de reintentar no tira la descarga entera:
      // sus documentos quedan anotados en el LEEME para bajarlos aparte.
      const archivos = await pedirLote(lotes[k], token, opts.signal).catch(e => {
        if (opts.signal.aborted || e?.final) throw e
        return [] as Archivo[]
      })
      llegados.set(k, archivos)
      listos += lotes[k].length
      opts.onProgreso({ listos, total: dtes.length })
      volcar()
    }
  }))

  if (incompletos.length) {
    const nota = new ZipDeflate(`${carpeta}/LEEME-documentos-incompletos.txt`, { level: 6 })
    zip.add(nota)
    nota.push(strToU8(
      'A estos documentos les falta un archivo en esta descarga. Se pueden volver a descargar desde Ventas.\r\n'
      + 'Un documento sin JSON es uno que no tiene guardada la firma electrónica.\r\n\r\n'
      + incompletos.join('\r\n') + '\r\n'), true)
  }
  zip.end()
  if (errorZip) throw errorZip

  const blob = new Blob(partes as BlobPart[], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${carpeta}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)

  return { documentos: dtes.length, incompletos, bytes: blob.size }
}
