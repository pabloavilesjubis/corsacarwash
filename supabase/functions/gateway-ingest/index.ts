/**
 * CORSA — Ingesta del PLC Gateway
 *
 * Recibe eventos, ciclos y heartbeats del gateway que monitorea las máquinas
 * de lavado dentro del carwash.
 *
 * POR QUÉ EXISTE ESTA FUNCIÓN Y NO UNA CONEXIÓN DIRECTA
 * El gateway corre en una Surface físicamente accesible dentro del local. Si
 * tuviera credenciales de base y se filtraran, el atacante entraría a la base
 * de producción del negocio entero. Acá el gateway sólo tiene una clave propia
 * que le permite UNA cosa: insertar sus propios datos. La escritura la hace
 * esta función con service_role, del lado del servidor.
 *
 * IDEMPOTENCIA
 * Cada evento y ciclo llega con el UUID que generó el gateway. Se hace upsert
 * sobre esa llave, así reenviar un lote tras un corte de Internet no duplica
 * nada — que es exactamente lo que va a pasar cuando el carwash recupere la
 * conexión después de horas sin ella.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-gateway-id, x-gateway-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

/** SHA-256 en hexadecimal, para comparar contra api_key_hash. */
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Tope de elementos por lote: evita que un pedido enorme agote la función. */
const MAX_BATCH = 500

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  const url = new URL(req.url)
  // La ruta es /gateway-ingest/<acción>
  const action = url.pathname.split('/').filter(Boolean).pop()

  const gatewayId = req.headers.get('x-gateway-id')
  const apiKey = req.headers.get('x-gateway-key')

  if (!gatewayId || !apiKey) {
    return json({ error: 'Faltan las credenciales del gateway' }, 401)
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  // ── Autenticar el gateway ──
  // Se busca por hash: la clave en claro no existe del lado del servidor.
  const keyHash = await sha256(apiKey)
  const { data: gateway, error: authError } = await admin
    .from('plc_gateways')
    .select('id, organization_id, gateway_id, active')
    .eq('gateway_id', gatewayId)
    .eq('api_key_hash', keyHash)
    .maybeSingle()

  if (authError) return json({ error: 'No se pudo validar el gateway' }, 500)

  // Mismo mensaje para clave incorrecta y gateway inexistente: distinguirlos
  // le diría a un atacante qué identificadores existen.
  if (!gateway) return json({ error: 'Credenciales inválidas' }, 401)
  if (!gateway.active) return json({ error: 'Gateway desactivado' }, 403)

  const orgId = gateway.organization_id

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'JSON inválido' }, 400)
  }

  try {
    switch (action) {
      case 'events': {
        const events = Array.isArray(body.events) ? body.events : []
        if (events.length === 0) return json({ received: 0 })
        if (events.length > MAX_BATCH) return json({ error: `Máximo ${MAX_BATCH} eventos por lote` }, 400)

        const rows = events.map((e: any) => ({
          id: e.id,
          organization_id: orgId,
          gateway_id: gateway.gateway_id,
          machine_id: e.machine_id,
          event_type: e.event_type,
          previous_value: e.previous_value ?? null,
          new_value: e.new_value ?? null,
          event_timestamp: e.event_timestamp,
          gateway_created_at: e.created_at ?? null,
        }))

        // ignoreDuplicates: un reenvío no debe pisar el registro original ni
        // fallar. El primer envío gana; los reintentos son inofensivos.
        const { error } = await admin
          .from('plc_machine_events')
          .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })

        if (error) return json({ error: error.message }, 500)
        return json({ received: rows.length })
      }

      case 'cycles': {
        const cycles = Array.isArray(body.cycles) ? body.cycles : []
        if (cycles.length === 0) return json({ received: 0 })
        if (cycles.length > MAX_BATCH) return json({ error: `Máximo ${MAX_BATCH} ciclos por lote` }, 400)

        const rows = cycles.map((c: any) => ({
          id: c.id,
          organization_id: orgId,
          gateway_id: gateway.gateway_id,
          machine_id: c.machine_id,
          started_at: c.started_at,
          completed_at: c.completed_at ?? null,
          duration_seconds: c.duration_seconds ?? null,
          status: c.status,
          updated_at: new Date().toISOString(),
        }))

        // Los ciclos SÍ se actualizan: uno enviado como IN_PROGRESS puede
        // llegar después como COMPLETED con su duración.
        const { error } = await admin
          .from('plc_wash_cycles')
          .upsert(rows, { onConflict: 'id' })

        if (error) return json({ error: error.message }, 500)
        return json({ received: rows.length })
      }

      case 'heartbeat': {
        const reportedAt = (body.timestamp as string) ?? new Date().toISOString()

        const { error: hbError } = await admin.from('plc_gateway_heartbeats').insert({
          organization_id: orgId,
          gateway_id: gateway.gateway_id,
          version: body.version ?? null,
          pending_events: body.pending_events ?? null,
          machines: body.machines ?? null,
          reported_at: reportedAt,
        })
        if (hbError) return json({ error: hbError.message }, 500)

        await admin
          .from('plc_gateways')
          .update({
            last_seen_at: reportedAt,
            last_version: body.version ?? null,
            pending_events: body.pending_events ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', gateway.id)

        return json({ ok: true })
      }

      default:
        return json({ error: `Acción desconocida '${action}'` }, 404)
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Error inesperado' }, 500)
  }
})
