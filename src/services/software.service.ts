/**
 * CORSA Carwash — Instaladores descargables
 *
 * El archivo vive en el bucket privado `software` de Supabase Storage; esta
 * tabla sólo guarda el metadato. El bucket es privado a propósito: uno público
 * serviría el instalador a cualquiera que adivinara la URL, sin sesión.
 *
 * La descarga se hace con una URL firmada de vida corta, generada en el momento
 * para quien tenga el permiso.
 */

import { supabase } from '../lib/supabase'

export interface SoftwareRelease {
  id: string
  product: string
  name: string
  version: string
  platform: string
  description: string | null
  release_notes: string | null
  storage_path: string
  file_name: string
  file_size_bytes: number | null
  sha256: string | null
  is_current: boolean
  published_at: string
  created_at: string
}

export async function fetchReleases(): Promise<SoftwareRelease[]> {
  const { data, error } = await (supabase as any)
    .from('software_releases')
    .select('*')
    .order('published_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as SoftwareRelease[]
}

/** Minutos que vive el enlace de descarga. */
const SIGNED_URL_TTL_SECONDS = 300

/**
 * Genera el enlace firmado y dispara la descarga.
 *
 * No se usa un <a href> directo al bucket porque es privado: sin firma la
 * petición vuelve 400. Y la firma se pide recién al hacer clic, no al cargar
 * la lista, para que no queden enlaces válidos flotando en el DOM.
 */
export async function downloadRelease(release: SoftwareRelease): Promise<void> {
  const { data, error } = await supabase.storage
    .from('software')
    .createSignedUrl(release.storage_path, SIGNED_URL_TTL_SECONDS, {
      download: release.file_name,
    })

  if (error) throw new Error(error.message)
  if (!data?.signedUrl) throw new Error('No se pudo generar el enlace de descarga')

  window.location.href = data.signedUrl
}

/** Comprueba que el archivo realmente esté en el bucket. */
export async function checkFileExists(release: SoftwareRelease): Promise<boolean> {
  const slash = release.storage_path.lastIndexOf('/')
  const folder = slash === -1 ? '' : release.storage_path.slice(0, slash)
  const name = slash === -1 ? release.storage_path : release.storage_path.slice(slash + 1)

  const { data, error } = await supabase.storage.from('software').list(folder, { search: name })
  if (error) return false
  return (data ?? []).some(f => f.name === name)
}

export function formatBytes(bytes: number | null): string {
  if (!bytes) return '—'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`
}
