/**
 * CORSA Carwash — el puente entre el Service Worker y la aplicación.
 *
 * No dibuja nada. Hace dos cosas que sólo se pueden hacer desde adentro de la
 * app, con sesión y con el ruteo montado:
 *
 * 1. SINCRONIZAR LA SUSCRIPCIÓN. El navegador puede cambiarle el endpoint a un
 *    dispositivo por su cuenta —caduca, rota, se reinstala—. El Service Worker
 *    es quien se entera, pero no tiene la sesión del usuario para avisarle al
 *    servidor. Si nadie lo hace, el servidor sigue mandando pushes a un
 *    endpoint muerto y la persona deja de recibir notificaciones sin que nada
 *    se lo indique. Acá se registra la suscripción vigente en cada apertura.
 *
 * 2. NAVEGAR AL TOCAR UN PUSH. Cuando CORSA ya está abierta, el Service Worker
 *    enfoca esa ventana y le pide que navegue. Algunos navegadores no le dejan
 *    navegar una ventana ajena; en ese caso manda un mensaje y el ruteo lo
 *    hace desde adentro, que es lo que se escucha acá.
 *
 * NO PIDE PERMISO NI SE SUSCRIBE. Si el usuario nunca activó las
 * notificaciones, este componente no hace absolutamente nada.
 */
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { sincronizar } from '../lib/push'

export function PuenteNotificaciones() {
  const { session } = useAuth()
  const navigate = useNavigate()

  // La sincronización espera a que haya sesión: sin ella, el RPC que registra
  // el dispositivo rebota y el dispositivo quedaría sin actualizar.
  useEffect(() => {
    if (!session) return
    sincronizar()
  }, [session])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const alMensaje = (e: MessageEvent) => {
      if (e.data?.tipo !== 'corsa:navegar' || typeof e.data.url !== 'string') return
      // Ruta relativa siempre: el Service Worker manda lo que guardó en la
      // notificación, que es lo que compuso el servidor.
      navigate(e.data.url)
    }

    navigator.serviceWorker.addEventListener('message', alMensaje)
    return () => navigator.serviceWorker.removeEventListener('message', alMensaje)
  }, [navigate])

  return null
}
