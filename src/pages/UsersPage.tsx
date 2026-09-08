/**
 * CORSA Carwash — Usuarios y roles
 *
 * Alta de usuarios y asignación de roles. Toda la autorización real
 * vive en el servidor (RPC security-definer + Edge Function); el gate
 * de UI de acá es sólo para no mostrar acciones que van a fallar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { ClipButton } from '../components/ui/ClipButton'
import { useAuth } from '../hooks/useAuth'
import {
  listUsers, listRoles, setUserRoles, setUserActive,
  createUser, generateTempPassword,
  listPermissions, listRolePermissions, setRolePermissions,
  type AdminUser, type AdminRole, type AdminPermission,
} from '../services/users.service'
// ASSIGNABLE_SCREENS y no SCREENS: las pantallas ocultas no se ofrecen ni se
// cuentan, o un rol figuraría con "8 de 12" sin poder llegar nunca a 12.
import { ASSIGNABLE_SCREENS, SCREEN_PERMISSION_CODES } from '../lib/screens'

const SUPER_ADMIN_ROLE_ID = '00000000-0000-0000-0002-000000000001'

// Constante a nivel de módulo, no `new Set()` en el render: un Set nuevo en
// cada pasada cambiaría la identidad de la prop `granted` y el efecto que
// sincroniza la selección se dispararía en bucle.
const NO_PERMISSIONS: ReadonlySet<string> = new Set<string>()

// ─── Helpers ─────────────────────────────────────────────────

function fullName(u: AdminUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return name || u.display_name || u.email
}

function relativeDate(iso: string | null): string {
  if (!iso) return 'Nunca'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'Hoy'
  if (days === 1) return 'Ayer'
  if (days < 30) return `Hace ${days} días`
  return new Date(iso).toLocaleDateString('es-SV', { day: '2-digit', month: 'short', year: 'numeric' })
}

function RoleChips({ names }: { names: string[] }) {
  if (names.length === 0) {
    return (
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-danger-text)', background: 'var(--color-danger-bg, #FBE7E7)', padding: '3px 8px', borderRadius: 4 }}>
        Sin rol — no puede operar
      </span>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {names.map(n => (
        <span key={n} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)', background: 'var(--subtle-bg)', border: '1px solid var(--border)', padding: '3px 8px', borderRadius: 4 }}>
          {n}
        </span>
      ))}
    </div>
  )
}

function RolePicker({
  roles, selected, onToggle,
}: {
  roles: AdminRole[]
  selected: Set<string>
  onToggle: (id: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {roles.map(r => (
        <label
          key={r.id}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 11px',
            border: `1px solid ${selected.has(r.id) ? 'var(--corsa-green)' : 'var(--border)'}`,
            borderRadius: 5, cursor: 'pointer',
            background: selected.has(r.id) ? 'var(--subtle-bg)' : 'transparent',
          }}
        >
          <input
            type="checkbox"
            checked={selected.has(r.id)}
            onChange={() => onToggle(r.id)}
            style={{ marginTop: 2, accentColor: 'var(--corsa-green)' }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{r.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 1 }}>
              {r.description ?? ''} · {r.permission_count} permisos
            </div>
          </div>
        </label>
      ))}
    </div>
  )
}

// ─── Panel: nuevo usuario ────────────────────────────────────

function NewUserPanel({
  roles, onClose, onCreated,
}: {
  roles: AdminRole[]
  onClose: () => void
  onCreated: () => void
}) {
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState(() => generateTempPassword())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (selected.size === 0) { toast.error('Asigná al menos un rol'); return }
    setSaving(true)
    try {
      await createUser({
        email: email.trim(),
        password,
        first_name: firstName.trim(),
        last_name: lastName.trim() || undefined,
        phone: phone.trim() || undefined,
        role_ids: [...selected],
      })
      toast.success(`Usuario ${email.trim()} creado`)
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo crear el usuario')
    }
    setSaving(false)
  }

  return (
    <div className="side-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Nuevo usuario</div>
        <button className="panel-close" onClick={onClose} aria-label="Cerrar">×</button>
      </div>

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <input className="corsa-input" placeholder="Nombre *" value={firstName}
               onChange={e => setFirstName(e.target.value)} required/>
        <input className="corsa-input" placeholder="Apellido" value={lastName}
               onChange={e => setLastName(e.target.value)}/>
        <input className="corsa-input" placeholder="Correo *" type="email" value={email}
               onChange={e => setEmail(e.target.value)} required autoComplete="off"/>
        <input className="corsa-input" placeholder="Teléfono" value={phone}
               onChange={e => setPhone(e.target.value)}/>

        <div className="field">
          <label htmlFor="temp-password">Contraseña temporal</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="temp-password"
              className="corsa-input font-mono"
              value={password}
              onChange={e => setPassword(e.target.value)}
              minLength={8}
              required
              autoComplete="new-password"
            />
            <button type="button" className="btn btn-ghost" style={{ whiteSpace: 'nowrap' }}
                    onClick={() => setPassword(generateTempPassword())}>
              Generar
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            Entregásela al empleado para su primer ingreso. Pedile que la cambie.
          </div>
        </div>

        <div className="panel-section-label" style={{ marginTop: 4 }}>Roles *</div>
        <RolePicker roles={roles} selected={selected} onToggle={toggle}/>

        <button
          type="submit"
          disabled={saving}
          style={{ textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: '#fff', background: 'var(--corsa-green)', borderRadius: 5, padding: 10, cursor: 'pointer', border: 'none', marginTop: 4 }}
        >
          {saving ? 'Creando…' : 'Crear usuario'}
        </button>
      </form>
    </div>
  )
}

// ─── Panel: editar usuario ───────────────────────────────────

function EditUserPanel({
  user, roles, isSelf, screenLabels, onClose, onChanged,
}: {
  user: AdminUser
  roles: AdminRole[]
  isSelf: boolean
  /** Pantallas efectivas que resultan de los roles YA guardados. */
  screenLabels: string[]
  onClose: () => void
  onChanged: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(user.role_ids))
  const [saving, setSaving] = useState(false)

  useEffect(() => { setSelected(new Set(user.role_ids)) }, [user.id, user.role_ids])

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      await setUserRoles(user.id, [...selected])
      toast.success('Roles actualizados')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudieron actualizar los roles')
    }
    setSaving(false)
  }

  const toggleActive = async () => {
    try {
      await setUserActive(user.id, !user.active)
      toast.success(user.active ? 'Usuario desactivado' : 'Usuario activado')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cambiar el estado')
    }
  }

  const dirty =
    selected.size !== user.role_ids.length ||
    [...selected].some(id => !user.role_ids.includes(id))

  return (
    <div className="side-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }} className="truncate">
            {fullName(user)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }} className="truncate">{user.email}</div>
        </div>
        <button className="panel-close" onClick={onClose} aria-label="Cerrar">×</button>
      </div>

      <div className="panel-divider"/>

      <div className="panel-row">
        <span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Estado</span>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{user.active ? 'Activo' : 'Inactivo'}</span>
      </div>
      <div className="panel-row">
        <span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Último acceso</span>
        <span style={{ fontSize: 12.5 }}>{relativeDate(user.last_login_at)}</span>
      </div>

      <div className="panel-section-label" style={{ marginTop: 8 }}>Roles</div>
      <RolePicker roles={roles} selected={selected} onToggle={toggle}/>

      {selected.size === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--color-danger-text)' }}>
          Sin ningún rol el usuario puede iniciar sesión pero no podrá leer ni guardar nada.
        </div>
      )}

      <div className="panel-section-label" style={{ marginTop: 4 }}>
        Pantallas que ve hoy
      </div>
      {screenLabels.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Ninguna.</div>
      ) : (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {screenLabels.map(label => (
            <span key={label} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)', background: 'var(--subtle-bg)', border: '1px solid var(--border)', padding: '3px 8px', borderRadius: 4 }}>
              {label}
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: -6 }}>
        Se derivan de los roles guardados. Para cambiar qué pantallas incluye un
        rol, usá la pestaña <strong>Roles y pantallas</strong>.
      </div>

      <button
        onClick={save}
        disabled={saving || !dirty}
        style={{ textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: '#fff', background: dirty ? 'var(--corsa-green)' : 'var(--text-secondary)', borderRadius: 5, padding: 10, cursor: dirty ? 'pointer' : 'default', border: 'none', opacity: dirty ? 1 : 0.5 }}
      >
        {saving ? 'Guardando…' : 'Guardar roles'}
      </button>

      {!isSelf && (
        <button className={`btn ${user.active ? 'btn-danger' : 'btn-ghost'}`} onClick={toggleActive}>
          {user.active ? 'Desactivar usuario' : 'Activar usuario'}
        </button>
      )}
    </div>
  )
}

// ─── Panel: pantallas de un rol ──────────────────────────────

/**
 * Editor de "qué pantallas ve este rol".
 *
 * El RPC reemplaza el conjunto COMPLETO de permisos del rol, así que hay que
 * preservar los permisos de acción (orders.create, ar.read, …) y tocar sólo
 * los de pantalla. Mandar únicamente lo tildado acá borraría todo lo demás.
 */
function RoleScreensPanel({
  role, permissions, granted, onClose, onSaved,
}: {
  role: AdminRole
  permissions: AdminPermission[]
  granted: ReadonlySet<string>
  onClose: () => void
  onSaved: () => void
}) {
  const permByCode = useMemo(
    () => new Map(permissions.map(p => [p.code, p])),
    [permissions]
  )

  // Ids de los permisos que representan pantallas — el resto se preserva tal cual.
  const screenPermIds = useMemo(() => {
    const ids = new Set<string>()
    for (const code of SCREEN_PERMISSION_CODES) {
      const perm = permByCode.get(code)
      if (perm) ids.add(perm.id)
    }
    return ids
  }, [permByCode])

  const initial = useMemo(
    () => new Set([...granted].filter(id => screenPermIds.has(id))),
    [granted, screenPermIds]
  )

  const [selected, setSelected] = useState<Set<string>>(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setSelected(initial) }, [initial])

  const isSuperAdmin = role.id === SUPER_ADMIN_ROLE_ID

  // Si faltan códigos en el catálogo, la migración 0027 no se corrió.
  const missing = SCREEN_PERMISSION_CODES.filter(c => !permByCode.has(c))

  const toggle = (permId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(permId)) next.delete(permId); else next.add(permId)
      return next
    })
  }

  const dirty =
    selected.size !== initial.size ||
    [...selected].some(id => !initial.has(id))

  const save = async () => {
    setSaving(true)
    try {
      const preserved = [...granted].filter(id => !screenPermIds.has(id))
      await setRolePermissions(role.id, [...preserved, ...selected])
      toast.success(`Pantallas de ${role.name} actualizadas`)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudieron guardar las pantallas')
    }
    setSaving(false)
  }

  return (
    <div className="side-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }} className="truncate">
            {role.name}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {role.description ?? 'Sin descripción'}
          </div>
        </div>
        <button className="panel-close" onClick={onClose} aria-label="Cerrar">×</button>
      </div>

      <div className="panel-divider"/>

      {missing.length > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--color-danger-text)', background: 'var(--color-danger-bg, #FBE7E7)', padding: '8px 10px', borderRadius: 5 }}>
          Faltan {missing.length} permisos de pantalla en la base. Corré la migración
          <strong> 0027_screen_access.sql</strong> antes de usar esta sección.
        </div>
      )}

      {isSuperAdmin ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Super Admin ve todo el sistema.</strong><br/>
          El rol es inmutable a propósito: si se le pudieran quitar pantallas,
          una organización podría quedarse sin nadie capaz de restaurar accesos.
        </div>
      ) : (
        <>
          <div className="panel-section-label">Pantallas visibles</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ASSIGNABLE_SCREENS.map(sc => {
              const perm = permByCode.get(sc.permission)
              const checked = perm ? selected.has(perm.id) : false
              return (
                <label
                  key={sc.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px',
                    border: `1px solid ${checked ? 'var(--corsa-green)' : 'var(--border)'}`,
                    borderRadius: 5, cursor: perm ? 'pointer' : 'not-allowed',
                    background: checked ? 'var(--subtle-bg)' : 'transparent',
                    opacity: perm ? 1 : 0.45,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!perm}
                    onChange={() => perm && toggle(perm.id)}
                    style={{ accentColor: 'var(--corsa-green)' }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{sc.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }} className="font-mono">{sc.permission}</div>
                  </div>
                </label>
              )
            })}
          </div>

          {selected.size === 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--color-danger-text)' }}>
              Sin ninguna pantalla, quien tenga sólo este rol entra pero no ve nada.
            </div>
          )}

          <button
            onClick={save}
            disabled={saving || !dirty}
            style={{ textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: '#fff', background: dirty ? 'var(--corsa-green)' : 'var(--text-secondary)', borderRadius: 5, padding: 10, cursor: dirty ? 'pointer' : 'default', border: 'none', opacity: dirty ? 1 : 0.5 }}
          >
            {saving ? 'Guardando…' : 'Guardar pantallas'}
          </button>
        </>
      )}
    </div>
  )
}

// ─── Página ──────────────────────────────────────────────────

type Panel =
  | { type: 'new' }
  | { type: 'edit'; userId: string }
  | { type: 'role'; roleId: string }

type Tab = 'users' | 'roles'

export function UsersPage() {
  const { user: authUser, hasPermission } = useAuth()
  const canManage = hasPermission('users.manage')

  const [tab, setTab] = useState<Tab>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [roles, setRoles] = useState<AdminRole[]>([])
  const [permissions, setPermissions] = useState<AdminPermission[]>([])
  const [rolePerms, setRolePerms] = useState<Map<string, Set<string>>>(new Map())
  const [loading, setLoading] = useState(true)
  const [panel, setPanel] = useState<Panel | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [u, r, p, rp] = await Promise.all([
        listUsers(), listRoles(), listPermissions(), listRolePermissions(),
      ])
      setUsers(u)
      setRoles(r)
      setPermissions(p)
      setRolePerms(rp)
    } catch {
      toast.error('No se pudieron cargar los usuarios')
    }
    setLoading(false)
  }, [])

  useEffect(() => { if (canManage) load(); else setLoading(false) }, [canManage, load])

  // permission_id → código, para traducir lo que tiene un rol a pantallas.
  const codeById = useMemo(
    () => new Map(permissions.map(p => [p.id, p.code])),
    [permissions]
  )

  /** Pantallas que otorga un conjunto de roles, sin repetir. */
  const screensOfRoles = useCallback((roleIds: string[]): string[] => {
    const codes = new Set<string>()
    for (const rid of roleIds) {
      for (const permId of rolePerms.get(rid) ?? []) {
        const code = codeById.get(permId)
        if (code) codes.add(code)
      }
    }
    return ASSIGNABLE_SCREENS.filter(sc => codes.has(sc.permission)).map(sc => sc.label)
  }, [rolePerms, codeById])

  const screenCountOfRole = useCallback(
    (roleId: string) => screensOfRoles([roleId]).length,
    [screensOfRoles]
  )

  if (!canManage) {
    return (
      <div className="page-inner">
        <div className="page-header">
          <div className="page-header-left">
            <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 26 }}>Usuarios y roles</h1>
          </div>
        </div>
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso a esta sección</div>
          <div className="empty-state-sub">Se requiere el permiso <strong>users.manage</strong>. Pedíselo a un administrador.</div>
        </div>
      </div>
    )
  }

  const selectedUser = panel?.type === 'edit'
    ? users.find(u => u.id === panel.userId) ?? null
    : null
  const selectedRole = panel?.type === 'role'
    ? roles.find(r => r.id === panel.roleId) ?? null
    : null

  const withoutRole = users.filter(u => u.role_ids.length === 0).length

  const switchTab = (next: Tab) => { setTab(next); setPanel(null) }

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 26 }}>Usuarios y roles</h1>
          <div className="page-header-sub">
            {users.length} usuarios · {roles.length} roles disponibles
            {withoutRole > 0 && ` · ${withoutRole} sin rol asignado`}
          </div>
        </div>
        {tab === 'users' && (
          <ClipButton id="btn-new-user" label="+ Nuevo usuario" onClick={() => setPanel({ type: 'new' })}/>
        )}
      </div>

      <div className="filter-pills" style={{ marginBottom: 16 }}>
        <button
          className={`filter-pill${tab === 'users' ? ' active' : ''}`}
          onClick={() => switchTab('users')}
        >
          Usuarios
        </button>
        <button
          className={`filter-pill${tab === 'roles' ? ' active' : ''}`}
          onClick={() => switchTab('roles')}
        >
          Roles y pantallas
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <div style={{ flex: '2 1 560px', minWidth: 480, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {loading ? (
            <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
          ) : tab === 'users' ? (
            users.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-title">Sin usuarios</div>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="corsa-table">
                  <thead>
                    <tr>
                      <th>Usuario</th>
                      <th>Roles</th>
                      <th>Pantallas</th>
                      <th>Estado</th>
                      <th>Último acceso</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr
                        key={u.id}
                        className={panel?.type === 'edit' && panel.userId === u.id ? 'selected' : ''}
                        onClick={() => setPanel({ type: 'edit', userId: u.id })}
                      >
                        <td>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }} className="truncate">
                            {fullName(u)}
                            {u.id === authUser?.id && (
                              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}> · vos</span>
                            )}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }} className="truncate">
                            {u.email}
                          </div>
                        </td>
                        <td><RoleChips names={u.role_names}/></td>
                        <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                          {screensOfRoles(u.role_ids).length} de {ASSIGNABLE_SCREENS.length}
                        </td>
                        <td>
                          <span className={`badge ${u.active ? 'badge-success' : 'badge-neutral'}`}>
                            {u.active ? 'Activo' : 'Inactivo'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                          {relativeDate(u.last_login_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="table-wrap">
              <table className="corsa-table">
                <thead>
                  <tr>
                    <th>Rol</th>
                    <th>Pantallas</th>
                    <th>Usuarios</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map(r => (
                    <tr
                      key={r.id}
                      className={panel?.type === 'role' && panel.roleId === r.id ? 'selected' : ''}
                      onClick={() => setPanel({ type: 'role', roleId: r.id })}
                    >
                      <td>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                          {r.name}
                          {r.id === SUPER_ADMIN_ROLE_ID && (
                            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}> · inmutable</span>
                          )}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }} className="truncate">
                          {r.description ?? ''}
                        </div>
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                        {screenCountOfRole(r.id)} de {ASSIGNABLE_SCREENS.length}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                        {users.filter(u => u.role_ids.includes(r.id)).length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {panel?.type === 'new' && (
          <NewUserPanel
            roles={roles}
            onClose={() => setPanel(null)}
            onCreated={() => { setPanel(null); load() }}
          />
        )}
        {panel?.type === 'edit' && selectedUser && (
          <EditUserPanel
            user={selectedUser}
            roles={roles}
            isSelf={selectedUser.id === authUser?.id}
            screenLabels={screensOfRoles(selectedUser.role_ids)}
            onClose={() => setPanel(null)}
            onChanged={load}
          />
        )}
        {panel?.type === 'role' && selectedRole && (
          <RoleScreensPanel
            role={selectedRole}
            permissions={permissions}
            granted={rolePerms.get(selectedRole.id) ?? NO_PERMISSIONS}
            onClose={() => setPanel(null)}
            onSaved={load}
          />
        )}
      </div>
    </div>
  )
}
