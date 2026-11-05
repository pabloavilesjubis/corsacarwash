/**
 * CORSA — /api/cuponera (0083)
 *
 * Los usuarios de la Cuponera Digital: el personal de CORSA con
 * cuponera.manage los crea, les restablece la contraseña y les corta o
 * devuelve el acceso. Crear un usuario de auth pide el service role, por eso
 * vive acá y no en una RPC.
 *
 *   POST { accion: 'crear_usuario', customerId, nombre, correo, enviarCorreo }
 *   POST { accion: 'restablecer_clave', userId, enviarCorreo }
 *   POST { accion: 'acceso', userId, activo }
 *
 * El usuario nace con app_metadata.portal = 'cuponera': handle_new_user() no
 * le crea profile y el guardián de la API (corsa_pre_request) no le deja
 * llamar otra cosa que las RPC cuponera_portal_*. La contraseña es temporal:
 * el portal obliga a cambiarla al entrar.
 */
import { randomInt } from 'node:crypto'
import { admin, registrarEnvio, tienePermiso, usuarioDe } from '../correo/datos'
import { aviso, boton, esc, fila, layout, parrafo, tarjeta } from '../correo/plantillas'
import { remitente, transporte } from '../correo/smtp'

interface Respuesta { status: number; body: Record<string, unknown> }

class ErrorHttp extends Error {
  constructor(public status: number, mensaje: string) { super(mensaje) }
}

const CORREO_VALIDO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)
/** "Para siempre" en la sintaxis de ban_duration de Supabase Auth. */
const BLOQUEO = '876000h'

/** Sin caracteres que se confundan al dictarla o copiarla (0/O, 1/l/I). */
function claveTemporal(): string {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const parte = (n: number) => Array.from({ length: n }, () => letras[randomInt(letras.length)]).join('')
  return `${parte(4)}-${parte(4)}-${parte(4)}`
}

async function nombreDelCliente(db: ReturnType<typeof admin>, customerId: string): Promise<string> {
  const { data: c } = await db.from('customers')
    .select('customer_type, first_name, last_name, trade_name, legal_name').eq('id', customerId).maybeSingle()
  if (!c) return 'tu empresa'
  return c.customer_type === 'company'
    ? (c.legal_name || c.trade_name || 'tu empresa')
    : (`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'tu empresa')
}

/** El correo de bienvenida (o de contraseña nueva) con el enlace al portal. */
async function enviarAcceso(args: {
  db: ReturnType<typeof admin>
  orgId: string
  userId: string
  customerId: string
  appUrl: string
  nombre: string
  correo: string
  clave: string
  nuevo: boolean
}): Promise<{ enviado: boolean; error?: string }> {
  const empresa = await nombreDelCliente(args.db, args.customerId)
  const portal = `${args.appUrl}/cuponera`
  const asunto = args.nuevo ? 'Tu acceso a la Cuponera Digital de CORSA' : 'Tu nueva contraseña de la Cuponera Digital de CORSA'
  const html = layout({
    appUrl: args.appUrl,
    preheader: args.nuevo ? `Ya puedes entregar los cupones de ${empresa} desde la Cuponera Digital.` : 'Se restableció tu contraseña.',
    titulo: args.nuevo ? 'Bienvenido a la Cuponera Digital' : 'Tu contraseña se restableció',
    cuerpo: parrafo(args.nuevo
      ? `Hola, ${esc(args.nombre.split(' ')[0])}: CORSA Carwash habilitó la Cuponera Digital de <strong>${esc(empresa)}</strong>. Desde ahí ves cuántos cupones compraron, cuántos se han entregado y cuántos quedan, y los entregas por correo o en PDF.`
      : `Hola, ${esc(args.nombre.split(' ')[0])}: CORSA Carwash restableció tu contraseña de la Cuponera Digital de <strong>${esc(empresa)}</strong>.`)
      + tarjeta('Tus datos de acceso', [
        fila('Portal', `<a href="${esc(portal)}" style="color:#16191A">${esc(portal.replace(/^https?:\/\//, ''))}</a>`),
        fila('Usuario', esc(args.correo)),
        fila('Contraseña temporal', `<span style="font-family:monospace;font-size:15px;font-weight:700;letter-spacing:.06em">${esc(args.clave)}</span>`),
      ].join(''))
      + aviso('Al ingresar te pediremos cambiar esta contraseña por una tuya.')
      + parrafo(boton('Ingresar a la Cuponera Digital', portal))
      + parrafo('Si no esperabas este correo, comunícate con CORSA Carwash.'),
  })
  try {
    const info = await transporte().sendMail({ from: remitente(), to: [args.correo], subject: asunto, html })
    await registrarEnvio(args.db, {
      organization_id: args.orgId, tipo: 'cuponera_acceso', customer_id: args.customerId,
      destinatarios: [args.correo], bcc: [], asunto, status: 'sent', message_id: info.messageId ?? null, created_by: args.userId,
    })
    return { enviado: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await registrarEnvio(args.db, {
      organization_id: args.orgId, tipo: 'cuponera_acceso', customer_id: args.customerId,
      destinatarios: [args.correo], bcc: [], asunto, status: 'failed', error: error.slice(0, 500), created_by: args.userId,
    })
    return { enviado: false, error }
  }
}

async function crearUsuario(db: ReturnType<typeof admin>, quien: { userId: string; orgId: string }, appUrl: string, b: any): Promise<Respuesta> {
  const nombre = String(b.nombre ?? '').trim()
  const correo = String(b.correo ?? '').trim().toLowerCase()
  if (!uuid(b.customerId)) throw new ErrorHttp(400, 'Falta el cliente')
  if (!nombre || nombre.length > 120) throw new ErrorHttp(400, 'Escribí el nombre del usuario')
  if (!CORREO_VALIDO.test(correo)) throw new ErrorHttp(400, 'El correo no es válido')

  const { data: cc } = await db.from('cuponera_clientes').select('customer_id, activa')
    .eq('customer_id', b.customerId).eq('organization_id', quien.orgId).maybeSingle()
  if (!cc) throw new ErrorHttp(409, 'Primero habilitá la Cuponera Digital del cliente')

  const clave = claveTemporal()
  const { data: creado, error } = await db.auth.admin.createUser({
    email: correo,
    password: clave,
    email_confirm: true,
    // app_metadata: sólo lo escribe el service role. Es lo que la base mira
    // para no crearle profile y para encerrarlo en las RPC del portal.
    app_metadata: { portal: 'cuponera' },
    user_metadata: { display_name: nombre },
  })
  if (error || !creado?.user) {
    if (/already|registered|exists|duplicate/i.test(error?.message ?? '')) {
      // Puede ser un usuario de CORSA: nunca se convierte una cuenta existente.
      throw new ErrorHttp(409, 'Ese correo ya tiene una cuenta en el sistema de CORSA. Usá otro correo.')
    }
    throw new ErrorHttp(500, 'No se pudo crear el usuario')
  }
  const nuevoId = creado.user.id

  // Defensa en profundidad: si el trigger hubiera corrido antes de que
  // existiera el app_metadata, no queda ningún profile colgado.
  await db.from('profiles').delete().eq('id', nuevoId)

  const { error: errFila } = await db.from('cuponera_usuarios').insert({
    user_id: nuevoId, organization_id: quien.orgId, customer_id: b.customerId,
    nombre, correo, activo: true, debe_cambiar_clave: true, created_by: quien.userId,
  })
  if (errFila) {
    await db.auth.admin.deleteUser(nuevoId)
    throw new ErrorHttp(500, 'No se pudo registrar el usuario; se revirtió la creación')
  }

  const correoEnviado = b.enviarCorreo
    ? await enviarAcceso({ db, orgId: quien.orgId, userId: quien.userId, customerId: b.customerId, appUrl, nombre, correo, clave, nuevo: true })
    : null
  return { status: 201, body: { ok: true, userId: nuevoId, correo, clave, correoEnviado } }
}

async function filaDeUsuario(db: ReturnType<typeof admin>, orgId: string, userId: unknown) {
  if (!uuid(userId)) throw new ErrorHttp(400, 'Falta el usuario')
  const { data: u } = await db.from('cuponera_usuarios')
    .select('user_id, customer_id, nombre, correo, activo').eq('user_id', userId).eq('organization_id', orgId).maybeSingle()
  if (!u) throw new ErrorHttp(404, 'No existe ese usuario de cuponera')
  return u
}

async function restablecerClave(db: ReturnType<typeof admin>, quien: { userId: string; orgId: string }, appUrl: string, b: any): Promise<Respuesta> {
  const u = await filaDeUsuario(db, quien.orgId, b.userId)
  const clave = claveTemporal()
  const { error } = await db.auth.admin.updateUserById(u.user_id, { password: clave })
  if (error) throw new ErrorHttp(500, 'No se pudo cambiar la contraseña')
  await db.from('cuponera_usuarios').update({ debe_cambiar_clave: true }).eq('user_id', u.user_id)
  const correoEnviado = b.enviarCorreo
    ? await enviarAcceso({ db, orgId: quien.orgId, userId: quien.userId, customerId: u.customer_id, appUrl, nombre: u.nombre, correo: u.correo, clave, nuevo: false })
    : null
  return { status: 200, body: { ok: true, clave, correo: u.correo, correoEnviado } }
}

async function cambiarAcceso(db: ReturnType<typeof admin>, quien: { userId: string; orgId: string }, b: any): Promise<Respuesta> {
  const u = await filaDeUsuario(db, quien.orgId, b.userId)
  const activo = b.activo === true
  // Las RPC del portal miran `activo` en cada llamada: el corte es inmediato.
  // El bloqueo en Auth además impide volver a iniciar sesión.
  const { error } = await db.auth.admin.updateUserById(u.user_id, { ban_duration: activo ? 'none' : BLOQUEO })
  if (error) throw new ErrorHttp(500, 'No se pudo cambiar el acceso')
  await db.from('cuponera_usuarios').update({ activo }).eq('user_id', u.user_id)
  return { status: 200, body: { ok: true, activo } }
}

export async function manejar(args: { auth: string | undefined; cuerpo: any; appUrl: string }): Promise<Respuesta> {
  try {
    const jwt = (args.auth ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!jwt) throw new ErrorHttp(401, 'Falta la sesión')
    const db = admin()
    // usuarioDe rechaza a los usuarios de la cuponera: esto es sólo para CORSA.
    const quien = await usuarioDe(db, jwt).catch(e => { throw new ErrorHttp(e.status ?? 401, e.message) })
    if (!await tienePermiso(db, quien.userId, 'cuponera.manage')) {
      throw new ErrorHttp(403, 'No autorizado: se requiere cuponera.manage')
    }
    const b = args.cuerpo ?? {}
    if (b.accion === 'crear_usuario') return await crearUsuario(db, quien, args.appUrl, b)
    if (b.accion === 'restablecer_clave') return await restablecerClave(db, quien, args.appUrl, b)
    if (b.accion === 'acceso') return await cambiarAcceso(db, quien, b)
    throw new ErrorHttp(400, 'Solicitud inválida')
  } catch (e) {
    if (e instanceof ErrorHttp) return { status: e.status, body: { ok: false, error: e.message } }
    console.error('[cuponera]', e)
    return { status: 500, body: { ok: false, error: e instanceof Error ? e.message : 'Error interno' } }
  }
}
