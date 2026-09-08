# Despliegue — Gestión de usuarios y roles

Dos piezas a desplegar: la **migración SQL** y la **Edge Function**.

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

## 2. Edge Function `admin-create-user`

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

La migración sola ya te da: el Super Admin, la pantalla de **Usuarios y roles**,
y la asignación de roles a usuarios que ya existen. Lo único que falla es el
botón **+ Nuevo usuario** (devuelve error de red, la app muestra un toast).

Mientras tanto podés crear usuarios desde Dashboard → Authentication → Add user,
y después asignarles el rol desde la pantalla de Usuarios y roles.

---

## Orden de arranque recomendado

1. Correr la migración.
2. Recargar la app, entrar a **Usuarios y roles**, confirmar que te ves como
   Super Admin.
3. Desplegar la Edge Function.
4. Crear el primer usuario de prueba con rol **Caja** y verificar que puede
   entrar pero no ve Administración.
