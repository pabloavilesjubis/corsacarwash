/**
 * Entrada de Vercel para /api/correo. Se empaqueta con scripts/build-api.mjs
 * en api/correo.js (un solo archivo: el código de src/ que usa no corre suelto
 * en Node). Después de cambiar algo en server/ o en lo que importa de src/,
 * volver a correr `npm run build:api`.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { manejar } from './handler'

export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no permitido' })
    return
  }
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? ''
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'
  const r = await manejar({ auth: req.headers.authorization, cuerpo: req.body, appUrl: `${proto}://${host}` })
  res.status(r.status).json(r.body)
}
