import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
// Va acá y no en MovilShell, que es de donde colgaba. MovilShell se carga con
// lazy(), así que su CSS viajaba en un trozo aparte que sólo llega cuando el
// armazón móvil se monta — y en la pantalla de ingreso ese armazón no existe.
// O sea que la pantalla por la que todos entran era la única sin las reglas de
// teléfono: los campos quedaban en 14 px y el primer toque del día, el del
// correo, era el que disparaba el zoom de iOS para toda la sesión.
//
// Cargarlo siempre no le cuesta nada al escritorio: el archivo entero vive
// adentro de una media query que arriba de 820 px el navegador no aplica. Una
// media query la tiene que decidir el navegador por el ancho, no un import de
// JavaScript por la ruta.
import './mobile/responsivo.css'
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
