/**
 * CORSA Carwash — el centro de notificaciones (🔔)
 *
 * POR QUÉ EXISTE ADEMÁS DEL PUSH
 * Un push se descarta de un manotazo y no vuelve. Si la única copia de «la
 * Máquina 1 falló a las 6:12» fue esa notificación que alguien barrió de la
 * pantalla de bloqueo, el dato se perdió. Acá está el mismo historial, en la
 * app, para el que llegó después o para el que no tiene el push activado.
 *
 * NO HAY UNA TABLA APARTE. Lee de notification_events, que es donde ya está
 * todo. Duplicar el texto en una tabla de «avisos de la campana» daría dos
 * versiones del mismo hecho, y el día que una se escribiera y la otra no,
 * habría que elegir a cuál creerle.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchNotificaciones, marcarLeidas, iconoDe, cuandoFue,
  type Notificacion,
} from '../services/notifications.service'
import { useAuth } from '../hooks/useAuth'

/** Cada cuánto se refresca con el panel cerrado. */
const INTERVALO_MS = 60_000

function Campana({ activa }: { activa: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      {activa && <circle cx="18" cy="6" r="3.2" fill="currentColor" stroke="none"/>}
    </svg>
  )
}

function Fila({ n, alTocar }: { n: Notificacion; alTocar: (n: Notificacion) => void }) {
  // Del cuerpo de tres líneas del push, en la lista se muestran las dos
  // primeras: la tercera es casi siempre el acumulado del día, que en un
  // historial no aporta.
  const lineas = n.body.split('\n')

  return (
    <button
      onClick={() => alTocar(n)}
      className="corsa-notif__fila"
      style={{ opacity: n.leida ? 0.62 : 1 }}
    >
      <span className="corsa-notif__icono" aria-hidden="true">{iconoDe(n.event_type)}</span>
      <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
        <span className="corsa-notif__titulo">
          {/* El título del push trae «CORSA — » adelante, que en una lista
              dentro de CORSA sobra en todas las filas. */}
          {n.title.replace(/^[^\s]*\s*CORSA\s*—\s*/, '')}
          {!n.leida && <span className="corsa-notif__punto" aria-label="sin leer"/>}
        </span>
        <span className="corsa-notif__cuerpo">{lineas.slice(0, 2).join(' · ')}</span>
      </span>
      <span className="corsa-notif__hora">{cuandoFue(n.created_at)}</span>
    </button>
  )
}

export function CentroNotificaciones({ compacto = false }: { compacto?: boolean }) {
  const { hasPermission } = useAuth()
  const navigate = useNavigate()
  const [abierto, setAbierto] = useState(false)
  const [items, setItems] = useState<Notificacion[]>([])
  const [cargando, setCargando] = useState(true)
  const contenedor = useRef<HTMLDivElement>(null)

  const puedeVer = hasPermission('plc.read')

  const cargar = useCallback(async () => {
    if (!puedeVer) { setCargando(false); return }
    setItems(await fetchNotificaciones(40))
    setCargando(false)
  }, [puedeVer])

  useEffect(() => {
    cargar()
    const t = setInterval(cargar, INTERVALO_MS)
    return () => clearInterval(t)
  }, [cargar])

  // Cerrar al tocar afuera o con Escape. Sin esto, en el teléfono el panel
  // queda abierto tapando la pantalla y la única salida es navegar.
  useEffect(() => {
    if (!abierto) return
    const fuera = (e: MouseEvent) => {
      if (!contenedor.current?.contains(e.target as Node)) setAbierto(false)
    }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setAbierto(false) }
    document.addEventListener('mousedown', fuera)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', fuera)
      document.removeEventListener('keydown', escape)
    }
  }, [abierto])

  if (!puedeVer) return null

  const sinLeer = items.filter(n => !n.leida).length

  const abrir = async () => {
    const siguiente = !abierto
    setAbierto(siguiente)
    if (siguiente) await cargar()
  }

  const tocar = async (n: Notificacion) => {
    setAbierto(false)
    // Se marca como leída al tocarla, no al abrir el panel: abrir la campana
    // para ver si hay algo no debería borrar el aviso que todavía no se leyó.
    if (!n.leida) {
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, leida: true } : x))
      await marcarLeidas([n.id])
    }
    if (n.deep_link) navigate(n.deep_link)
  }

  const marcarTodas = async () => {
    setItems(prev => prev.map(n => ({ ...n, leida: true })))
    await marcarLeidas()
  }

  return (
    <div className="corsa-notif" ref={contenedor}>
      <button
        id="btn-notificaciones"
        className={`corsa-notif__boton${compacto ? ' compacto' : ''}`}
        onClick={abrir}
        aria-label={sinLeer > 0 ? `Notificaciones, ${sinLeer} sin leer` : 'Notificaciones'}
        aria-expanded={abierto}
      >
        <Campana activa={sinLeer > 0}/>
        {!compacto && <span>Notificaciones</span>}
        {sinLeer > 0 && (
          <span className="corsa-notif__contador">{sinLeer > 99 ? '99+' : sinLeer}</span>
        )}
      </button>

      {abierto && (
        <div className="corsa-notif__panel" role="dialog" aria-label="Notificaciones recientes">
          <div className="corsa-notif__cabecera">
            <span>🔔 Notificaciones</span>
            {sinLeer > 0 && (
              <button className="corsa-notif__marcar" onClick={marcarTodas}>
                Marcar todas
              </button>
            )}
          </div>

          <div className="corsa-notif__lista">
            {cargando && (
              <div className="corsa-notif__vacio">Cargando…</div>
            )}
            {!cargando && items.length === 0 && (
              <div className="corsa-notif__vacio">
                Todavía no hay notificaciones.<br/>
                Acá van a aparecer los lavados terminados, las fallas de las
                máquinas y el cierre del día.
              </div>
            )}
            {items.map(n => <Fila key={n.id} n={n} alTocar={tocar}/>)}
          </div>

          <button
            className="corsa-notif__pie"
            onClick={() => { setAbierto(false); navigate('/settings/notificaciones') }}
          >
            Configurar notificaciones
          </button>
        </div>
      )}
    </div>
  )
}
