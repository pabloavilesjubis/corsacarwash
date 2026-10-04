/**
 * CORSA — correos (0061). Los envía /api/correo con el SMTP de Gmail: el DTE
 * en PDF y JSON, el agradecimiento por cada lavado al crédito con su estado de
 * cuenta, el CCF consolidado y el estado de cuenta. La app sólo pide; el
 * servidor decide destinatarios y deja constancia en envios_correo.
 */
import { supabase } from '../lib/supabase'

export interface ResultadoCorreo { ok: boolean; estado?: 'sent' | 'failed'; error?: string; destinatarios?: string[] }

async function pedir(cuerpo: Record<string, unknown>): Promise<ResultadoCorreo> {
  const token = (await supabase.auth.getSession()).data.session?.access_token
  if (!token) return { ok: false, error: 'La sesión venció. Volvé a ingresar.' }
  try {
    const res = await fetch('/api/correo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(cuerpo),
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok && json.ok === true, estado: json.estado, error: json.error, destinatarios: json.destinatarios }
  } catch {
    return { ok: false, error: 'No se pudo contactar al servidor de correo.' }
  }
}

/** El correo de una venta: su DTE, o el agradecimiento del lavado si fue al crédito. */
export const enviarCorreoVenta = (workOrderId: string) => pedir({ accion: 'venta', workOrderId })
/** El correo de una factura sin venta propia (CCF consolidado). */
export const enviarCorreoFactura = (invoiceId: string) => pedir({ accion: 'factura', invoiceId })
export const enviarEstadoCuenta = (customerId: string) => pedir({ accion: 'estado_cuenta', customerId })
/** El reporte de cierre de caja en PDF (0065), a la gerencia. */
export const enviarCierreCaja = (sessionId: string) => pedir({ accion: 'cierre_caja', sessionId })
