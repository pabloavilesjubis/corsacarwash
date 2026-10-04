-- ═══════════════════════════════════════════════════════════════════════
-- 0065 — Cierre de caja y manejo de efectivo
--
-- La caja de cada sucursal abre el día con un efectivo inicial, suma lo que
-- entra en efectivo, resta los retiros y cierra con una remesa:
--
--   efectivo final = inicial + ventas en efectivo − retiros − remesa
--
-- Se apoya en las tablas de 0014 (cash_registers, cash_sessions,
-- cash_movements), que existían pero nadie usaba:
--   · la apertura es un cash_in «Apertura de caja»;
--   · un retiro es un cash_out con motivo, monto, quién lo pidió y quién lo
--     autorizó (alguien con cash.override: gerente o administrador);
--   · la remesa es un 'deposit' al cerrar.
-- Las ventas NO se copian como movimientos: se leen de payments en vivo, por
-- método (efectivo, tarjeta, transferencia). Así un cambio de método de pago
-- o una venta anulada ya se reflejan sin conciliar nada. El efectivo neto de
-- una venta es su total: lo recibido menos el vuelto.
--
-- Al cerrar se guarda la foto del resumen (cash_sessions.resumen): el reporte
-- dice lo que la caja vio al cerrar aunque después se corrija una venta. Y se
-- emite la notificación CASH_CLOSE a los celulares de quienes tienen
-- cash.override, con el enlace al reporte. El PDF por correo lo manda
-- /api/correo (accion 'cierre_caja').
-- ═══════════════════════════════════════════════════════════════════════

-- ── Columnas nuevas ──
alter table public.cash_movements
  add column if not exists authorized_by uuid references public.profiles(id) on delete set null;
comment on column public.cash_movements.authorized_by is
  'Quién autorizó un retiro de efectivo (cash.override). 0065.';

alter table public.cash_sessions
  add column if not exists remesa  numeric(10,2),
  add column if not exists resumen jsonb;
comment on column public.cash_sessions.resumen is
  'Foto del resumen al cerrar: ventas por método, retiros, remesa y efectivo final. 0065.';

-- Una caja por sucursal. La de Escalón ya existía (0014).
insert into public.cash_registers (branch_id, name, code)
select b.id, 'Caja principal ' || b.name, 'CAJA-01'
  from public.branches b
on conflict (branch_id, code) do nothing;

-- El correo del cierre queda registrado como los demás.
alter table public.envios_correo drop constraint if exists envios_correo_tipo_check;
alter table public.envios_correo
  add constraint envios_correo_tipo_check
  check (tipo in ('dte', 'lavado_credito', 'ccf_consolidado', 'estado_cuenta', 'cierre_caja'));
alter table public.envios_correo
  add column if not exists cash_session_id uuid references public.cash_sessions(id) on delete set null;

-- La notificación del cierre: a quienes aprueban caja (gerencia), sin casilla
-- para apagarla.
insert into public.notification_rules
  (organization_id, event_type, channel, audience, required_permission, subscription_flag)
select o.id, 'CASH_CLOSE', 'WEB_PUSH', 'PERMISSION', 'cash.override', null
  from public.organizations o
on conflict (organization_id, event_type, channel) do nothing;


-- ─────────────────────────────────────────────
-- Nombre de un usuario, como se imprime
-- ─────────────────────────────────────────────
create or replace function public.caja_nombre(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(trim(p.display_name), ''), nullif(trim(p.first_name || ' ' || p.last_name), ''), 'Usuario')
    from public.profiles p where p.id = p_user
$$;
revoke all on function public.caja_nombre(uuid) from public, anon;
grant execute on function public.caja_nombre(uuid) to authenticated, service_role;


-- ─────────────────────────────────────────────
-- El resumen de un turno de caja (sin chequeo de permisos: lo llaman las
-- funciones de abajo, que sí chequean, y el servidor de correo)
-- ─────────────────────────────────────────────
create or replace function public.caja_resumen_datos(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s        public.cash_sessions;
  v_reg      public.cash_registers;
  v_branch   public.branches;
  v_hasta    timestamptz;
  v_metodos  jsonb;
  v_efectivo numeric(12,2);
  v_tarjeta  numeric(12,2);
  v_transfer numeric(12,2);
  v_otros    numeric(12,2);
  v_ventas   int;
  v_retiros  numeric(12,2);
  v_remesa   numeric(12,2);
  v_movs     jsonb;
begin
  select * into v_s from public.cash_sessions where id = p_session_id;
  if not found then raise exception 'No existe ese turno de caja' using errcode = 'P0002'; end if;
  select * into v_reg from public.cash_registers where id = v_s.cash_register_id;
  select * into v_branch from public.branches where id = v_reg.branch_id;
  v_hasta := coalesce(v_s.closed_at, now());

  -- Ventas cobradas en el turno, por tipo de método. Lo anulado no cuenta.
  select
    coalesce(sum(p.amount) filter (where pm.type = 'cash'), 0),
    coalesce(sum(p.amount) filter (where pm.type = 'card'), 0),
    coalesce(sum(p.amount) filter (where pm.type = 'bank_transfer'), 0),
    coalesce(sum(p.amount) filter (where pm.type not in ('cash', 'card', 'bank_transfer')), 0),
    count(distinct pa.work_order_id)
    into v_efectivo, v_tarjeta, v_transfer, v_otros, v_ventas
    from public.payments p
    join public.payment_methods pm on pm.id = p.payment_method_id
    left join public.payment_allocations pa on pa.payment_id = p.id
   where p.branch_id = v_reg.branch_id
     and p.status = 'approved'
     and p.created_at >= v_s.opened_at
     and p.created_at <  v_hasta;

  select coalesce(-sum(amount) filter (where type = 'cash_out'), 0),
         coalesce(-sum(amount) filter (where type = 'deposit'), 0)
    into v_retiros, v_remesa
    from public.cash_movements where cash_session_id = p_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',          m.id,
           'tipo',        m.type,
           'monto',       abs(m.amount),
           'motivo',      m.description,
           'fecha',       m.created_at,
           'registro',    public.caja_nombre(m.created_by),
           'autorizo',    case when m.authorized_by is not null then public.caja_nombre(m.authorized_by) end
         ) order by m.created_at), '[]'::jsonb)
    into v_movs
    from public.cash_movements m
   where m.cash_session_id = p_session_id and m.type in ('cash_out', 'deposit');

  return jsonb_build_object(
    'session_id',       v_s.id,
    'organization_id',  v_branch.organization_id,
    'branch_id',        v_branch.id,
    'sucursal',         v_branch.name,
    'caja',             v_reg.name,
    'estado',           v_s.status,
    'abierta_at',       v_s.opened_at,
    'abrio',            public.caja_nombre(v_s.opened_by),
    'cerrada_at',       v_s.closed_at,
    'cerro',            case when v_s.closed_by is not null then public.caja_nombre(v_s.closed_by) end,
    'efectivo_inicial', v_s.opening_amount,
    'ventas', jsonb_build_object(
      'efectivo',      v_efectivo,
      'tarjeta',       v_tarjeta,
      'transferencia', v_transfer,
      'otros',         v_otros,
      'total',         v_efectivo + v_tarjeta + v_transfer + v_otros,
      'cantidad',      v_ventas),
    'ingresos_efectivo', v_efectivo,
    'egresos_efectivo',  v_retiros,
    'remesa',            v_remesa,
    -- Lo que hay en la caja antes de remesar, y lo que queda después.
    'efectivo_disponible', v_s.opening_amount + v_efectivo - v_retiros,
    'efectivo_final',      v_s.opening_amount + v_efectivo - v_retiros - v_remesa,
    'movimientos',         v_movs
  );
end;
$$;
revoke all on function public.caja_resumen_datos(uuid) from public, anon, authenticated;
grant execute on function public.caja_resumen_datos(uuid) to service_role;


-- Que el usuario pueda operar esa caja: permiso y acceso a la sucursal.
create or replace function public.caja_de_sesion(p_session_id uuid, p_permiso text)
returns public.cash_sessions
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.cash_sessions;
begin
  if not public.has_permission(p_permiso) then
    raise exception 'No autorizado: se requiere %', p_permiso using errcode = '42501';
  end if;
  select s.* into v_s
    from public.cash_sessions s
    join public.cash_registers r on r.id = s.cash_register_id
   where s.id = p_session_id
     and r.branch_id in (select public.get_accessible_branch_ids());
  if v_s.id is null then raise exception 'No existe ese turno de caja' using errcode = 'P0002'; end if;
  return v_s;
end;
$$;
revoke all on function public.caja_de_sesion(uuid, text) from public, anon, authenticated;


-- ─────────────────────────────────────────────
-- Estado de la caja de una sucursal: el turno abierto (con su resumen en
-- vivo) o, si no hay, el último cierre para sugerir el efectivo inicial.
-- ─────────────────────────────────────────────
create or replace function public.caja_estado(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reg      public.cash_registers;
  v_abierta  uuid;
  v_ult_id   uuid;
  v_ult_at   timestamptz;
  v_ult_fin  numeric(12,2);
begin
  if not public.has_permission('cash.open') then
    raise exception 'No autorizado: se requiere cash.open' using errcode = '42501';
  end if;
  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;
  select * into v_reg from public.cash_registers
   where branch_id = p_branch_id and active = true order by code limit 1;
  if v_reg.id is null then
    raise exception 'Esta sucursal no tiene caja configurada' using errcode = 'P0002';
  end if;

  select id into v_abierta from public.cash_sessions
   where cash_register_id = v_reg.id and status = 'open' order by opened_at desc limit 1;

  select id, closed_at, coalesce((resumen->>'efectivo_final')::numeric, expected_cash)
    into v_ult_id, v_ult_at, v_ult_fin
    from public.cash_sessions
   where cash_register_id = v_reg.id and status <> 'open'
   order by closed_at desc nulls last limit 1;

  return jsonb_build_object(
    'cash_register_id', v_reg.id,
    'caja',             v_reg.name,
    'sesion',           case when v_abierta is not null then public.caja_resumen_datos(v_abierta) end,
    'ultimo_cierre',    case when v_ult_id is not null then jsonb_build_object(
                          'session_id', v_ult_id, 'cerrada_at', v_ult_at,
                          'efectivo_final', coalesce(v_ult_fin, 0)) end
  );
end;
$$;
revoke all on function public.caja_estado(uuid) from public, anon;
grant execute on function public.caja_estado(uuid) to authenticated;


-- ─────────────────────────────────────────────
-- Abrir la caja del día
-- ─────────────────────────────────────────────
create or replace function public.caja_abrir(p_branch_id uuid, p_monto numeric)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_reg uuid;
  v_id  uuid;
begin
  if not public.has_permission('cash.open') then
    raise exception 'No autorizado: se requiere cash.open' using errcode = '42501';
  end if;
  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;
  if p_monto is null or p_monto < 0 then
    raise exception 'El efectivo inicial no puede ser negativo' using errcode = '22023';
  end if;

  select id into v_reg from public.cash_registers
   where branch_id = p_branch_id and active = true order by code limit 1
   for update;
  if v_reg is null then raise exception 'Esta sucursal no tiene caja configurada' using errcode = 'P0002'; end if;
  if exists (select 1 from public.cash_sessions where cash_register_id = v_reg and status = 'open') then
    raise exception 'La caja ya está abierta' using errcode = '22023';
  end if;

  insert into public.cash_sessions (cash_register_id, opened_by, opening_amount, status)
  values (v_reg, auth.uid(), round(p_monto, 2), 'open')
  returning id into v_id;

  insert into public.cash_movements (cash_session_id, type, amount, reference_type, description, created_by)
  values (v_id, 'cash_in', round(p_monto, 2), 'apertura', 'Apertura de caja', auth.uid());

  return v_id;
end;
$$;
revoke all on function public.caja_abrir(uuid, numeric) from public, anon;
grant execute on function public.caja_abrir(uuid, numeric) to authenticated;


-- ─────────────────────────────────────────────
-- Quiénes pueden autorizar un retiro (cash.override) en la organización
-- ─────────────────────────────────────────────
create or replace function public.caja_autorizadores()
returns table (id uuid, nombre text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, public.caja_nombre(p.id)
    from public.profiles p
   where p.organization_id = public.get_my_organization_id()
     and p.active
     and public.corsa_usuario_tiene_permiso(p.id, 'cash.override')
     and public.has_permission('cash.open')
   order by 2
$$;
revoke all on function public.caja_autorizadores() from public, anon;
grant execute on function public.caja_autorizadores() to authenticated;


-- ─────────────────────────────────────────────
-- Retiro de efectivo: motivo, monto y quién autoriza
-- ─────────────────────────────────────────────
create or replace function public.caja_retiro(
  p_session_id     uuid,
  p_monto          numeric,
  p_motivo         text,
  p_autorizado_por uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_s          public.cash_sessions;
  v_disponible numeric(12,2);
begin
  v_s := public.caja_de_sesion(p_session_id, 'cash.open');
  perform 1 from public.cash_sessions where id = p_session_id for update;
  if v_s.status <> 'open' then
    raise exception 'La caja ya está cerrada' using errcode = '22023';
  end if;
  if p_monto is null or p_monto <= 0 then
    raise exception 'Ingresá el monto del retiro' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_motivo, '')), '') is null then
    raise exception 'El retiro necesita un motivo' using errcode = '22023';
  end if;
  if p_autorizado_por is null or not exists (
    select 1 from public.profiles
     where id = p_autorizado_por and active
       and organization_id = public.get_my_organization_id()
  ) or not public.corsa_usuario_tiene_permiso(p_autorizado_por, 'cash.override') then
    raise exception 'Quien autoriza tiene que ser gerente o administrador (cash.override)' using errcode = '22023';
  end if;

  v_disponible := (public.caja_resumen_datos(p_session_id)->>'efectivo_disponible')::numeric;
  if round(p_monto, 2) > v_disponible then
    raise exception 'No hay tanto efectivo en caja: disponible %', to_char(v_disponible, 'FM999,999,990.00')
      using errcode = '22023';
  end if;

  insert into public.cash_movements
    (cash_session_id, type, amount, reference_type, description, created_by, authorized_by)
  values
    (p_session_id, 'cash_out', -round(p_monto, 2), 'retiro', trim(p_motivo), auth.uid(), p_autorizado_por);

  return public.caja_resumen_datos(p_session_id);
end;
$$;
revoke all on function public.caja_retiro(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.caja_retiro(uuid, numeric, text, uuid) to authenticated;


-- ─────────────────────────────────────────────
-- Cierre: la remesa, el efectivo final y la notificación
-- ─────────────────────────────────────────────
create or replace function public.caja_cerrar(p_session_id uuid, p_remesa numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_s          public.cash_sessions;
  v_disponible numeric(12,2);
  v_resumen    jsonb;
  v_cuerpo     text;
begin
  v_s := public.caja_de_sesion(p_session_id, 'cash.close');
  select * into v_s from public.cash_sessions where id = p_session_id for update;
  if v_s.status <> 'open' then
    raise exception 'La caja ya está cerrada' using errcode = '22023';
  end if;
  if p_remesa is null or p_remesa < 0 then
    raise exception 'La remesa no puede ser negativa' using errcode = '22023';
  end if;

  v_disponible := (public.caja_resumen_datos(p_session_id)->>'efectivo_disponible')::numeric;
  if round(p_remesa, 2) > v_disponible then
    raise exception 'La remesa no puede ser mayor que el efectivo en caja (%)', to_char(v_disponible, 'FM999,999,990.00')
      using errcode = '22023';
  end if;

  if p_remesa > 0 then
    insert into public.cash_movements (cash_session_id, type, amount, reference_type, description, created_by)
    values (p_session_id, 'deposit', -round(p_remesa, 2), 'remesa', 'Remesa de efectivo', auth.uid());
  end if;

  update public.cash_sessions
     set closed_at = now(), closed_by = auth.uid(), status = 'closed', remesa = round(p_remesa, 2)
   where id = p_session_id;

  v_resumen := public.caja_resumen_datos(p_session_id);
  update public.cash_sessions
     set resumen       = v_resumen,
         expected_cash = (v_resumen->>'efectivo_final')::numeric,
         counted_cash  = (v_resumen->>'efectivo_final')::numeric,
         difference    = 0
   where id = p_session_id;

  v_cuerpo := format('%s · Ventas $%s (efectivo $%s, tarjeta $%s, transferencia $%s) · Retiros $%s · Remesa $%s · Queda en caja $%s',
    v_resumen->>'sucursal',
    to_char((v_resumen->'ventas'->>'total')::numeric, 'FM999,999,990.00'),
    to_char((v_resumen->'ventas'->>'efectivo')::numeric, 'FM999,999,990.00'),
    to_char((v_resumen->'ventas'->>'tarjeta')::numeric, 'FM999,999,990.00'),
    to_char((v_resumen->'ventas'->>'transferencia')::numeric, 'FM999,999,990.00'),
    to_char((v_resumen->>'egresos_efectivo')::numeric, 'FM999,999,990.00'),
    to_char((v_resumen->>'remesa')::numeric, 'FM999,999,990.00'),
    to_char((v_resumen->>'efectivo_final')::numeric, 'FM999,999,990.00'));

  -- La notificación no puede tumbar el cierre: si falla, el cierre queda.
  begin
    perform public.corsa_emitir_notificacion(
      p_org       => (v_resumen->>'organization_id')::uuid,
      p_tipo      => 'CASH_CLOSE',
      p_clave     => 'cash-close-' || p_session_id::text,
      p_titulo    => '💵 CORSA — Cierre de caja',
      p_cuerpo    => v_cuerpo,
      p_deep_link => '/cierres-caja/' || p_session_id::text,
      p_metadata  => jsonb_build_object('session_id', p_session_id, 'resumen', v_resumen),
      p_severidad => 'INFO'
    );
  exception when others then
    raise warning 'No se pudo emitir la notificación del cierre %: %', p_session_id, sqlerrm;
  end;

  return v_resumen;
end;
$$;
revoke all on function public.caja_cerrar(uuid, numeric) from public, anon;
grant execute on function public.caja_cerrar(uuid, numeric) to authenticated;


-- ─────────────────────────────────────────────
-- El reporte de un turno: la foto del cierre, o el resumen en vivo si sigue
-- abierto
-- ─────────────────────────────────────────────
create or replace function public.caja_reporte(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.cash_sessions;
begin
  v_s := public.caja_de_sesion(p_session_id, 'cash.open');
  return coalesce(v_s.resumen, public.caja_resumen_datos(p_session_id));
end;
$$;
revoke all on function public.caja_reporte(uuid) from public, anon;
grant execute on function public.caja_reporte(uuid) to authenticated;


-- ─────────────────────────────────────────────
-- Pantalla «Cierres de caja»: el historial día a día, para control
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description) values
  ('screens.cash_closes', 'screens', 'Pantalla: Cierres de caja')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles r cross join public.permissions p
 where r.id in ('00000000-0000-0000-0002-000000000001',   -- Super Admin
                '00000000-0000-0000-0002-000000000002',   -- Administrador
                '00000000-0000-0000-0002-000000000003')   -- Gerente
   and p.code = 'screens.cash_closes'
on conflict do nothing;

-- Los turnos de caja de un rango de fechas (El Salvador), el más reciente
-- primero. Los cerrados salen de su foto; el abierto, en vivo.
create or replace function public.caja_historial(p_desde date, p_hasta date, p_branch_id uuid default null)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_permission('screens.cash_closes') or public.has_permission('cash.override')) then
    raise exception 'No autorizado: se requiere screens.cash_closes' using errcode = '42501';
  end if;
  return query
    select coalesce(s.resumen, public.caja_resumen_datos(s.id))
      from public.cash_sessions s
      join public.cash_registers r on r.id = s.cash_register_id
     where r.branch_id in (select public.get_accessible_branch_ids())
       and (p_branch_id is null or r.branch_id = p_branch_id)
       and (s.opened_at at time zone 'America/El_Salvador')::date between p_desde and p_hasta
     order by s.opened_at desc;
end;
$$;
revoke all on function public.caja_historial(date, date, uuid) from public, anon;
grant execute on function public.caja_historial(date, date, uuid) to authenticated;

-- El reporte también lo abre quien revisa los cierres sin operar caja.
create or replace function public.caja_reporte(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.cash_sessions;
begin
  v_s := public.caja_de_sesion(p_session_id,
           case when public.has_permission('cash.open') then 'cash.open' else 'screens.cash_closes' end);
  return coalesce(v_s.resumen, public.caja_resumen_datos(p_session_id));
end;
$$;
