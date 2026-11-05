/**
 * El buzón y el transporte de CORSA. Lo comparten /api/correo y /api/cuponera:
 * todo sale del mismo SMTP con el que salen los DTE y los CCF.
 */
import nodemailer from 'nodemailer'

/** El buzón de CORSA: recibe lo que no tiene a quién ir, y copia de todo. */
export const CORREO_CORSA = 'corsacarwash@gmail.com'

export function transporte() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
    throw Object.assign(new Error('El correo no está configurado en el servidor (SMTP).'), { status: 500 })
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: String(SMTP_SECURE ?? 'true').toLowerCase() !== 'false',
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  })
}

export function remitente(): string {
  const correo = process.env.SMTP_FROM || process.env.SMTP_USER || CORREO_CORSA
  return `"${(process.env.SMTP_FROM_NAME || 'CORSA Carwash').replace(/"/g, '')}" <${correo}>`
}
