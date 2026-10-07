-- ============================================================
-- Migration: 0075_inteligencia_de_negocio.sql
-- Description: Agregados de Inteligencia de negocio (etapa 1): KPIs del
--              período y del anterior, mix de servicios, serie de tendencia
--              y proyección de cierre de mes, más metas y días operativos.
--
--   DEFINICIONES (las mismas en toda la app)
--   · Ventas: work_orders no anuladas de tipo service, voucher_sale y
--     addon_sale (igual que v_daily_totals.gross_revenue). Facturadas: las
--     mismas sin facturacion_diferida.
--   · Lavado: un carro lavado (0074): línea con servicio de programa de
--     máquina. Contado o crédito; un canje es un lavado de $0.
--   · Ticket promedio: ventas de órdenes de servicio ÷ órdenes de servicio
--     (una orden = una factura; puede llevar varios carros).
--   · Ingreso por lavado: ventas ÷ lavados.
--   · Mix premium: (ÉLITE + SIGNATURE) ÷ lavados.
--   Los días son de El Salvador: el rango [desde, hasta] va de la medianoche
--   local de `desde` a la medianoche local del día siguiente a `hasta`.
--
--   SEGURIDAD
--   Las funciones son SECURITY DEFINER (no pagan el RLS fila por fila) y por
--   eso validan ellas: organización del usuario, sucursales a las que tiene
--   acceso y permiso screens.analytics o screens.dashboard (el Resumen del día
--   usa la serie diaria). Las funciones internas bi_* no se exponen.
-- ============================================================


-- ─────────────────────────────────────────────
-- 1. Metas y días operativos
-- ─────────────────────────────────────────────
create table if not exists public.business_goals (
  id              uuid          primary key default gen_random_uuid(),
  organization_id uuid          not null references public.organizations(id) on delete cascade,
  -- null = la meta de toda la organización.
  branch_id       uuid          references public.branches(id) on delete cascade,
  -- Primer día del mes.
  month           date          not null check (extract(day from month) = 1),
  sales_goal      numeric(12,2) check (sales_goal is null or sales_goal > 0),
  washes_goal     integer       check (washes_goal is null or washes_goal > 0),
  updated_at      timestamptz   not null default now(),
  updated_by      uuid          default auth.uid() references public.profiles(id) on delete set null
);

create unique index if not exists business_goals_unique
  on public.business_goals(organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), month);

comment on table public.business_goals is
  'Meta mensual de ventas y de lavados (0075). branch_id null = toda la organización.';

create table if not exists public.business_calendar (
  organization_id uuid     not null references public.organizations(id) on delete cascade,
  -- null = todas las sucursales.
  branch_id       uuid     references public.branches(id) on delete cascade,
  -- 0 domingo … 6 sábado (extract(dow)).
  weekday         smallint not null check (weekday between 0 and 6),
  is_open         boolean  not null default true,
  updated_at      timestamptz not null default now()
);

create unique index if not exists business_calendar_unique
  on public.business_calendar(organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), weekday);

comment on table public.business_calendar is
  'Qué días de la semana abre CORSA (0075). Sin filas, los días operativos se deducen de la actividad de las últimas 8 semanas.';

alter table public.business_goals    enable row level security;
alter table public.business_calendar enable row level security;

drop policy if exists "business_goals_select" on public.business_goals;
create policy "business_goals_select" on public.business_goals for select
  using (organization_id = public.get_my_organization_id());
drop policy if exists "business_goals_manage" on public.business_goals;
create policy "business_goals_manage" on public.business_goals for all
  using (organization_id = public.get_my_organization_id() and public.has_permission('settings.manage'))
  with check (organization_id = public.get_my_organization_id() and public.has_permission('settings.manage'));

drop policy if exists "business_calendar_select" on public.business_calendar;
create policy "business_calendar_select" on public.business_calendar for select
  using (organization_id = public.get_my_organization_id());
drop policy if exists "business_calendar_manage" on public.business_calendar;
create policy "business_calendar_manage" on public.business_calendar for all
  using (organization_id = public.get_my_organization_id() and public.has_permission('settings.manage'))
  with check (organization_id = public.get_my_organization_id() and public.has_permission('settings.manage'));

revoke all on public.business_goals, public.business_calendar from anon;
grant select, insert, update, delete on public.business_goals, public.business_calendar to authenticated;

-- Las consultas por período filtran por organización y fecha.
create index if not exists idx_work_orders_org_created
  on public.work_orders(organization_id, created_at);


-- ─────────────────────────────────────────────
-- 2. Acceso: organización, sucursales y permiso
-- ─────────────────────────────────────────────
create or replace function public.bi_alcance(p_branch_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ramas uuid[];
begin
  if not (public.has_permission('screens.analytics') or public.has_permission('screens.dashboard')) then
    raise exception 'No autorizado: se requiere screens.analytics' using errcode = '42501';
  end if;
  select array_agg(b.id) into v_ramas
    from public.branches b
   where b.organization_id = public.get_my_organization_id()
     and b.id in (select public.get_accessible_branch_ids())
     and (p_branch_id is null or b.id = p_branch_id);
  if v_ramas is null then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;
  return v_ramas;
end;
$$;

revoke all on function public.bi_alcance(uuid) from public, anon, authenticated;

-- Medianoche local de un día, como timestamptz.
create or replace function public.bi_inicio(p_dia date)
returns timestamptz
language sql
stable
as $$ select (p_dia::timestamp at time zone 'America/El_Salvador') $$;


-- ─────────────────────────────────────────────
-- 3. Métricas de un rango
-- ─────────────────────────────────────────────
create or replace function public.bi_metricas(p_ramas uuid[], p_desde date, p_hasta date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ord as (
    select wo.id, wo.total, wo.order_kind, wo.facturacion_diferida, wo.created_at
      from public.work_orders wo
     where wo.organization_id = public.get_my_organization_id()
       and wo.branch_id = any(p_ramas)
       and wo.status <> 'cancelled'
       and wo.created_at >= public.bi_inicio(p_desde)
       and wo.created_at <  public.bi_inicio(p_hasta + 1)
  ),
  lav as (
    select upper(s.code) as servicio,
           sum(i.quantity)::int as lavados,
           coalesce(sum(i.total), 0) as ingresos,
           coalesce(sum(i.quantity) filter (where i.total = 0), 0)::int as sin_cobro
      from ord
      join public.work_order_items i on i.work_order_id = ord.id
      join public.services s on s.id = i.service_id and s.machine_program is not null
     group by 1
  )
  select jsonb_build_object(
    'ventas',            coalesce(sum(o.total) filter (where o.order_kind in ('service', 'voucher_sale', 'addon_sale')), 0),
    'ventas_facturadas', coalesce(sum(o.total) filter (where o.order_kind in ('service', 'voucher_sale', 'addon_sale') and not o.facturacion_diferida), 0),
    'ventas_servicio',   coalesce(sum(o.total) filter (where o.order_kind = 'service'), 0),
    'ordenes_servicio',  count(*) filter (where o.order_kind = 'service'),
    'lavados',           (select coalesce(sum(lavados), 0) from lav),
    'lavados_sin_cobro', (select coalesce(sum(sin_cobro), 0) from lav),
    'mix',               (select coalesce(jsonb_object_agg(servicio, jsonb_build_object(
                             'lavados', lavados, 'ingresos', ingresos, 'sin_cobro', sin_cobro)), '{}'::jsonb) from lav),
    'dias_con_venta',    count(distinct (o.created_at at time zone 'America/El_Salvador')::date)
  )
  from ord o;
$$;

revoke all on function public.bi_metricas(uuid[], date, date) from public, anon, authenticated;


-- ─────────────────────────────────────────────
-- 4. RPC: el período y el anterior
--
--    El anterior lo calcula la pantalla según el preset (mes contra los
--    mismos días del mes anterior, 30 días contra los 30 previos…) y lo
--    manda; acá sólo se mide.
-- ─────────────────────────────────────────────
create or replace function public.bi_resumen(
  p_desde date, p_hasta date, p_ant_desde date, p_ant_hasta date, p_branch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ramas uuid[] := public.bi_alcance(p_branch_id);
begin
  if p_hasta < p_desde or p_ant_hasta < p_ant_desde then
    raise exception 'Rango de fechas inválido' using errcode = '22023';
  end if;
  if p_hasta - p_desde > 3660 then
    raise exception 'El rango máximo es de 10 años' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'actual',   public.bi_metricas(v_ramas, p_desde, p_hasta),
    'anterior', public.bi_metricas(v_ramas, p_ant_desde, p_ant_hasta),
    -- Desde cuándo hay ventas en el sistema: sin esto, un «+100%» contra un
    -- período en que el POS no existía parecería crecimiento.
    'primera_venta', (select min((wo.created_at at time zone 'America/El_Salvador')::date)
                        from public.work_orders wo
                       where wo.organization_id = public.get_my_organization_id()
                         and wo.branch_id = any(v_ramas) and wo.status <> 'cancelled')
  );
end;
$$;

revoke all on function public.bi_resumen(date, date, date, date, uuid) from public, anon;
grant execute on function public.bi_resumen(date, date, date, date, uuid) to authenticated;


-- ─────────────────────────────────────────────
-- 5. RPC: serie de tendencia (día, semana o mes)
--
--    Todos los cubos del rango, también los vacíos: una semana sin ventas
--    es un cero, no un hueco en la gráfica.
-- ─────────────────────────────────────────────
create or replace function public.bi_serie(
  p_desde date, p_hasta date, p_granularidad text default 'day', p_branch_id uuid default null
)
returns table (bucket date, ventas numeric, lavados integer, ordenes_servicio integer,
               lavados_pro integer, lavados_elite integer, lavados_signature integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ramas uuid[] := public.bi_alcance(p_branch_id);
  v_g     text   := lower(coalesce(p_granularidad, 'day'));
begin
  if v_g not in ('day', 'week', 'month') then
    raise exception 'Granularidad inválida: day, week o month' using errcode = '22023';
  end if;
  if p_hasta < p_desde or p_hasta - p_desde > 3660 then
    raise exception 'Rango de fechas inválido' using errcode = '22023';
  end if;
  return query
  with cubos as (
    select g::date as b
      from generate_series(date_trunc(v_g, p_desde::timestamp), p_hasta::timestamp, ('1 ' || v_g)::interval) g
  ),
  ord as (
    select wo.id, wo.total, wo.order_kind,
           date_trunc(v_g, (wo.created_at at time zone 'America/El_Salvador'))::date as b
      from public.work_orders wo
     where wo.organization_id = public.get_my_organization_id()
       and wo.branch_id = any(v_ramas)
       and wo.status <> 'cancelled'
       and wo.created_at >= public.bi_inicio(p_desde)
       and wo.created_at <  public.bi_inicio(p_hasta + 1)
  ),
  v as (
    select ord.b,
           coalesce(sum(ord.total) filter (where ord.order_kind in ('service', 'voucher_sale', 'addon_sale')), 0) as ventas,
           (count(*) filter (where ord.order_kind = 'service'))::int as ordenes
      from ord group by ord.b
  ),
  l as (
    select ord.b,
           sum(i.quantity)::int as lavados,
           coalesce(sum(i.quantity) filter (where upper(s.code) = 'PRO'), 0)::int       as pro,
           coalesce(sum(i.quantity) filter (where upper(s.code) = 'ELITE'), 0)::int     as elite,
           coalesce(sum(i.quantity) filter (where upper(s.code) = 'SIGNATURE'), 0)::int as signature
      from ord
      join public.work_order_items i on i.work_order_id = ord.id
      join public.services s on s.id = i.service_id and s.machine_program is not null
     group by ord.b
  )
  select c.b, coalesce(v.ventas, 0), coalesce(l.lavados, 0), coalesce(v.ordenes, 0),
         coalesce(l.pro, 0), coalesce(l.elite, 0), coalesce(l.signature, 0)
    from cubos c
    left join v on v.b = c.b
    left join l on l.b = c.b
   order by c.b;
end;
$$;

revoke all on function public.bi_serie(date, date, text, uuid) from public, anon;
grant execute on function public.bi_serie(date, date, text, uuid) to authenticated;


-- ─────────────────────────────────────────────
-- 6. Días operativos
--
--    Con business_calendar cargado, manda el calendario (la fila de la
--    sucursal por encima de la de toda la organización). Sin calendario, un
--    día de la semana es operativo si en las 8 semanas anteriores hubo ventas
--    o lavados de máquina ese día; sin ninguna actividad, todos lo son.
-- ─────────────────────────────────────────────
create or replace function public.bi_dias_operativos(p_ramas uuid[], p_desde date, p_hasta date)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org     uuid := public.get_my_organization_id();
  v_abiertos smallint[];
  v_rama    uuid := case when array_length(p_ramas, 1) = 1 then p_ramas[1] end;
begin
  if p_hasta < p_desde then return 0; end if;

  select array_agg(weekday) into v_abiertos
    from (
      select distinct on (weekday) weekday, is_open
        from public.business_calendar
       where organization_id = v_org and (branch_id is null or branch_id = v_rama)
       order by weekday, (branch_id is null)
    ) c
   where is_open;

  if v_abiertos is null and not exists (select 1 from public.business_calendar where organization_id = v_org) then
    select array_agg(distinct d) into v_abiertos
      from (
        select extract(dow from (wo.created_at at time zone 'America/El_Salvador'))::smallint as d
          from public.work_orders wo
         where wo.organization_id = v_org and wo.branch_id = any(p_ramas) and wo.status <> 'cancelled'
           and wo.created_at >= public.bi_inicio(p_desde - 56) and wo.created_at < public.bi_inicio(p_desde)
        union
        select extract(dow from (c.started_at at time zone 'America/El_Salvador'))::smallint
          from public.plc_wash_cycles c
         where c.organization_id = v_org
           and c.started_at >= public.bi_inicio(p_desde - 56) and c.started_at < public.bi_inicio(p_desde)
           and public.corsa_cuenta_como_lavado(c.status)
      ) x;
    if v_abiertos is null then
      v_abiertos := array[0, 1, 2, 3, 4, 5, 6]::smallint[];
    end if;
  end if;

  return (select count(*)::int
            from generate_series(p_desde::timestamp, p_hasta::timestamp, interval '1 day') g
           where extract(dow from g)::smallint = any(coalesce(v_abiertos, '{}'::smallint[])));
end;
$$;

revoke all on function public.bi_dias_operativos(uuid[], date, date) from public, anon, authenticated;


-- ─────────────────────────────────────────────
-- 7. RPC: proyección de cierre del mes en curso
--
--    Run-rate sobre días operativos COMPLETOS (hasta ayer): el día de hoy va
--    a medias y bajaría el promedio. Si el POS empezó a usarse dentro del mes,
--    el promedio cuenta desde la primera venta: los días sin sistema no son
--    días sin clientes. Proyección = lo vendido hasta ayer + promedio × días
--    operativos que faltan contando hoy; nunca menos de lo ya vendido.
-- ─────────────────────────────────────────────
create or replace function public.bi_proyeccion(p_branch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ramas      uuid[] := public.bi_alcance(p_branch_id);
  v_hoy        date   := (now() at time zone 'America/El_Salvador')::date;
  v_inicio     date   := date_trunc('month', v_hoy)::date;
  v_fin        date   := (date_trunc('month', v_hoy) + interval '1 month - 1 day')::date;
  v_mes        jsonb;
  v_hasta_ayer jsonb;
  v_completos  int;
  v_restantes  int;
  v_ventas_dia numeric;
  v_lav_dia    numeric;
  v_goal       record;
  v_desde_rate date;
begin
  v_mes        := public.bi_metricas(v_ramas, v_inicio, v_hoy);
  v_hasta_ayer := case when v_hoy > v_inicio then public.bi_metricas(v_ramas, v_inicio, v_hoy - 1) end;
  select greatest(v_inicio, min((wo.created_at at time zone 'America/El_Salvador')::date))
    into v_desde_rate
    from public.work_orders wo
   where wo.organization_id = public.get_my_organization_id()
     and wo.branch_id = any(v_ramas) and wo.status <> 'cancelled';
  v_completos  := case when v_desde_rate is not null and v_hoy > v_desde_rate
                       then public.bi_dias_operativos(v_ramas, v_desde_rate, v_hoy - 1) else 0 end;
  v_restantes  := public.bi_dias_operativos(v_ramas, v_hoy, v_fin);

  if v_completos > 0 then
    v_ventas_dia := (v_hasta_ayer->>'ventas')::numeric / v_completos;
    v_lav_dia    := (v_hasta_ayer->>'lavados')::numeric / v_completos;
  end if;

  select sales_goal, washes_goal into v_goal
    from public.business_goals
   where organization_id = public.get_my_organization_id()
     and month = v_inicio
     and (branch_id is null and p_branch_id is null or branch_id = p_branch_id)
   limit 1;

  return jsonb_build_object(
    'mes',                 v_inicio,
    'hoy',                 v_hoy,
    'fin_de_mes',          v_fin,
    'ventas_acumuladas',   (v_mes->>'ventas')::numeric,
    'lavados_acumulados',  (v_mes->>'lavados')::int,
    'dias_completos',      v_completos,
    'promedio_desde',      v_desde_rate,
    'dias_restantes',      v_restantes,
    'ventas_por_dia',      round(v_ventas_dia, 2),
    'lavados_por_dia',     round(v_lav_dia, 1),
    'proyeccion_ventas',   case when v_ventas_dia is null then null
                                else greatest((v_mes->>'ventas')::numeric,
                                              round((v_hasta_ayer->>'ventas')::numeric + v_ventas_dia * v_restantes, 2)) end,
    'proyeccion_lavados',  case when v_lav_dia is null then null
                                else greatest((v_mes->>'lavados')::numeric,
                                              round((v_hasta_ayer->>'lavados')::numeric + v_lav_dia * v_restantes)) end,
    'meta_ventas',         v_goal.sales_goal,
    'meta_lavados',        v_goal.washes_goal,
    'calendario_configurado', exists (select 1 from public.business_calendar
                                       where organization_id = public.get_my_organization_id())
  );
end;
$$;

revoke all on function public.bi_proyeccion(uuid) from public, anon;
grant execute on function public.bi_proyeccion(uuid) to authenticated;
