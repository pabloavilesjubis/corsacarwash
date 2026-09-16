/**
 * CORSA Carwash — Configuración → Notificaciones
 *
 * Tres cosas, en este orden: el estado de ESTE dispositivo, la lista de todos
 * los dispositivos de la persona, y —sólo en desarrollo— los eventos simulados.
 *
 * POR QUÉ EL PERMISO SE PIDE ACÁ Y NO AL ENTRAR A CORSA
 * Un navegador que pregunta por notificaciones antes de que el usuario sepa
 * para qué recibe un «Bloquear», y ese bloqueo NO se puede deshacer desde la
 * página: hay que entrar a la configuración del navegador y casi nadie sabe
 * dónde está. Preguntar cinco segundos antes de tiempo cuesta el dispositivo
 * para siempre. Acá el permiso se pide con un clic en un botón que dice
 * exactamente qué hace.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { formatearFechaHora } from '../utils/fecha'
import {
  capacidades, activar, desactivar, suscripcionActual, idDeEsteDispositivo,
  enviarPrueba, diagnosticar, type Capacidades, type Chequeo, type ErrorPush,
} from '../lib/push'
import {
  fetchDispositivos, actualizarDispositivo, eliminarDispositivo,
  fetchConfigNotificaciones,
  type Dispositivo, type ConfigNotificaciones,
} from '../services/notifications.service'

// ─── Interruptor ──────────────────────────────────────────────

function Switch({ on, onChange, disabled, label }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string
}) {
  return (
    <button
      className="corsa-switch"
      data-on={on}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  )
}

// ─── Estado de este dispositivo ───────────────────────────────

/**
 * Qué decirle al usuario según lo que pueda hacer su navegador.
 *
 * Cada caso tiene una salida concreta o dice explícitamente que no la hay.
 * «Tu navegador no es compatible» sin más deja a alguien tocando un botón que
 * nunca va a funcionar.
 */
function diagnostico(cap: Capacidades, suscrito: boolean) {
  if (cap.motivo === 'ios-sin-instalar') {
    return {
      tono: 'warning' as const,
      titulo: 'Falta instalar CORSA en el iPhone',
      texto: 'iOS sólo permite notificaciones a las apps agregadas a la pantalla de inicio. '
           + 'En Safari: botón Compartir → «Agregar a pantalla de inicio». '
           + 'Después abrí CORSA desde ese icono y volvé a esta pantalla.',
      accion: false,
    }
  }
  if (cap.motivo === 'contexto-inseguro') {
    return {
      tono: 'warning' as const,
      titulo: 'Conexión sin HTTPS',
      texto: 'Las notificaciones necesitan una conexión segura. Abrí CORSA por su dirección '
           + 'https:// en lugar de por la IP de la red.',
      accion: false,
    }
  }
  if (!cap.soportado) {
    return {
      tono: 'neutral' as const,
      titulo: 'Este navegador no puede recibir notificaciones',
      texto: 'Probá con Chrome, Edge o Safari actualizados. En iPhone hace falta iOS 16.4 o más '
           + 'nuevo y tener CORSA instalada en la pantalla de inicio.',
      accion: false,
    }
  }
  if (cap.permiso === 'denied') {
    return {
      tono: 'danger' as const,
      titulo: 'Notificaciones bloqueadas en este navegador',
      texto: 'El bloqueo no se puede levantar desde acá: hay que habilitarlas en la '
           + 'configuración del sitio del navegador (el candado junto a la dirección) '
           + 'y volver a entrar.',
      accion: false,
    }
  }
  if (suscrito) {
    return {
      tono: 'success' as const,
      titulo: 'Notificaciones activas en este dispositivo',
      texto: 'Vas a recibir los lavados terminados, las fallas de las máquinas y el cierre '
           + 'del día, aunque CORSA esté cerrada.',
      accion: true,
    }
  }
  return {
    tono: 'neutral' as const,
    titulo: 'Notificaciones apagadas en este dispositivo',
    texto: 'Activalas para enterarte de lo que pasa en las máquinas sin tener CORSA abierta.',
    accion: true,
  }
}

const COLOR_TONO = {
  success: { fondo: 'var(--color-success-tint)', texto: 'var(--color-success-text)' },
  warning: { fondo: 'var(--color-warning-tint)', texto: 'var(--color-warning-text)' },
  danger:  { fondo: 'var(--color-danger-tint)',  texto: 'var(--color-danger-text)' },
  neutral: { fondo: 'var(--subtle-bg)',          texto: 'var(--text-secondary)' },
}

// ─── Pantalla ─────────────────────────────────────────────────

export function NotificacionesPage() {
  const { user, hasPermission } = useAuth()
  const [cap, setCap] = useState<Capacidades | null>(null)
  const [suscrito, setSuscrito] = useState(false)
  const [idDeEste, setIdDeEste] = useState<string | null>(null)
  const [dispositivos, setDispositivos] = useState<Dispositivo[]>([])
  const [config, setConfig] = useState<ConfigNotificaciones | null>(null)
  const [trabajando, setTrabajando] = useState(false)
  const [chequeos, setChequeos] = useState<Chequeo[] | null>(null)
  const [revisando, setRevisando] = useState(false)
  const [ultimoError, setUltimoError] = useState<ErrorPush | null>(null)
  const [cargando, setCargando] = useState(true)

  const puedeSimular = import.meta.env.DEV
    && hasPermission('plc.manage')
    && config?.simulacion_habilitada === true

  const cargar = useCallback(async () => {
    const [s, id, lista, cfg] = await Promise.all([
      suscripcionActual(),
      idDeEsteDispositivo(),
      fetchDispositivos(),
      fetchConfigNotificaciones(),
    ])

    setCap(capacidades())
    setIdDeEste(id)
    setDispositivos(lista)
    setConfig(cfg)

    // «Suscrito» es que el navegador tenga la suscripción Y que el servidor la
    // tenga encendida. Con una sola de las dos, el usuario vería «activo» y no
    // le llegaría nada.
    const enServidor = id ? lista.find(d => d.id === id) : null
    setSuscrito(Boolean(s && enServidor?.enabled && !enServidor.invalidated_at))
    setCargando(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const alActivar = async () => {
    setTrabajando(true)
    setUltimoError(null)
    const r = await activar()
    setTrabajando(false)

    if (r.ok) {
      toast.success('Notificaciones activadas en este dispositivo')
      setUltimoError(null)
      await cargar()
      return
    }

    if (r.error === 'permiso-denegado') {
      toast.error('El navegador bloqueó las notificaciones')
    } else {
      // El toast dice la etapa, no sólo el mensaje. «Failed to fetch» a secas
      // manda a revisar el teléfono cuando el problema está en el servidor.
      toast.error(r.detalle
        ? `Falló en «${r.detalle.etapa}»`
        : 'No se pudo activar: ' + (r.error ?? 'error desconocido'))
      setUltimoError(r.detalle ?? null)
      // El diagnóstico se corre solo: quien acaba de ver un error no debería
      // tener que descubrir que existe un botón para averiguar por qué.
      await revisar()
    }
    setCap(capacidades())
  }

  const revisar = async () => {
    setRevisando(true)
    setChequeos(await diagnosticar())
    setRevisando(false)
  }

  const alDesactivar = async () => {
    setTrabajando(true)
    try {
      await desactivar()
      toast.success('Notificaciones apagadas en este dispositivo')
      await cargar()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo desactivar')
    }
    setTrabajando(false)
  }

  const cambiar = async (d: Dispositivo, campo: keyof Dispositivo, valor: boolean) => {
    // Optimista: el interruptor responde al toque y se revierte si el servidor
    // dice que no. Esperar la respuesta hace que parezca que no funcionó.
    setDispositivos(prev => prev.map(x => x.id === d.id ? { ...x, [campo]: valor } : x))
    try {
      await actualizarDispositivo(d.id, {
        enabled: campo === 'enabled' ? valor : undefined,
        wash:    campo === 'wash_notifications' ? valor : undefined,
        error:   campo === 'machine_error_notifications' ? valor : undefined,
        cierre:  campo === 'daily_close_notifications' ? valor : undefined,
      })
      if (campo === 'enabled' && d.id === idDeEste) setSuscrito(valor)
    } catch (e) {
      setDispositivos(prev => prev.map(x => x.id === d.id ? { ...x, [campo]: !valor } : x))
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar')
    }
  }

  const borrar = async (d: Dispositivo) => {
    try {
      await eliminarDispositivo(d.id)
      setDispositivos(prev => prev.filter(x => x.id !== d.id))
      toast.success(`${d.device_name} dado de baja`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo eliminar')
    }
  }

  const simular = async (tipo: Parameters<typeof enviarPrueba>[0], extra = {}) => {
    const r = await enviarPrueba(tipo, extra)
    if (r.ok) toast.success('Evento enviado')
    else toast.error(r.error ?? 'No se pudo enviar')
  }

  if (cargando || !cap) {
    return <div className="page-inner"><div className="loading-center"><div className="spinner"/></div></div>
  }

  const d = diagnostico(cap, suscrito)
  const tono = COLOR_TONO[d.tono]

  // Los propios arriba, los del resto del equipo después: quien administra
  // usuarios ve todos, y sin separarlos no encontraría los suyos.
  const mios = dispositivos.filter(x => x.user_id === user?.id)
  const ajenos = dispositivos.filter(x => x.user_id !== user?.id)

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 34, letterSpacing: '-0.025em' }}>
            Notificaciones
          </h1>
          <div className="page-header-sub">
            Avisos de lavados terminados, fallas de máquina y cierre del día.
          </div>
        </div>
      </div>

      {/* ── Este dispositivo ── */}
      <div className="card">
        <div style={{
          display: 'flex', gap: 12, alignItems: 'flex-start',
          padding: '12px 14px', borderRadius: 'var(--radius-sm)', background: tono.fondo,
        }}>
          <span style={{ fontSize: 18, lineHeight: 1.2 }}>🔔</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: tono.texto }}>{d.titulo}</div>
            <div style={{ fontSize: 13, color: tono.texto, opacity: 0.88, marginTop: 3, lineHeight: 1.5 }}>
              {d.texto}
            </div>
          </div>
        </div>

        {d.accion && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
            {!suscrito ? (
              <button className="btn btn-primary" onClick={alActivar} disabled={trabajando}>
                🔔 Activar notificaciones
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={alDesactivar} disabled={trabajando}>
                Desactivar en este dispositivo
              </button>
            )}
          </div>
        )}

        {cap.esIOS && cap.instalada && (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12, lineHeight: 1.5 }}>
            iOS entrega los pushes con la app cerrada, pero puede demorarlos si el teléfono está
            en modo de bajo consumo o si hace días que no se abre CORSA. No se pierden: llegan
            cuando el sistema decide despertar la app.
          </div>
        )}
      </div>

      {/* ── Diagnóstico ──
          No es una pantalla de desarrollo: se ve en producción a propósito.
          El fallo que hay que diagnosticar ocurre en un teléfono contra el
          CORSA desplegado, y leer su consola exige un cable USB. */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Diagnóstico</span>
          <button className="btn btn-ghost" style={{ fontSize: 12.5, padding: '7px 14px' }}
            onClick={revisar} disabled={revisando}>
            {revisando ? 'Revisando…' : 'Revisar este dispositivo'}
          </button>
        </div>

        {ultimoError && (
          <div style={{
            padding: '12px 14px', marginBottom: 12, borderRadius: 'var(--radius-sm)',
            background: 'var(--color-danger-tint)', color: 'var(--color-danger-text)',
          }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>
              Último fallo — etapa «{ultimoError.etapa}»
            </div>
            <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.6, wordBreak: 'break-word' }}>
              <strong>{ultimoError.name}</strong>: {ultimoError.message}
              {ultimoError.url && <><br/>URL: <code>{ultimoError.url}</code></>}
              {ultimoError.status !== undefined && <><br/>HTTP {ultimoError.status}</>}
              {ultimoError.sugerencia && <><br/>→ {ultimoError.sugerencia}</>}
            </div>
          </div>
        )}

        {!chequeos && !revisando && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Revisa, sin activar ni escribir nada, las seis cosas de las que depende una
            notificación: conexión segura, Service Worker, API de Push, clave VAPID, sesión
            y base de datos.
          </div>
        )}

        {chequeos && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {chequeos.map(c => (
              <div key={c.clave} style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: '9px 12px', borderRadius: 12,
                background: c.ok === false ? 'var(--color-danger-tint)' : 'var(--subtle-bg)',
              }}>
                <span style={{ fontSize: 14, lineHeight: 1.4 }}>
                  {c.ok === null ? '—' : c.ok ? '✅' : '❌'}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 13.5, fontWeight: 600,
                    color: c.ok === false ? 'var(--color-danger-text)' : 'var(--text-primary)',
                  }}>
                    {c.titulo}
                  </div>
                  <div style={{
                    fontSize: 12, marginTop: 2, lineHeight: 1.5, wordBreak: 'break-word',
                    color: c.ok === false ? 'var(--color-danger-text)' : 'var(--text-secondary)',
                  }}>
                    {c.detalle}
                    {c.sugerencia && <><br/>→ {c.sugerencia}</>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Mis dispositivos ── */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Mis dispositivos</span>
          <span className="card-header-count">{mios.length}</span>
        </div>

        {mios.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-title">Ningún dispositivo registrado</div>
            <div className="empty-state-sub">
              Activá las notificaciones arriba para registrar este teléfono o computadora.
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {mios.map(x => (
            <FilaDispositivo
              key={x.id} d={x}
              esEste={x.id === idDeEste}
              onCambiar={cambiar} onBorrar={borrar}
            />
          ))}
        </div>
      </div>

      {/* ── Los del resto del equipo ── */}
      {ajenos.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Dispositivos del equipo</span>
            <span className="card-header-count">{ajenos.length}</span>
          </div>
          {/* Agrupados por persona: la pregunta que trae a alguien acá es «¿a
              quién le están llegando las notificaciones?», y una lista plana
              obliga a leer treinta filas para contestarla.

              Sólo lectura: administrar usuarios alcanza para VER por qué a
              alguien no le llegan, no para tocarle las preferencias de su
              teléfono. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {agruparPorUsuario(ajenos).map(([usuario, equipos]) => (
              <div key={usuario}>
                <div style={{
                  fontSize: 12, fontWeight: 600, letterSpacing: '0.03em',
                  color: 'var(--text-secondary)', marginBottom: 6,
                }}>
                  {usuario}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {equipos.map(x => (
                    <div key={x.id} className="corsa-disp">
                      <span style={{ fontSize: 16 }}>
                        {x.platform === 'ios' || x.platform === 'android' ? '📱' : '💻'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="corsa-disp__nombre">{x.device_name}</div>
                        <div className="corsa-disp__meta">
                          {x.invalidated_at
                            ? `Dado de baja — ${x.invalidated_reason ?? 'endpoint vencido'}`
                            : `Última actividad ${formatearFechaHora(x.last_seen_at)} · ${x.recibidas} recibidas`}
                        </div>
                      </div>
                      <span className={`badge ${x.enabled && !x.invalidated_at ? 'badge-success' : 'badge-neutral'}`}>
                        {x.invalidated_at ? 'Vencido' : x.enabled ? 'Activo' : 'Apagado'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Simulación (sólo desarrollo) ── */}
      {import.meta.env.DEV && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Pruebas</span>
            <span className="badge badge-warning">Sólo desarrollo</span>
          </div>

          {!puedeSimular ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              Los eventos simulados están deshabilitados. Para habilitarlos en un entorno de
              prueba, con permiso <code>plc.manage</code>:
              <pre style={{
                marginTop: 8, padding: '10px 12px', background: 'var(--subtle-bg)',
                borderRadius: 10, fontSize: 12, overflowX: 'auto',
              }}>{`update corsa_notification_config
   set simulacion_habilitada = true;`}</pre>
              Nunca en producción: es el cerrojo que impide que alguien dispare notificaciones
              falsas desde la aplicación.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
                Los eventos simulados llegan sólo a tus dispositivos y no tocan ninguna tabla de
                máquinas: no crean lavados ni alteran las estadísticas.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={() => simular('TEST')}>
                  Enviar Push de prueba
                </button>
                {(['PRO', 'ELITE', 'SIGNATURE'] as const).map(s => (
                  <button key={s} className="btn btn-ghost"
                    onClick={() => simular('WASH_COMPLETED', { servicio: s })}>
                    Simular lavado {s}
                  </button>
                ))}
                {['machine-1', 'machine-2'].map((m, i) => (
                  <button key={m} className="btn btn-ghost"
                    onClick={() => simular('MACHINE_ERROR', { machine: m })}>
                    Simular error Máquina {i + 1}
                  </button>
                ))}
                <button className="btn btn-ghost" onClick={() => simular('DAILY_CLOSE')}>
                  Simular cierre diario
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Los dispositivos del equipo, agrupados por dueño y ordenados por nombre. */
function agruparPorUsuario(lista: Dispositivo[]): [string, Dispositivo[]][] {
  const mapa = new Map<string, Dispositivo[]>()
  for (const d of lista) {
    const clave = d.usuario?.trim() || 'Sin nombre'
    mapa.set(clave, [...(mapa.get(clave) ?? []), d])
  }
  return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b, 'es'))
}

// ─── Una fila de dispositivo propio ───────────────────────────

function FilaDispositivo({ d, esEste, onCambiar, onBorrar }: {
  d: Dispositivo
  esEste: boolean
  onCambiar: (d: Dispositivo, campo: keyof Dispositivo, valor: boolean) => void
  onBorrar: (d: Dispositivo) => void
}) {
  const vencido = Boolean(d.invalidated_at)

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
      background: 'var(--surface)', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
        <span style={{ fontSize: 18 }}>
          {d.platform === 'ios' || d.platform === 'android' ? '📱' : '💻'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="corsa-disp__nombre">
            {d.device_name}
            {esEste && <span className="badge badge-orange" style={{ marginLeft: 8 }}>Este dispositivo</span>}
          </div>
          <div className="corsa-disp__meta">
            Registrado {formatearFechaHora(d.created_at)}
            {' · '}
            {vencido
              ? `Dado de baja: ${d.invalidated_reason ?? 'endpoint vencido'}`
              : `Última actividad ${formatearFechaHora(d.last_seen_at)}`}
          </div>
        </div>
        <Switch
          on={d.enabled && !vencido}
          disabled={vencido}
          label={`Notificaciones en ${d.device_name}`}
          onChange={v => onCambiar(d, 'enabled', v)}
        />
      </div>

      {/* Qué recibe este dispositivo. Se ocultan si está apagado: ofrecer
          interruptores que no hacen nada confunde más que no mostrarlos. */}
      {d.enabled && !vencido && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 2,
          padding: '4px 14px 12px', borderTop: '1px solid var(--border)',
        }}>
          {([
            ['wash_notifications', '🚗 Lavados terminados'],
            ['machine_error_notifications', '⚠️ Fallas de máquina'],
            ['daily_close_notifications', '🌙 Cierre del día'],
          ] as const).map(([campo, etiqueta]) => (
            <label key={campo} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, padding: '7px 0', fontSize: 13.5, color: 'var(--text-primary)',
            }}>
              <span>{etiqueta}</span>
              <Switch
                on={d[campo] as boolean}
                label={etiqueta}
                onChange={v => onCambiar(d, campo, v)}
              />
            </label>
          ))}
        </div>
      )}

      {vencido && (
        <div style={{ padding: '8px 14px 12px', borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost" style={{ fontSize: 12.5, padding: '7px 14px' }}
            onClick={() => onBorrar(d)}>
            Quitar de la lista
          </button>
        </div>
      )}
    </div>
  )
}
