/**
 * CORSA Carwash — Configuración → Estación fiscal
 *
 * «Probar estación fiscal» pregunta al CORSA Gateway de ESTA PC si está
 * instalado, si el firmador de Hacienda responde y si el certificado está.
 * Si no hay gateway, ofrece descargar el instalador oficial.
 *
 * Esta pantalla no firma, no transmite y no ve secretos: sólo lee /station.
 */

import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import {
  probarEstacion, gatewayVigente, descargarGateway, compararVersion,
  type ResultadoEstacion,
} from '../services/estacion-fiscal.service'
import { formatBytes, type SoftwareRelease } from '../services/software.service'

type Tono = 'ok' | 'mal' | 'neutro'

function Fila({ etiqueta, valor, tono, detalle }: { etiqueta: string; valor: string; tono: Tono; detalle?: string | null }) {
  const color = tono === 'ok' ? 'var(--corsa-green)' : tono === 'mal' ? 'var(--color-danger-text)' : 'var(--text-secondary)'
  const marca = tono === 'ok' ? '✓' : tono === 'mal' ? '✗' : '–'
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>{etiqueta}</span>
      <span style={{ textAlign: 'right' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color }}>{marca} {valor}</span>
        {detalle && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{detalle}</div>}
      </span>
    </div>
  )
}

const CERTIFICADO: Record<string, string> = {
  detected: 'Detectado',
  not_found: 'No detectado',
  not_configured: 'No detectado (ruta sin configurar)',
  unreadable: 'No se pudo leer',
  nit_mismatch: 'De otro NIT',
}

const boton = (primario: boolean): React.CSSProperties => ({
  fontSize: 13.5, fontWeight: 700, borderRadius: 10, padding: '10px 18px', cursor: 'pointer',
  border: primario ? 'none' : '1px solid var(--border)',
  color: primario ? '#fff' : 'var(--text-primary)',
  background: primario ? 'var(--corsa-green)' : 'var(--surface)',
})

export function EstacionFiscalPage() {
  const { hasPermission } = useAuth()
  const puedeDescargar = hasPermission('software.download')

  const [probando, setProbando] = useState(false)
  const [resultado, setResultado] = useState<ResultadoEstacion | null>(null)
  const [release, setRelease] = useState<SoftwareRelease | null | undefined>(undefined)
  const [descargando, setDescargando] = useState(false)

  const probar = async () => {
    setProbando(true)
    const r = await probarEstacion()
    setResultado(r)
    if (puedeDescargar && release === undefined) {
      try { setRelease(await gatewayVigente()) } catch { setRelease(null) }
    }
    setProbando(false)
  }

  const descargar = async () => {
    if (!release) return
    setDescargando(true)
    try {
      await descargarGateway(release)
      toast.success(`Descargando ${release.file_name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo descargar')
    }
    setDescargando(false)
  }

  const estado = resultado?.detectado ? resultado.estado : null
  const hayVersionNueva = !!(estado && release && compararVersion(release.version, estado.version) > 0)

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>
            Estación fiscal
          </h1>
          <div className="page-header-sub">
            Abrí esta pantalla en la PC donde está el firmador de Hacienda.
          </div>
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 20, maxWidth: 620 }}>
        <button onClick={probar} disabled={probando} style={boton(true)}>
          {probando ? 'Probando…' : resultado ? 'Probar nuevamente' : 'Probar estación fiscal'}
        </button>

        {resultado && (
          <div style={{ marginTop: 16 }}>
            <Fila etiqueta="Gateway" valor={estado ? 'Disponible' : 'No disponible'} tono={estado ? 'ok' : 'mal'} />
            {estado && (
              <>
                <Fila etiqueta="Versión" valor={`v${estado.version}`} tono="neutro"
                      detalle={hayVersionNueva ? `Hay una versión nueva: v${release!.version}` : null} />
                <Fila etiqueta="Firmador MH" valor={estado.firmador === 'available' ? 'Disponible' : 'No disponible'}
                      tono={estado.firmador === 'available' ? 'ok' : 'mal'} />
                <Fila etiqueta="Certificado" valor={CERTIFICADO[estado.certificate.status] ?? 'No detectado'}
                      tono={estado.certificate.status === 'detected' ? 'ok' : 'mal'}
                      detalle={estado.certificate.nit ? `NIT ${estado.certificate.nit}` : null} />
                <Fila etiqueta="Huella pública" valor={estado.certificate.fingerprint ?? '—'} tono="neutro" />
                <Fila etiqueta="Firma fiscal" valor={estado.fiscalSigning === 'available' ? 'Lista' : 'No configurada'}
                      tono={estado.fiscalSigning === 'available' ? 'ok' : 'mal'}
                      detalle={estado.fiscalSigning === 'available' ? null : estado.fiscalSigningMissing ? `Falta: ${estado.fiscalSigningMissing}` : null} />
                {estado.ready && (
                  <div style={{ marginTop: 14, fontSize: 14, fontWeight: 700, color: 'var(--corsa-green)' }}>Estación fiscal lista</div>
                )}
              </>
            )}

            {!estado && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Gateway CORSA no detectado</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6 }}>
                  {resultado.detectado === false && resultado.motivo === 'respuesta_invalida'
                    ? 'Algo respondió en el puerto 5055, pero no es el CORSA Gateway.'
                    : 'Si Chrome preguntó por acceso a dispositivos de la red local, elegí «Permitir» y probá de nuevo.'}
                </div>

                {!puedeDescargar ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12 }}>
                    Para descargar el instalador hace falta el permiso «Descargar instaladores».
                  </div>
                ) : release === null ? (
                  <div style={{ fontSize: 12.5, color: 'var(--color-danger-text)', marginTop: 12 }}>
                    Todavía no hay un instalador del Gateway publicado.
                  </div>
                ) : release ? (
                  <div style={{ marginTop: 14 }}>
                    <button onClick={descargar} disabled={descargando} style={boton(true)}>
                      {descargando ? 'Preparando…' : 'Descargar Gateway para Windows'}
                    </button>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.6 }}>
                      v{release.version} · {formatBytes(release.file_size_bytes)}
                      {release.sha256 && <> · SHA-256 <code className="font-mono" style={{ wordBreak: 'break-all' }}>{release.sha256}</code></>}
                    </div>
                    <ol style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.7, marginTop: 10, paddingLeft: 18 }}>
                      <li>Abrí el .zip descargado y elegí «Extraer todo».</li>
                      <li>En la carpeta extraída, doble clic en <strong>Instalar Gateway.bat</strong> y aceptá el aviso de administrador.</li>
                      <li>Cuando termine, volvé acá y presioná <strong>Probar nuevamente</strong>.</li>
                    </ol>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
