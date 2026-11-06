/**
 * Entrada de Vercel para /api/documentos. Se empaqueta con scripts/build-api.mjs
 * en api/documentos.js. Después de cambiar algo en server/ o en lo que importa
 * de src/, volver a correr `npm run build:api`.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { manejar } from './handler'

export const config = { maxDuration: 60 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no permitido' })
    return
  }
  const r = await manejar({ auth: req.headers.authorization, cuerpo: req.body })
  res.status(r.status).json(r.body)
}
