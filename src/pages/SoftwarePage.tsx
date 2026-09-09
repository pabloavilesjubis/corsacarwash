/**
 * CORSA Carwash — Software
 *
 * Instaladores que la operación necesita bajar a una PC. Hoy es el PLC Gateway,
 * el servicio que monitorea las máquinas de lavado por Modbus.
 *
 * Acceso restringido a Super Admin: son instaladores que se ejecutan con
 * permisos de administrador sobre equipos de la operación.
 */

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import {
  fetchReleases, downloadRelease, checkFileExists, formatBytes,
  type SoftwareRelease,
} from '../services/software.service'

function fecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-SV', { day: '2-digit', month: 'long', year: 'numeric' })
}

export function SoftwarePage() {
  const { hasPermission } = useAuth()
  const puedeDescargar = hasPermission('software.download')

  const [releases, setReleases] = useState<SoftwareRelease[]>([])
  const [loading, setLoading] = useState(true)
  const [descargando, setDescargando] = useState<string | null>(null)
  const [faltantes, setFaltantes] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await fetchReleases()
      setReleases(rows)

      // Un registro puede existir sin que el archivo se haya subido al bucket.
      // Conviene decirlo antes de que alguien haga clic y reciba un error.
      const missing = new Set<string>()
      await Promise.all(rows.map(async r => {
        if (!(await checkFileExists(r))) missing.add(r.id)
      }))
      setFaltantes(missing)
    } catch {
      toast.error('No se pudieron cargar los instaladores')
    }
    setLoading(false)
  }, [])

  useEffect(() => { if (puedeDescargar) load(); else setLoading(false) }, [puedeDescargar, load])

  const descargar = async (r: SoftwareRelease) => {
    setDescargando(r.id)
    try {
      await downloadRelease(r)
      toast.success(`Descargando ${r.file_name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo descargar')
    }
    setDescargando(null)
  }

  if (!puedeDescargar) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso a Software</div>
          <div className="empty-state-sub">
            Esta sección está reservada a Super Admin: contiene instaladores que
            se ejecutan con permisos de administrador sobre equipos de la operación.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 26 }}>Software</h1>
          <div className="page-header-sub">Instaladores para equipos de la operación</div>
        </div>
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
      ) : releases.length === 0 ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, maxWidth: 620 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Todavía no hay instaladores publicados</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            El paquete del <strong>PLC Gateway</strong> se sube una sola vez al
            bucket <code>software</code> de Supabase Storage y después queda
            disponible acá para cualquier PC. Las instrucciones están en
            <code> docs/PUBLICAR_SOFTWARE.md</code> del repositorio.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
          {releases.map(r => {
            const falta = faltantes.has(r.id)
            return (
              <div key={r.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 320px', minWidth: 260 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 17 }}>{r.name}</span>
                      <span className="badge badge-green">v{r.version}</span>
                      <span className="badge badge-neutral">{r.platform}</span>
                      {r.is_current && <span className="badge badge-orange">Versión actual</span>}
                    </div>
                    {r.description && (
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.55 }}>
                        {r.description}
                      </div>
                    )}
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 8 }}>
                      {formatBytes(r.file_size_bytes)} · publicado el {fecha(r.published_at)}
                    </div>
                  </div>

                  <button
                    onClick={() => descargar(r)}
                    disabled={descargando === r.id || falta}
                    style={{
                      fontSize: 13.5, fontWeight: 700, color: '#fff',
                      background: falta ? 'var(--text-secondary)' : 'var(--corsa-green)',
                      borderRadius: 5, padding: '10px 18px', border: 'none',
                      cursor: falta ? 'not-allowed' : 'pointer',
                      opacity: falta ? 0.5 : 1, whiteSpace: 'nowrap',
                    }}
                  >
                    {descargando === r.id ? 'Preparando…' : falta ? 'Archivo no subido' : 'Descargar'}
                  </button>
                </div>

                {falta && (
                  <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-danger-text)', background: 'var(--color-danger-bg, #FBE7E7)', padding: '9px 12px', borderRadius: 5 }}>
                    La versión está registrada pero el archivo no está en el bucket
                    <code> software</code>. Subilo en la ruta <code>{r.storage_path}</code>.
                  </div>
                )}

                {r.sha256 && !falta && (
                  <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 2 }}>SHA-256</div>
                    <code className="font-mono" style={{ wordBreak: 'break-all' }}>{r.sha256}</code>
                    <div style={{ marginTop: 4 }}>
                      Verificá en destino con:{' '}
                      <code className="font-mono">Get-FileHash {r.file_name}</code>
                    </div>
                  </div>
                )}

                {r.release_notes && (
                  <details style={{ marginTop: 12 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                      Instrucciones y novedades
                    </summary>
                    <pre style={{
                      whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6,
                      background: 'var(--page-bg)', border: '1px solid var(--border)',
                      borderRadius: 6, padding: 12, marginTop: 8, fontFamily: 'inherit',
                    }}>{r.release_notes}</pre>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
