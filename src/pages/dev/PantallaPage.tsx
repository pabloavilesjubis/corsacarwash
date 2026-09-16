import { useEffect, useState } from 'react'

/**
 * Qué mide realmente cada teléfono.
 *
 * «Se ve más grande en el iPhone» no se puede depurar mirando. Dos teléfonos
 * con pantallas del mismo tamaño físico pueden reportar anchos CSS distintos,
 * y entonces un diseño en píxeles fijos ocupa una fracción distinta de la
 * pantalla en cada uno. Esta pantalla convierte esa impresión en números que
 * se pueden comparar lado a lado.
 *
 * Vive en /dev/pantalla y no pide permisos: se abre en el teléfono, se saca
 * una captura y se comparan las dos.
 */

interface Medida {
  clave: string
  valor: string
  /** Qué significa, cuando el número solo no alcanza. */
  nota?: string
  alarma?: boolean
}

/** El ancho CSS del iPhone Air, que es el aparato de referencia. */
const REFERENCIA = 420

export function PantallaPage() {
  const [medidas, setMedidas] = useState<Medida[]>([])

  useEffect(() => {
    const medir = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      const vv = window.visualViewport

      // El dato decisivo: si iOS está inflando el texto, el tamaño calculado
      // del body NO va a ser el que pide el CSS.
      const cuerpo = getComputedStyle(document.body)
      const fuente = parseFloat(cuerpo.fontSize)
      const inflado = Math.abs(fuente - 14) > 0.5

      const raiz = getComputedStyle(document.documentElement)
      const seguro = (lado: string) =>
        raiz.getPropertyValue(`--sa-${lado}`).trim() || '0px'

      const instalada = window.matchMedia('(display-mode: standalone)').matches
        || (navigator as unknown as { standalone?: boolean }).standalone === true

      setMedidas([
        {
          clave: 'Ancho CSS',
          valor: `${w} px`,
          nota: `${(100 * w / REFERENCIA).toFixed(1)}% del iPhone Air (${REFERENCIA} px)`,
        },
        { clave: 'Alto CSS', valor: `${h} px` },
        {
          clave: 'Alto visible (dvh)',
          valor: vv ? `${Math.round(vv.height)} px` : 'no disponible',
          nota: vv && Math.abs(vv.height - h) > 4
            ? `${Math.round(h - vv.height)} px los tapa la interfaz del navegador`
            : undefined,
        },
        {
          clave: 'Tamaño de fuente del cuerpo',
          valor: `${fuente.toFixed(1)} px`,
          nota: inflado
            ? 'El CSS pide 14. El navegador lo está cambiando.'
            : 'Coincide con el CSS.',
          alarma: inflado,
        },
        {
          clave: 'Densidad',
          valor: `${window.devicePixelRatio}×`,
          nota: `${Math.round(w * window.devicePixelRatio)} × ${Math.round(h * window.devicePixelRatio)} px físicos`,
        },
        {
          clave: 'Zoom del navegador',
          valor: vv ? `${vv.scale.toFixed(2)}×` : 'no disponible',
          nota: vv && Math.abs(vv.scale - 1) > 0.01 ? 'Hay zoom aplicado' : undefined,
          alarma: Boolean(vv && Math.abs(vv.scale - 1) > 0.01),
        },
        { clave: 'Pantalla del sistema', valor: `${screen.width} × ${screen.height} px` },
        {
          clave: 'Modo',
          valor: instalada ? 'app instalada' : 'pestaña del navegador',
        },
        {
          clave: 'Zonas seguras',
          valor: `${seguro('top')} arriba · ${seguro('bottom')} abajo`,
        },
        { clave: 'Orientación', valor: w > h ? 'horizontal' : 'vertical' },
        { clave: 'Vista de la app', valor: w < 820 ? 'móvil' : 'escritorio' },
      ])
    }

    medir()
    window.addEventListener('resize', medir)
    window.visualViewport?.addEventListener('resize', medir)
    return () => {
      window.removeEventListener('resize', medir)
      window.visualViewport?.removeEventListener('resize', medir)
    }
  }, [])

  return (
    <div style={{
      minHeight: '100dvh', background: '#0F1213', color: '#E8EFEC',
      padding: '24px 18px', fontFamily: 'system-ui, sans-serif',
    }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>
        Medidas de esta pantalla
      </h1>
      <p style={{ fontSize: 13, opacity: 0.6, marginBottom: 20 }}>
        Abrir en cada teléfono y comparar. Lo que difiera explica por qué se
        ven distintos.
      </p>

      <div style={{ display: 'grid', gap: 10 }}>
        {medidas.map(m => (
          <div key={m.clave} style={{
            background: m.alarma ? 'rgba(179,38,30,0.16)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${m.alarma ? 'rgba(255,120,110,0.45)' : 'rgba(255,255,255,0.10)'}`,
            borderRadius: 8, padding: '12px 14px',
          }}>
            <div style={{ fontSize: 12, opacity: 0.65 }}>{m.clave}</div>
            <div style={{
              fontSize: 22, fontWeight: 700, marginTop: 2,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {m.valor}
            </div>
            {m.nota && (
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{m.nota}</div>
            )}
          </div>
        ))}
      </div>

      {/* Una regla física: si el diseño escala bien, esta barra mide lo mismo
          en proporción a la pantalla en los dos teléfonos. */}
      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 6 }}>
          Regla de 200 px de CSS
        </div>
        <div style={{ height: 14, width: 200, background: '#DFF56B', borderRadius: 3 }}/>
        <div style={{ fontSize: 12, opacity: 0.5, marginTop: 6 }}>
          Si ocupa distinta fracción de la pantalla en cada teléfono, el ancho
          CSS es distinto y por eso el diseño se ve de otro tamaño.
        </div>
      </div>

      <div style={{
        marginTop: 24, fontSize: 11, opacity: 0.4, wordBreak: 'break-all',
        lineHeight: 1.5,
      }}>
        {navigator.userAgent}
      </div>
    </div>
  )
}
