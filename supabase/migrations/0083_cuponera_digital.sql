-- ============================================================
-- Migration: 0083_cuponera_digital.sql
-- Description: Cuponera Digital — portal para que un cliente que compró
--              cupones (300, 500, 1000…) los entregue él mismo, por correo
--              o en PDF, sin pasar por CORSA para cada uno.
--
--   EL FLUJO
--   1. CORSA habilita la cuponera de un cliente (pantalla Cuponera digital).
--   2. En el POS Administrativo se facturan los cupones como siempre
--      (sell_service_vouchers, FCF o CCF). Si el cliente tiene cuponera, el
--      lote se carga a ella (voucher_batches.cuponera). Un lote viejo se
--      puede cargar después desde la misma pantalla.
--   3. CORSA crea los usuarios del cliente (/api/cuponera, service role).
--   4. El usuario entra a /cuponera con su propio login, ve comprados,
--      entregados, pendientes y redimidos, y entrega cupones: cada entrega
--      queda a nombre de una persona, con su correo, y sale en PDF, por
--      correo (el mismo SMTP de CORSA, /api/correo) o las dos cosas.
--   5. El canje no cambia: el cupón entregado es el mismo de siempre (código
--      de 6 dígitos y QR) y se canjea en caja con redeem_service_voucher.
--
--   SEGURIDAD — el usuario de la cuponera NO es personal de CORSA
--   · No tiene fila en profiles: handle_new_user() lo salta (app_metadata
--     .portal = 'cuponera', que sólo escribe el service role). Sin profile,
--     get_my_organization_id() le da null y has_permission() false: ninguna
--     política interna lo deja pasar.
--   · Pero hay vistas que corren como su dueño y no filtran por organización
--     (ventas, lavados, PLC — ver 0073). Por eso el guardián de abajo
--     (pgrst.db_pre_request) corta CUALQUIER pedido a la API de un usuario de
--     la cuponera que no sea una RPC cuponera_portal_*. Es una sola puerta,
--     antes de tocar cualquier tabla o vista: una vista nueva que se olvide de
--     filtrar no le abre nada.
--   · Las RPC del portal toman el cliente de la sesión (cuponera_contexto),
--     nunca de un parámetro: no hay forma de pedir los cupones de otro.
--   · Las tablas no tienen política de escritura: todo pasa por RPC.
-- ============================================================


-- ─────────────────────────────────────────────
-- 1. LOTES: más grandes, y la marca de cuponera
-- ─────────────────────────────────────────────
-- El tope de 500 era para el PDF de mostrador. Un cliente de cuponera compra
-- 300, 500 o 1000 de una vez y los entrega de a uno: no imprime el lote.
alter table public.voucher_batches drop constraint if exists voucher_batches_quantity_check;
alter table public.voucher_batches
  add constraint voucher_batches_quantity_check check (quantity between 1 and 2000);

alter table public.voucher_batches
  add column if not exists cuponera    boolean     not null default false,
  add column if not exists cuponera_at timestamptz;

comment on column public.voucher_batches.cuponera is
  'El lote está cargado a la Cuponera Digital del cliente (0083): el cliente lo ve y entrega sus cupones desde /cuponera.';


-- ─────────────────────────────────────────────
-- 2. TABLAS
-- ─────────────────────────────────────────────

-- Clientes con cuponera. `activa = false` suspende el portal sin perder nada.
create table if not exists public.cuponera_clientes (
  customer_id     uuid        primary key references public.customers(id) on delete cascade,
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  activa          boolean     not null default true,
  created_by      uuid        references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.cuponera_clientes is
  'Clientes con Cuponera Digital habilitada (0083).';

-- Usuarios externos: uno por persona del cliente. El user_id es de
-- auth.users, pero sin profile ni roles (ver encabezado).
create table if not exists public.cuponera_usuarios (
  user_id            uuid        primary key references auth.users(id) on delete cascade,
  organization_id    uuid        not null references public.organizations(id) on delete cascade,
  customer_id        uuid        not null references public.cuponera_clientes(customer_id) on delete cascade,
  nombre             text        not null check (length(trim(nombre)) between 1 and 120),
  correo             text        not null,
  activo             boolean     not null default true,
  -- La contraseña la pone CORSA al crear o restablecer: el portal obliga a
  -- cambiarla en el primer ingreso.
  debe_cambiar_clave boolean     not null default true,
  ultimo_ingreso     timestamptz,
  created_by         uuid        references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);

create unique index if not exists cuponera_usuarios_correo_unique on public.cuponera_usuarios (lower(correo));
create index if not exists idx_cuponera_usuarios_cliente on public.cuponera_usuarios (customer_id);

comment on table public.cuponera_usuarios is
  'Usuarios externos de la Cuponera Digital (0083). Sin profile: no son personal de CORSA.';

-- Una entrega: N cupones a una persona.
create table if not exists public.cuponera_entregas (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  customer_id         uuid        not null references public.cuponera_clientes(customer_id) on delete cascade,
  destinatario_nombre text        not null check (length(trim(destinatario_nombre)) between 1 and 120),
  destinatario_correo text        check (destinatario_correo is null
                                         or destinatario_correo ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  nota                text        check (nota is null or length(nota) <= 300),
  cantidad            int         not null check (cantidad between 1 and 100),
  entregado_por       uuid        references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists idx_cuponera_entregas_cliente on public.cuponera_entregas (customer_id, created_at desc);

comment on table public.cuponera_entregas is
  'Cada entrega de cupones que hizo un cliente desde la Cuponera Digital (0083).';

-- Qué cupones van en cada entrega. La PK en voucher_id es la garantía de que
-- un cupón no se entrega dos veces, aunque dos usuarios entreguen a la vez.
create table if not exists public.cuponera_entrega_cupones (
  voucher_id uuid primary key references public.service_vouchers(id) on delete restrict,
  entrega_id uuid not null references public.cuponera_entregas(id) on delete cascade
);

create index if not exists idx_cuponera_entrega_cupones_entrega on public.cuponera_entrega_cupones (entrega_id);


-- ─────────────────────────────────────────────
-- 3. RLS — lectura interna; el portal sólo por RPC
-- ─────────────────────────────────────────────
alter table public.cuponera_clientes        enable row level security;
alter table public.cuponera_usuarios        enable row level security;
alter table public.cuponera_entregas        enable row level security;
alter table public.cuponera_entrega_cupones enable row level security;

revoke all on public.cuponera_clientes, public.cuponera_usuarios,
              public.cuponera_entregas, public.cuponera_entrega_cupones
  from anon, authenticated;
grant select on public.cuponera_clientes, public.cuponera_usuarios,
                public.cuponera_entregas, public.cuponera_entrega_cupones
  to authenticated;

-- El POS Administrativo lee si el cliente tiene cuponera para ofrecer cargarle
-- el lote: por eso vouchers.sell además de cuponera.manage.
drop policy if exists "cuponera_clientes_select" on public.cuponera_clientes;
create policy "cuponera_clientes_select" on public.cuponera_clientes for select
  using (organization_id = public.get_my_organization_id()
         and (public.has_permission('cuponera.manage') or public.has_permission('vouchers.sell')));

drop policy if exists "cuponera_usuarios_select" on public.cuponera_usuarios;
create policy "cuponera_usuarios_select" on public.cuponera_usuarios for select
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('cuponera.manage'));

-- Cupones (vouchers.read) muestra a quién se entregó cada cupón.
drop policy if exists "cuponera_entregas_select" on public.cuponera_entregas;
create policy "cuponera_entregas_select" on public.cuponera_entregas for select
  using (organization_id = public.get_my_organization_id()
         and (public.has_permission('cuponera.manage') or public.has_permission('vouchers.read')));

drop policy if exists "cuponera_entrega_cupones_select" on public.cuponera_entrega_cupones;
create policy "cuponera_entrega_cupones_select" on public.cuponera_entrega_cupones for select
  using (exists (select 1 from public.cuponera_entregas e where e.id = entrega_id));


-- ─────────────────────────────────────────────
-- 4. EL USUARIO DE LA CUPONERA NO RECIBE PROFILE
--    Copia de handle_new_user (0004) con la salida al principio.
-- ─────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  -- Usuario externo de la Cuponera Digital (0083). Sin profile no tiene
  -- organización, y sin organización ninguna política interna lo deja pasar.
  -- app_metadata sólo lo escribe el service role: un usuario no se lo puede
  -- poner a sí mismo.
  if coalesce(new.raw_app_meta_data->>'portal', '') = 'cuponera' then
    return new;
  end if;

  -- Extract organization_id from user metadata (set during admin invite)
  v_org_id := (new.raw_user_meta_data->>'organization_id')::uuid;

  -- Default to CORSA if not provided (development convenience)
  if v_org_id is null then
    v_org_id := '00000000-0000-0000-0000-000000000001';
  end if;

  insert into public.profiles (
    id,
    organization_id,
    first_name,
    last_name,
    display_name,
    phone
  ) values (
    new.id,
    v_org_id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    new.raw_user_meta_data->>'phone'
  );

  return new;
end;
$$;


-- ─────────────────────────────────────────────
-- 5. EL GUARDIÁN DE LA API
--
--    PostgREST corre esta función antes de cada pedido. Para el personal de
--    CORSA y para anon no hace nada (una lectura por PK). Para un usuario de
--    la cuponera deja pasar sólo /rpc/cuponera_portal_*: ni tablas, ni
--    vistas, ni otras RPC, ni GraphQL (que también es una RPC).
--
--    Se reconoce por las dos señales, por si una faltara: el claim
--    app_metadata.portal del JWT y la fila en cuponera_usuarios.
-- ─────────────────────────────────────────────
create or replace function public.corsa_pre_request()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_claims jsonb;
  v_path   text;
begin
  if v_uid is null then
    return;
  end if;

  v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;

  if coalesce(v_claims->'app_metadata'->>'portal', '') <> 'cuponera'
     and not exists (select 1 from public.cuponera_usuarios where user_id = v_uid) then
    return;
  end if;

  v_path := coalesce(current_setting('request.path', true), '');
  if v_path ~ '/rpc/cuponera_portal_[a-z_]+/?$' then
    return;
  end if;

  raise exception 'La Cuponera Digital no tiene acceso a este recurso'
    using errcode = '42501';
end;
$$;

comment on function public.corsa_pre_request() is
  'pgrst.db_pre_request (0083): a un usuario de la Cuponera Digital sólo le deja llamar las RPC cuponera_portal_*.';

grant execute on function public.corsa_pre_request() to anon, authenticated;

alter role authenticator set pgrst.db_pre_request = 'public.corsa_pre_request';
notify pgrst, 'reload config';


-- ─────────────────────────────────────────────
-- 6. CORREOS: la entrega de cupones y el acceso al portal
-- ─────────────────────────────────────────────
alter table public.envios_correo
  add column if not exists cuponera_entrega_id uuid references public.cuponera_entregas(id) on delete set null;

alter table public.envios_correo drop constraint if exists envios_correo_tipo_check;
alter table public.envios_correo
  add constraint envios_correo_tipo_check
  check (tipo in ('dte', 'lavado_credito', 'ccf_consolidado', 'estado_cuenta', 'cierre_caja',
                  'cupones', 'cuponera_acceso'));

create index if not exists idx_envios_correo_cuponera
  on public.envios_correo (cuponera_entrega_id, created_at desc);
-- Para el tope diario de correos por usuario (lo aplica /api/correo).
create index if not exists idx_envios_correo_autor
  on public.envios_correo (created_by, tipo, created_at desc);


-- ─────────────────────────────────────────────
-- 7. FUNCIONES INTERNAS (no se exponen)
-- ─────────────────────────────────────────────

create or replace function public.cuponera_nombre_cliente(p_customer_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    case when c.customer_type = 'company'
         then coalesce(c.legal_name, c.trade_name)
         else nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')
    end, 'Cliente')
  from public.customers c where c.id = p_customer_id;
$$;

-- El cliente de la sesión. Si el usuario o la cuponera están suspendidos,
-- corta acá: todas las RPC del portal pasan por esta función.
create or replace function public.cuponera_contexto(
  out o_customer_id uuid,
  out o_org_id      uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  select u.customer_id, u.organization_id
    into o_customer_id, o_org_id
    from public.cuponera_usuarios u
    join public.cuponera_clientes c on c.customer_id = u.customer_id
   where u.user_id = auth.uid()
     and u.activo
     and c.activa;

  if o_customer_id is null then
    raise exception 'Tu usuario no tiene acceso a la Cuponera Digital' using errcode = '42501';
  end if;
end;
$$;

-- Todos los cupones de la cuponera de un cliente, con su estado de entrega.
-- `estado` es el de la cuponera: pendiente (sin entregar y vigente),
-- entregado, redimido o anulado. Un cupón entregado y después canjeado dice
-- redimido, y conserva a quién se entregó.
create or replace function public.cuponera_cupones_de(p_customer_id uuid, p_org_id uuid)
returns table (
  id                uuid,
  code              text,
  sequence_number   int,
  validation_token  uuid,
  status            text,
  estado            text,
  service_code      text,
  service_name      text,
  size              text,
  includes_aspirado boolean,
  is_gift           boolean,
  unit_value        numeric,
  created_at        timestamptz,
  redeemed_at       timestamptz,
  batch_id          uuid,
  batch_quantity    int,
  customer_name     text,
  entrega_id        uuid,
  entregado_a       text,
  entregado_correo  text,
  entregado_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sv.id, sv.code, sv.sequence_number, sv.validation_token, sv.status,
    case
      when sv.status = 'void'     then 'anulado'
      when sv.status = 'redeemed' then 'redimido'
      when e.id is not null       then 'entregado'
      else 'pendiente'
    end,
    sv.service_code, sv.service_name, sv.size, sv.includes_aspirado, sv.is_gift, sv.unit_value,
    sv.created_at, sv.redeemed_at,
    vb.id, vb.quantity,
    public.cuponera_nombre_cliente(vb.customer_id),
    e.id, e.destinatario_nombre, e.destinatario_correo, e.created_at
  from public.service_vouchers sv
  join public.voucher_batches vb on vb.id = sv.batch_id
  left join public.cuponera_entrega_cupones ec on ec.voucher_id = sv.id
  left join public.cuponera_entregas e on e.id = ec.entrega_id
  where vb.customer_id = p_customer_id
    and vb.organization_id = p_org_id
    and vb.cuponera
    and not vb.is_gift;
$$;

create or replace function public.cuponera_totales_de(p_customer_id uuid, p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'comprados',  count(*) filter (where estado <> 'anulado'),
    'entregados', count(*) filter (where entrega_id is not null and estado <> 'anulado'),
    'pendientes', count(*) filter (where estado = 'pendiente'),
    'redimidos',  count(*) filter (where estado = 'redimido'),
    'anulados',   count(*) filter (where estado = 'anulado')
  )
  from public.cuponera_cupones_de(p_customer_id, p_org_id);
$$;

create or replace function public.cuponera_entregas_de(p_customer_id uuid, p_org_id uuid, p_limite int)
returns table (
  id                  uuid,
  destinatario_nombre text,
  destinatario_correo text,
  nota                text,
  cantidad            int,
  created_at          timestamptz,
  entregado_por       text,
  codigos             text[],
  servicios           text,
  redimidos           int,
  correo_estado       text,
  correo_at           timestamptz,
  correo_error        text,
  correos_enviados    int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id, e.destinatario_nombre, e.destinatario_correo, e.nota, e.cantidad, e.created_at,
    coalesce(u.nombre, 'CORSA Carwash'),
    (select array_agg(sv.code order by sv.sequence_number)
       from public.cuponera_entrega_cupones ec
       join public.service_vouchers sv on sv.id = ec.voucher_id
      where ec.entrega_id = e.id),
    (select string_agg(distinct trim(sv.service_name || ' ' || coalesce(sv.size, '')
                                     || case when sv.includes_aspirado then ' + aspirado' else '' end), ', ')
       from public.cuponera_entrega_cupones ec
       join public.service_vouchers sv on sv.id = ec.voucher_id
      where ec.entrega_id = e.id),
    (select count(*)::int
       from public.cuponera_entrega_cupones ec
       join public.service_vouchers sv on sv.id = ec.voucher_id
      where ec.entrega_id = e.id and sv.status = 'redeemed'),
    ce.status, ce.created_at, ce.error,
    (select count(*)::int from public.envios_correo x
      where x.cuponera_entrega_id = e.id and x.status = 'sent')
  from public.cuponera_entregas e
  left join public.cuponera_usuarios u on u.user_id = e.entregado_por
  left join lateral (
    select x.status, x.created_at, x.error
      from public.envios_correo x
     where x.cuponera_entrega_id = e.id
     order by x.created_at desc limit 1
  ) ce on true
  where e.customer_id = p_customer_id
    and e.organization_id = p_org_id
  order by e.created_at desc
  limit greatest(1, least(coalesce(p_limite, 200), 1000));
$$;


-- Las funciones internas quedan cerradas: las llaman las RPC de abajo, que
-- son security definer y corren como su dueño.
revoke all on function public.cuponera_nombre_cliente(uuid)            from public, anon, authenticated;
revoke all on function public.cuponera_contexto()                      from public, anon, authenticated;
revoke all on function public.cuponera_cupones_de(uuid, uuid)          from public, anon, authenticated;
revoke all on function public.cuponera_totales_de(uuid, uuid)          from public, anon, authenticated;
revoke all on function public.cuponera_entregas_de(uuid, uuid, int)    from public, anon, authenticated;


-- ─────────────────────────────────────────────
-- 8. RPC DEL PORTAL (cuponera_portal_*)
--    Las únicas que el guardián deja llamar a un usuario de la cuponera.
-- ─────────────────────────────────────────────

-- Lo que el portal muestra al entrar. Anota el último ingreso.
create or replace function public.cuponera_portal_resumen()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  ctx record;
  u   public.cuponera_usuarios%rowtype;
begin
  select * into ctx from public.cuponera_contexto();
  select * into u from public.cuponera_usuarios where user_id = auth.uid();

  update public.cuponera_usuarios set ultimo_ingreso = now()
   where user_id = auth.uid()
     and (ultimo_ingreso is null or ultimo_ingreso < now() - interval '5 minutes');

  return jsonb_build_object(
    'usuario', jsonb_build_object(
      'nombre', u.nombre, 'correo', u.correo, 'debe_cambiar_clave', u.debe_cambiar_clave),
    'cliente', jsonb_build_object(
      'nombre', public.cuponera_nombre_cliente(ctx.o_customer_id)),
    'totales', public.cuponera_totales_de(ctx.o_customer_id, ctx.o_org_id),
    -- Lo que queda por entregar, por tipo de cupón: es lo que se elige al entregar.
    'tipos', coalesce((
      select jsonb_agg(t order by t->>'service_name', t->>'size')
        from (
          select jsonb_build_object(
                   'service_code', service_code, 'service_name', service_name,
                   'size', size, 'includes_aspirado', includes_aspirado,
                   'comprados', count(*) filter (where estado <> 'anulado'),
                   'pendientes', count(*) filter (where estado = 'pendiente')) as t
            from public.cuponera_cupones_de(ctx.o_customer_id, ctx.o_org_id)
           group by service_code, service_name, size, includes_aspirado
        ) x
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.cuponera_portal_cupones(
  p_estado text default null,     -- pendiente | entregado | redimido | anulado | null = todos
  p_buscar text default null
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ctx    record;
  v_term text := nullif(trim(coalesce(p_buscar, '')), '');
begin
  select * into ctx from public.cuponera_contexto();

  return query
  select to_jsonb(c)
    from public.cuponera_cupones_de(ctx.o_customer_id, ctx.o_org_id) c
   where (p_estado is null or c.estado = p_estado
          -- «Entregados» incluye los que ya se canjearon después de entregarse.
          or (p_estado = 'entregado' and c.entrega_id is not null and c.estado <> 'anulado'))
     and (v_term is null
          or c.code like '%' || v_term || '%'
          or c.entregado_a ilike '%' || v_term || '%'
          or c.entregado_correo ilike '%' || v_term || '%')
   order by c.sequence_number;
end;
$$;

-- Los cupones de una entrega, para reimprimir su PDF.
create or replace function public.cuponera_portal_cupones_entrega(p_entrega_id uuid)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ctx record;
begin
  select * into ctx from public.cuponera_contexto();

  return query
  select to_jsonb(c)
    from public.cuponera_cupones_de(ctx.o_customer_id, ctx.o_org_id) c
   where c.entrega_id = p_entrega_id
   order by c.sequence_number;
end;
$$;

create or replace function public.cuponera_portal_entregas(p_limite int default 200)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ctx record;
begin
  select * into ctx from public.cuponera_contexto();
  return query
  select to_jsonb(e) from public.cuponera_entregas_de(ctx.o_customer_id, ctx.o_org_id, p_limite) e;
end;
$$;

-- Entregar: toma los N primeros pendientes del tipo elegido (por correlativo)
-- y los deja a nombre del destinatario. FOR UPDATE SKIP LOCKED + la PK de
-- cuponera_entrega_cupones: dos usuarios entregando a la vez no se pisan.
create or replace function public.cuponera_portal_entregar(
  p_destinatario_nombre text,
  p_destinatario_correo text,
  p_cantidad            int,
  p_service_code        text,
  p_size                text,
  p_includes_aspirado   boolean,
  p_nota                text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  ctx        record;
  v_nombre   text := trim(coalesce(p_destinatario_nombre, ''));
  v_correo   text := nullif(lower(trim(coalesce(p_destinatario_correo, ''))), '');
  v_nota     text := nullif(trim(coalesce(p_nota, '')), '');
  v_ids      uuid[];
  v_entrega  uuid;
  v_quedan   int;
begin
  select * into ctx from public.cuponera_contexto();

  if length(v_nombre) = 0 then
    raise exception 'Escribe el nombre de la persona que recibe los cupones' using errcode = '22023';
  end if;
  if length(v_nombre) > 120 then
    raise exception 'El nombre es demasiado largo' using errcode = '22023';
  end if;
  if v_correo is not null and v_correo !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'El correo % no es válido', v_correo using errcode = '22023';
  end if;
  if v_nota is not null and length(v_nota) > 300 then
    raise exception 'La nota admite hasta 300 caracteres' using errcode = '22023';
  end if;
  if p_cantidad is null or p_cantidad < 1 or p_cantidad > 100 then
    raise exception 'Se entregan de 1 a 100 cupones por vez' using errcode = '22023';
  end if;

  select array_agg(x.id order by x.sequence_number) into v_ids
  from (
    select sv.id, sv.sequence_number
      from public.service_vouchers sv
      join public.voucher_batches vb on vb.id = sv.batch_id
     where vb.customer_id = ctx.o_customer_id
       and vb.organization_id = ctx.o_org_id
       and vb.cuponera
       and not vb.is_gift
       and sv.status = 'active'
       and sv.service_code = p_service_code
       and sv.size is not distinct from p_size
       and sv.includes_aspirado = coalesce(p_includes_aspirado, false)
       and not exists (select 1 from public.cuponera_entrega_cupones ec where ec.voucher_id = sv.id)
     order by sv.sequence_number
     limit p_cantidad
       for update of sv skip locked
  ) x;

  v_quedan := coalesce(array_length(v_ids, 1), 0);
  if v_quedan < p_cantidad then
    raise exception '%', case when v_quedan = 0
        then 'No quedan cupones pendientes de ese tipo'
        else format('Sólo quedan %s cupones pendientes de ese tipo', v_quedan) end
      using errcode = 'P0001';
  end if;

  insert into public.cuponera_entregas (
    organization_id, customer_id, destinatario_nombre, destinatario_correo, nota, cantidad, entregado_por
  ) values (
    ctx.o_org_id, ctx.o_customer_id, v_nombre, v_correo, v_nota, p_cantidad, auth.uid()
  )
  returning id into v_entrega;

  insert into public.cuponera_entrega_cupones (voucher_id, entrega_id)
  select unnest(v_ids), v_entrega;

  return jsonb_build_object(
    'entrega_id', v_entrega,
    'cupones', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.sequence_number), '[]'::jsonb)
        from public.cuponera_cupones_de(ctx.o_customer_id, ctx.o_org_id) c
       where c.entrega_id = v_entrega)
  );
end;
$$;

-- El portal llama a esto después de supabase.auth.updateUser({ password }).
create or replace function public.cuponera_portal_clave_cambiada()
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.cuponera_contexto();
  update public.cuponera_usuarios set debe_cambiar_clave = false where user_id = auth.uid();
end;
$$;

revoke all on function public.cuponera_portal_resumen()                   from public, anon;
revoke all on function public.cuponera_portal_cupones(text, text)         from public, anon;
revoke all on function public.cuponera_portal_cupones_entrega(uuid)       from public, anon;
revoke all on function public.cuponera_portal_entregas(int)               from public, anon;
revoke all on function public.cuponera_portal_entregar(text, text, int, text, text, boolean, text) from public, anon;
revoke all on function public.cuponera_portal_clave_cambiada()            from public, anon;
grant execute on function public.cuponera_portal_resumen()                to authenticated;
grant execute on function public.cuponera_portal_cupones(text, text)      to authenticated;
grant execute on function public.cuponera_portal_cupones_entrega(uuid)    to authenticated;
grant execute on function public.cuponera_portal_entregas(int)            to authenticated;
grant execute on function public.cuponera_portal_entregar(text, text, int, text, text, boolean, text) to authenticated;
grant execute on function public.cuponera_portal_clave_cambiada()         to authenticated;


-- ─────────────────────────────────────────────
-- 9. RPC INTERNAS (pantalla Cuponera digital y POS Administrativo)
-- ─────────────────────────────────────────────

create or replace function public.cuponera_admin_clientes()
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.get_my_organization_id();
begin
  if not public.has_permission('cuponera.manage') then
    raise exception 'No autorizado: se requiere cuponera.manage' using errcode = '42501';
  end if;

  return query
  select jsonb_build_object(
    'customer_id', cc.customer_id,
    'nombre',      public.cuponera_nombre_cliente(cc.customer_id),
    'nit',         c.nit,
    'correo',      coalesce(nullif(c.billing_email, ''), c.email),
    'activa',      cc.activa,
    'created_at',  cc.created_at,
    'usuarios',          (select count(*) from public.cuponera_usuarios u where u.customer_id = cc.customer_id),
    'usuarios_activos',  (select count(*) from public.cuponera_usuarios u where u.customer_id = cc.customer_id and u.activo),
    'totales',     public.cuponera_totales_de(cc.customer_id, v_org)
  )
  from public.cuponera_clientes cc
  join public.customers c on c.id = cc.customer_id
  where cc.organization_id = v_org
  order by public.cuponera_nombre_cliente(cc.customer_id);
end;
$$;

-- Habilita (o suspende) la cuponera de un cliente.
create or replace function public.cuponera_admin_habilitar(p_customer_id uuid, p_activa boolean default true)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org uuid := public.get_my_organization_id();
begin
  if not public.has_permission('cuponera.manage') then
    raise exception 'No autorizado: se requiere cuponera.manage' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and organization_id = v_org) then
    raise exception 'Cliente no encontrado' using errcode = '22023';
  end if;

  insert into public.cuponera_clientes (customer_id, organization_id, activa, created_by)
  values (p_customer_id, v_org, coalesce(p_activa, true), auth.uid())
  on conflict (customer_id) do update
    set activa = excluded.activa, updated_at = now();
end;
$$;

-- Los lotes vendidos al cliente, cargados o no a la cuponera.
create or replace function public.cuponera_admin_lotes(p_customer_id uuid)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.get_my_organization_id();
begin
  if not public.has_permission('cuponera.manage') then
    raise exception 'No autorizado: se requiere cuponera.manage' using errcode = '42501';
  end if;

  return query
  select jsonb_build_object(
    'batch_id',          vb.id,
    'created_at',        vb.created_at,
    'quantity',          vb.quantity,
    'service_name',      vb.service_name,
    'size',              vb.size,
    'includes_aspirado', vb.includes_aspirado,
    'unit_total',        vb.unit_total,
    'total',             vb.total,
    'cuponera',          vb.cuponera,
    'order_number',      wo.order_number,
    'anulado',           wo.status = 'cancelled',
    'activos',    (select count(*) from public.service_vouchers sv where sv.batch_id = vb.id and sv.status = 'active'),
    'redimidos',  (select count(*) from public.service_vouchers sv where sv.batch_id = vb.id and sv.status = 'redeemed'),
    'entregados', (select count(*) from public.service_vouchers sv
                     join public.cuponera_entrega_cupones ec on ec.voucher_id = sv.id
                    where sv.batch_id = vb.id)
  )
  from public.voucher_batches vb
  left join public.work_orders wo on wo.id = vb.work_order_id
  where vb.customer_id = p_customer_id
    and vb.organization_id = v_org
    and not vb.is_gift
  order by vb.created_at desc;
end;
$$;

-- Carga (o quita) un lote de la cuponera. La usa el POS Administrativo justo
-- después de vender, y la pantalla Cuponera digital para lotes anteriores.
create or replace function public.cuponera_cargar_lote(p_batch_id uuid, p_cuponera boolean default true)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org uuid := public.get_my_organization_id();
  vb    public.voucher_batches%rowtype;
begin
  if not (public.has_permission('cuponera.manage') or public.has_permission('vouchers.sell')) then
    raise exception 'No autorizado: se requiere cuponera.manage o vouchers.sell' using errcode = '42501';
  end if;

  select * into vb from public.voucher_batches where id = p_batch_id and organization_id = v_org for update;
  if vb.id is null then
    raise exception 'Lote no encontrado' using errcode = '22023';
  end if;
  if vb.is_gift or vb.customer_id is null then
    raise exception 'Una regalía no tiene cliente: no va a ninguna cuponera' using errcode = '22023';
  end if;

  if coalesce(p_cuponera, true) then
    if not exists (select 1 from public.cuponera_clientes
                    where customer_id = vb.customer_id and activa) then
      raise exception 'El cliente no tiene la Cuponera Digital habilitada' using errcode = '22023';
    end if;
  else
    -- Quitar un lote con cupones ya entregados dejaría entregas apuntando a
    -- cupones que el cliente no ve.
    if exists (select 1 from public.service_vouchers sv
                 join public.cuponera_entrega_cupones ec on ec.voucher_id = sv.id
                where sv.batch_id = vb.id) then
      raise exception 'El lote ya tiene cupones entregados desde la cuponera: no se puede quitar'
        using errcode = 'P0001';
    end if;
  end if;

  update public.voucher_batches
     set cuponera = coalesce(p_cuponera, true),
         cuponera_at = case when coalesce(p_cuponera, true) then now() else null end
   where id = vb.id;
end;
$$;

create or replace function public.cuponera_admin_entregas(p_customer_id uuid, p_limite int default 200)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission('cuponera.manage') then
    raise exception 'No autorizado: se requiere cuponera.manage' using errcode = '42501';
  end if;
  return query
  select to_jsonb(e)
    from public.cuponera_entregas_de(p_customer_id, public.get_my_organization_id(), p_limite) e;
end;
$$;

revoke all on function public.cuponera_admin_clientes()                from public, anon;
revoke all on function public.cuponera_admin_habilitar(uuid, boolean)  from public, anon;
revoke all on function public.cuponera_admin_lotes(uuid)               from public, anon;
revoke all on function public.cuponera_cargar_lote(uuid, boolean)      from public, anon;
revoke all on function public.cuponera_admin_entregas(uuid, int)       from public, anon;
grant execute on function public.cuponera_admin_clientes()               to authenticated;
grant execute on function public.cuponera_admin_habilitar(uuid, boolean) to authenticated;
grant execute on function public.cuponera_admin_lotes(uuid)              to authenticated;
grant execute on function public.cuponera_cargar_lote(uuid, boolean)     to authenticated;
grant execute on function public.cuponera_admin_entregas(uuid, int)      to authenticated;


-- ─────────────────────────────────────────────
-- 10. CUPONES: a quién se entregó cada uno
--     Columnas nuevas al final (create or replace view no admite otra cosa).
-- ─────────────────────────────────────────────
create or replace view public.v_vouchers
with (security_invoker = true)
as
select
  sv.id,
  sv.organization_id,
  sv.code,
  sv.sequence_number,
  sv.validation_token,
  sv.status,
  sv.service_code,
  sv.service_name,
  sv.size,
  sv.includes_aspirado,
  sv.is_gift,
  sv.unit_value,
  sv.created_at,
  (sv.created_at at time zone 'America/El_Salvador')::date as sold_date,
  sv.redeemed_at,
  (sv.redeemed_at at time zone 'America/El_Salvador')::date as redeemed_date,
  vb.id            as batch_id,
  vb.quantity      as batch_quantity,
  vb.customer_id,
  coalesce(
    case when c.customer_type = 'company'
         then coalesce(c.legal_name, c.trade_name)
         else nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), '')
    end, 'Cliente General')  as customer_name,
  wo.order_number            as redeemed_order_number,
  vb.cuponera                as en_cuponera,
  ce.destinatario_nombre     as entregado_a,
  ce.destinatario_correo     as entregado_correo,
  ce.created_at              as entregado_at
from public.service_vouchers sv
join public.voucher_batches vb on vb.id = sv.batch_id
left join public.customers c on c.id = vb.customer_id
left join public.work_orders wo on wo.id = sv.redeemed_work_order_id
left join public.cuponera_entrega_cupones cec on cec.voucher_id = sv.id
left join public.cuponera_entregas ce on ce.id = cec.entrega_id;

revoke all on public.v_vouchers from anon;
revoke insert, update, delete, truncate, references, trigger on public.v_vouchers from authenticated;
grant select on public.v_vouchers to authenticated;


-- ─────────────────────────────────────────────
-- 11. PERMISOS Y PANTALLA
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description) values
  ('cuponera.manage',  'cuponera', 'Administrar la Cuponera Digital: clientes, usuarios y lotes'),
  ('screens.cuponera', 'screens',  'Pantalla: Cuponera digital')
on conflict (code) do nothing;

-- Super Admin, Administrador y Gerente: los mismos que venden cupones.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000001',
               '00000000-0000-0000-0002-000000000002',
               '00000000-0000-0000-0002-000000000003')
  and p.code in ('cuponera.manage', 'screens.cuponera')
on conflict do nothing;
