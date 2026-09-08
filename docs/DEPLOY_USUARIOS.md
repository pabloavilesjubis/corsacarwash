# Despliegue — Gestión de usuarios y roles

Dos piezas a desplegar: la **migración SQL** y la **Edge Function**.

---

## 0. Migración `0028_fix_audit_entity_id.sql` — CORRER PRIMERO

Sí, antes que la 0026, aunque el número sea mayor: la 0026 **no puede correr sin
esto**.

`write_audit_log()` (0023) asume que toda tabla auditada tiene columna `id`.
`user_roles` no la tiene — su PK es compuesta `(user_id, role_id)` — así que
`entity_id` quedaba null y violaba el NOT NULL de `audit_logs`. Como el trigger
es `AFTER INSERT OR DELETE`, la excepción abortaba la transacción:

```
ERROR: null value in column "entity_id" of relation "audit_logs"
```

Eso rompía **toda** asignación de roles: el bootstrap de la 0026,
`admin_set_user_roles()` y la Edge Function `admin-create-user`.

Dashboard → SQL Editor → pegar `supabase/migrations/0028_fix_audit_entity_id.sql`
→ Run. Debería devolver `CREATE FUNCTION`.

---

## 1. Migración `0026_user_management.sql`

Otorga Super Admin al usuario fundador y crea los RPC de gestión.

> **No uses `supabase db push`.** Las migraciones 0001–0025 se aplicaron con
> `scripts/run-migrations.cjs`, así que la tabla de historial de migraciones del
> CLI está vacía: un `db push` intentaría reproducir todo desde 0001 y fallaría
> a mitad de camino, dejando el esquema inconsistente.

**Camino correcto** — Supabase Dashboard → SQL Editor → pegar el contenido de
`supabase/migrations/0026_user_management.sql` → Run.

Deberías ver un `NOTICE: Super Admin otorgado al usuario <uuid>`.

Verificá:

```sql
select u.email, r.name
from auth.users u
join public.user_roles ur on ur.user_id = u.id
join public.roles r on r.id = ur.role_id;
```

Recargá la app (F5). Ya deberías poder guardar clientes y ver **Usuarios y roles**
en el menú.

---

## 2. Migración `0027_screen_access.sql`

Agrega el control de acceso **por pantalla** y fija Super Admin a
`pabloavilesjubis@gmail.com`.

Mismo camino: Dashboard → SQL Editor → pegar
`supabase/migrations/0027_screen_access.sql` → Run.

Es idempotente: se puede correr varias veces sin duplicar nada. Ojo con una
consecuencia: al re-correrla **vuelve a sembrar los accesos por defecto**, así
que si le quitaste una pantalla a un rol desde la UI, reaparece. Es la conducta
esperada de una migración de seeds, pero conviene tenerlo presente. Si la cuenta
todavía no existe en `auth.users`, avisa con un `NOTICE` y sigue — creala y
volvé a correr sólo ese bloque.

Deberías ver `NOTICE: Super Admin otorgado a pabloavilesjubis@gmail.com (<uuid>)`.

Verificá qué pantallas quedó viendo cada rol:

```sql
select r.name as rol, count(*) filter (where p.module = 'screens') as pantallas
from public.roles r
left join public.role_permissions rp on rp.role_id = r.id
left join public.permissions p on p.id = rp.permission_id
group by r.name
order by pantallas desc;
```

> **Importante:** las migraciones 0001–0025 se aplicaron con el script, y 0005
> otorgó "todos los permisos" a Super Admin y Administrador con un `cross join`
> que **ya corrió**. Cualquier permiso nuevo que agregues después necesita su
> propio `insert` explícito — no se hereda solo. 0027 ya lo hace para los
> permisos de pantalla.

---

## 3. Edge Function `admin-create-user`

Crear usuarios en `auth.users` requiere la `service_role` key, que **nunca** puede
estar en el frontend. Por eso vive del lado del servidor.

```bash
# 1. Autenticar el CLI (abre el navegador)
supabase login

# 2. Vincular el proyecto
supabase link --project-ref zvbpkfuehnmqlqimyxcs

# 3. Desplegar
supabase functions deploy admin-create-user
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta
Supabase automáticamente en el entorno de la función — no hay que configurarlas.

Verificá en Dashboard → Edge Functions que aparezca como `ACTIVE`.

---

## Sin desplegar la función

Las migraciones solas ya te dan: el Super Admin, la pantalla de **Usuarios y roles**,
y la asignación de roles a usuarios que ya existen. Lo único que falla es el
botón **+ Nuevo usuario** (devuelve error de red, la app muestra un toast).

Mientras tanto podés crear usuarios desde Dashboard → Authentication → Add user,
y después asignarles el rol desde la pantalla de Usuarios y roles.

---

## Orden de arranque recomendado

1. Correr `0028_fix_audit_entity_id.sql` — **primero**, o la 0026 falla.
2. Correr `0026_user_management.sql`.
3. Correr `0027_screen_access.sql`.
4. Recargar la app (F5). Confirmar que te ves como **Super Admin** y que el
   sidebar muestra todas las pantallas.
5. Desplegar la Edge Function.
6. Crear un usuario de prueba con rol **Caja** y verificar que entra, ve sólo
   Caja / Órdenes / Clientes / Membresías y Resumen, y que escribir
   `/receivables` a mano le muestra "No tenés acceso a esta sección".
