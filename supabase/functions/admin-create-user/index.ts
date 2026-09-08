/**
 * CORSA Carwash — Edge Function: admin-create-user
 *
 * Crea un usuario en auth.users y le asigna roles.
 *
 * SEGURIDAD:
 * - La service_role key NUNCA puede estar en el frontend: salta todo el RLS.
 *   Por eso la creación de usuarios vive acá, del lado del servidor.
 * - Se verifica el JWT del llamante y su permiso users.manage ANTES de
 *   usar el cliente privilegiado.
 * - La organization_id se toma del profile del llamante, nunca del body:
 *   así un admin no puede crear usuarios en otra organización.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Falta el token de sesión' }, 401)

  // ── Cliente con la identidad del llamante (sujeto a RLS) ──
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: userErr } = await caller.auth.getUser()
  if (userErr || !user) return json({ error: 'Sesión inválida' }, 401)

  // ── Verificar permiso users.manage ──
  const { data: allowed, error: permErr } = await caller.rpc('has_permission', {
    permission_code: 'users.manage',
  })
  if (permErr) return json({ error: 'No se pudo verificar permisos' }, 500)
  if (allowed !== true) {
    return json({ error: 'No autorizado: se requiere el permiso users.manage' }, 403)
  }

  // ── La organización sale del profile del llamante, no del body ──
  const { data: callerProfile, error: profErr } = await caller
    .from('profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()

  if (profErr || !callerProfile) return json({ error: 'Perfil del llamante no encontrado' }, 403)
  const organizationId = callerProfile.organization_id

  // ── Validar el payload ──
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'JSON inválido' }, 400)
  }

  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const firstName = String(body.first_name ?? '').trim()
  const lastName = String(body.last_name ?? '').trim()
  const phone = body.phone ? String(body.phone).trim() : null
  const roleIds = Array.isArray(body.role_ids) ? (body.role_ids as string[]) : []

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Correo inválido' }, 400)
  if (password.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400)
  if (!firstName) return json({ error: 'El nombre es obligatorio' }, 400)
  if (roleIds.length === 0) return json({ error: 'Asigná al menos un rol' }, 400)

  // ── Cliente privilegiado (salta RLS) ──
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Los roles deben pertenecer a la organización del llamante
  const { data: validRoles, error: rolesErr } = await admin
    .from('roles')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .in('id', roleIds)

  if (rolesErr) return json({ error: 'No se pudieron validar los roles' }, 500)
  if (!validRoles || validRoles.length !== roleIds.length) {
    return json({ error: 'Uno o más roles no son válidos para esta organización' }, 400)
  }

  // Solo un Super Admin puede crear otro Super Admin
  const SUPER_ADMIN_ID = '00000000-0000-0000-0002-000000000001'
  if (roleIds.includes(SUPER_ADMIN_ID)) {
    const { data: isSuper } = await caller.rpc('is_super_admin')
    if (isSuper !== true) {
      return json({ error: 'Solo un Super Admin puede crear otro Super Admin' }, 403)
    }
  }

  // ── Crear el usuario ──
  // El trigger handle_new_user() crea el profile leyendo user_metadata.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,   // alta presencial: sin correo de confirmación
    user_metadata: {
      organization_id: organizationId,
      first_name: firstName,
      last_name: lastName,
      display_name: [firstName, lastName].filter(Boolean).join(' ') || email,
      phone,
    },
  })

  if (createErr || !created?.user) {
    const msg = createErr?.message ?? ''
    if (/already registered|already been registered|duplicate/i.test(msg)) {
      return json({ error: 'Ya existe un usuario con ese correo' }, 409)
    }
    return json({ error: 'No se pudo crear el usuario' }, 500)
  }

  const newUserId = created.user.id

  // ── Asignar roles ──
  const { error: roleErr } = await admin
    .from('user_roles')
    .insert(roleIds.map(rid => ({ user_id: newUserId, role_id: rid, granted_by: user.id })))

  if (roleErr) {
    // Sin roles el usuario es inútil (has_permission = false en todo).
    // Revertimos para no dejar cuentas huérfanas.
    await admin.auth.admin.deleteUser(newUserId)
    return json({ error: 'No se pudieron asignar los roles; se revirtió la creación' }, 500)
  }

  return json({ id: newUserId, email }, 201)
})
