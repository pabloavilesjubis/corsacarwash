import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import { registrarServiceWorker } from './lib/push'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

/**
 * El Service Worker se registra siempre, aunque el usuario no tenga
 * notificaciones activadas: es lo que hace que Chrome considere a CORSA
 * instalable y ofrezca «Agregar a la pantalla de inicio». Sin ese paso no hay
 * Push en iPhone, que sólo lo permite a las apps instaladas.
 *
 * Después de `load` y no antes: registrarlo durante el arranque compite por el
 * ancho de banda con el JavaScript de la app y retrasa la primera pantalla.
 *
 * Registrarlo NO pide permiso de notificaciones ni suscribe a nadie. Eso
 * ocurre sólo con un clic en Configuración → Notificaciones.
 */
window.addEventListener('load', () => { registrarServiceWorker() })
