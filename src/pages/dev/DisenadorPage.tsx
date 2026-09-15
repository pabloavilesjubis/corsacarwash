/**
 * CORSA Carwash — Diseñador móvil (sólo desarrollo)
 *
 * Un banco de trabajo para el modelo de teléfono: la app real, corriendo
 * dentro de un marco del tamaño de un teléfono real, sin tener que abrirla en
 * uno ni depender de las herramientas del navegador.
 *
 * Por qué un iframe y no simplemente una caja angosta: dentro del iframe el
 * viewport MIDE 390 px de verdad, así que matchMedia, dvh, el teclado virtual
 * y el scroll se comportan como en el teléfono. Una caja angosta con el mismo
 * ancho seguiría reportando el ancho del monitor y el corte móvil no se
 * activaría.
 *
 * No existe en producción: la ruta está detrás de import.meta.env.DEV y, de
 * todos modos, el CSP de Vercel (`frame-ancestors 'none'`) impide enmarcar la
 * app fuera de localhost. Es una herramienta de taller, no una pantalla del
 * sistema.
 */
import { useMemo, useState } from 'react'
import { SCREENS } from '../../lib/screens'
import { estaAdaptada, tieneVersionMovil } from '../../mobile/registro'

interface Dispositivo {
  nombre: string
  ancho: number
  alto: number
  /** Los de escritorio existen para comprobar lo que NO tiene que cambiar. */
  escritorio?: boolean
}

const DISPOSITIVOS: Dispositivo[] = [
  { nombre: 'iPhone SE',        ancho: 375, alto: 667 },
  { nombre: 'iPhone 15',        ancho: 393, alto: 852 },
  { nombre: 'iPhone 15 Pro Max', ancho: 430, alto: 932 },
  { nombre: 'Pixel 8',          ancho: 412, alto: 915 },
  { nombre: 'Galaxy S23',       ancho: 360, alto: 780 },
  { nombre: 'iPad mini',        ancho: 744, alto: 1133 },
  { nombre: 'Escritorio 1280',  ancho: 1280, alto: 800, escritorio: true },
  { nombre: 'Escritorio 1600',  ancho: 1600, alto: 900, escritorio: true },
]

const RUTAS = [
  ...SCREENS.filter(s => !s.hidden).map(s => ({
    path: s.path, label: s.label, key: s.key,
    adaptada: estaAdaptada(s.key),
    // Distinguirlo importa al decidir qué sigue: una pantalla responsiva puede
    // estar bien y aun así merecer una versión propia si la tarea del teléfono
    // resulta ser otra.
    propia: tieneVersionMovil(s.key),
  })),
  { path: '/login', label: 'Ingreso', key: 'login', adaptada: false, propia: false },
]

export function DisenadorPage() {
  const [dispositivo, setDispositivo] = useState(DISPOSITIVOS[1])
  const [ruta, setRuta] = useState('/dashboard')
  const [horizontal, setHorizontal] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [recarga, setRecarga] = useState(0)
  const [comparar, setComparar] = useState(false)

  const ancho = horizontal ? dispositivo.alto : dispositivo.ancho
  const alto = horizontal ? dispositivo.ancho : dispositivo.alto

  // `vista` fuerza el modelo dentro del marco. En un teléfono de verdad basta
  // el ancho; acá hace falta para poder mirar la versión de computadora en un
  // marco angosto, y al revés.
  const src = useMemo(() => {
    const vista = dispositivo.escritorio ? 'escritorio' : 'movil'
    return `${ruta}?vista=${vista}&marco=${recarga}`
  }, [ruta, dispositivo.escritorio, recarga])

  const pendientes = RUTAS.filter(r => !r.adaptada && r.key !== 'login')

  return (
    <div style={{
      minHeight: '100vh', background: '#101a18', color: '#E8EFEC',
      fontFamily: "'IBM Plex Sans', sans-serif", padding: '18px 22px 40px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 19 }}>
          Diseñador móvil
        </div>
        <div style={{ fontSize: 12.5, color: '#7E948E' }}>
          la app real dentro de un marco de teléfono · sólo en desarrollo
        </div>
      </div>

      {/* ── Controles ── */}
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
        margin: '16px 0', padding: '12px 14px',
        background: '#17241f', border: '1px solid #26382f', borderRadius: 8,
      }}>
        <Selector
          label="Pantalla"
          value={ruta}
          onChange={setRuta}
          opciones={RUTAS.map(r => ({
            value: r.path,
            label: `${r.label}${r.propia ? '  ·  móvil' : r.adaptada ? '  ·  responsiva' : ''}`,
          }))}
        />

        <Selector
          label="Dispositivo"
          value={dispositivo.nombre}
          onChange={n => {
            const d = DISPOSITIVOS.find(x => x.nombre === n)
            if (d) { setDispositivo(d); setHorizontal(false) }
          }}
          opciones={DISPOSITIVOS.map(d => ({
            value: d.nombre, label: `${d.nombre}  ${d.ancho}×${d.alto}`,
          }))}
        />

        <Boton activo={horizontal} onClick={() => setHorizontal(h => !h)}>
          {horizontal ? 'Horizontal' : 'Vertical'}
        </Boton>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11.5, color: '#7E948E' }}>Zoom</span>
          {[0.75, 1].map(z => (
            <Boton key={z} activo={zoom === z} onClick={() => setZoom(z)}>
              {Math.round(z * 100)}%
            </Boton>
          ))}
        </div>

        <Boton activo={comparar} onClick={() => setComparar(c => !c)}>
          Comparar con escritorio
        </Boton>

        <Boton onClick={() => setRecarga(n => n + 1)}>Recargar</Boton>

        <a href={src} target="_blank" rel="noreferrer"
           style={{ fontSize: 12, color: '#8FE3BE', textDecoration: 'none', marginLeft: 'auto' }}>
          Abrir en pestaña ↗
        </a>
      </div>

      {/* ── Marcos ── */}
      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Marco titulo={`${dispositivo.nombre} · ${ancho}×${alto}`} ancho={ancho} alto={alto} zoom={zoom}>
          <iframe
            key={src}
            src={src}
            title="Vista móvil"
            style={{ width: ancho, height: alto, border: 'none', background: '#fff' }}
          />
        </Marco>

        {/* El marco de al lado es el control de que el escritorio no se movió:
            mismo momento, misma pantalla, los dos modelos a la vez. */}
        {comparar && (
          <Marco titulo="Escritorio 1280×800" ancho={1280} alto={800} zoom={0.55}>
            <iframe
              key={`esc-${src}`}
              src={`${ruta}?vista=escritorio&marco=${recarga}`}
              title="Vista de escritorio"
              style={{ width: 1280, height: 800, border: 'none', background: '#fff' }}
            />
          </Marco>
        )}

        {/* ── Cola de trabajo ── */}
        <div style={{
          flex: '1 1 240px', minWidth: 240, maxWidth: 360,
          background: '#17241f', border: '1px solid #26382f', borderRadius: 8, padding: '14px 16px',
        }}>
          <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
            Modelo móvil
          </div>
          <div style={{ fontSize: 12, color: '#7E948E', marginBottom: 12 }}>
            {RUTAS.filter(r => r.adaptada).length} de {RUTAS.length - 1} pantallas adaptadas
          </div>

          {RUTAS.filter(r => r.adaptada).map(r => (
            <FilaPantalla key={r.key} label={r.label}
                          estado={r.propia ? 'propia' : 'responsiva'}
                          onClick={() => setRuta(r.path)}/>
          ))}
          {pendientes.map(r => (
            <FilaPantalla key={r.key} label={r.label} estado="pendiente" onClick={() => setRuta(r.path)}/>
          ))}

          <div style={{ marginTop: 14, fontSize: 11.5, color: '#7E948E', lineHeight: 1.5 }}>
            Una pantalla sin adaptar se muestra en el teléfono tal como está en
            computadora, con su aviso. Para adaptarla: crear el componente en
            <code style={{ color: '#8FE3BE' }}> src/mobile/</code>, anotarlo en
            <code style={{ color: '#8FE3BE' }}> registro.tsx</code> y envolver su
            ruta con <code style={{ color: '#8FE3BE' }}>adaptativa()</code>.
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Piezas del taller ───────────────────────────────────────

function Marco({ titulo, ancho, alto, zoom, children }: {
  titulo: string; ancho: number; alto: number; zoom: number; children: React.ReactNode
}) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: '#7E948E', marginBottom: 8 }}>{titulo}</div>
      {/* El contenedor reserva el tamaño ya escalado: sin esto, al reducir el
          zoom quedaría un hueco del tamaño original al lado del marco. */}
      <div style={{ width: ancho * zoom, height: alto * zoom }}>
        <div style={{
          width: ancho, height: alto,
          transform: `scale(${zoom})`, transformOrigin: 'top left',
          borderRadius: 14, overflow: 'hidden',
          border: '1px solid #2F443B',
          boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
          background: '#fff',
        }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function Selector({ label, value, onChange, opciones }: {
  label: string; value: string; onChange: (v: string) => void
  opciones: { value: string; label: string }[]
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11.5, color: '#7E948E' }}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          padding: '7px 10px', fontSize: 13, borderRadius: 6,
          background: '#101a18', color: '#E8EFEC', border: '1px solid #2F443B',
        }}
      >
        {opciones.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

function Boton({ children, onClick, activo }: {
  children: React.ReactNode; onClick: () => void; activo?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 12px', fontSize: 12.5, borderRadius: 6, cursor: 'pointer',
        background: activo ? '#1E9E6B' : '#101a18',
        color: activo ? '#06231A' : '#E8EFEC',
        border: `1px solid ${activo ? '#1E9E6B' : '#2F443B'}`,
        fontWeight: activo ? 700 : 500,
        alignSelf: 'flex-end',
      }}
    >
      {children}
    </button>
  )
}

function FilaPantalla({ label, estado, onClick }: {
  label: string; estado: 'propia' | 'responsiva' | 'pendiente'; onClick: () => void
}) {
  const adaptada = estado !== 'pendiente'
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 0', background: 'none', border: 'none', cursor: 'pointer',
        color: '#E8EFEC', fontSize: 12.5, textAlign: 'left',
        fontFamily: "'IBM Plex Sans', sans-serif",
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: adaptada ? '#1E9E6B' : '#3C5349',
      }}/>
      <span style={{ flex: 1, color: adaptada ? '#E8EFEC' : '#93A8A2' }}>{label}</span>
      <span style={{ fontSize: 10.5, color: adaptada ? '#8FE3BE' : '#7E948E' }}>
        {estado === 'propia' ? 'móvil' : estado === 'responsiva' ? 'responsiva' : 'pendiente'}
      </span>
    </button>
  )
}
