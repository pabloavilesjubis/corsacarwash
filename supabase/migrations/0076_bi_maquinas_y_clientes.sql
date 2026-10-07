-- ============================================================
-- Migration: 0076_bi_maquinas_y_clientes.sql
-- Description: Inteligencia de negocio, etapa 2: rendimiento de máquinas,
--              cuadre caja vs máquinas del período, y clientes/recurrencia.
--
--   MÁQUINAS (plc_wash_cycles)
--   · Lavado: ciclo que corsa_cuenta_como_lavado acepta.
--   · Ciclo promedio y tiempo lavando: sólo ciclos con duración dentro de
--     [min_valid_seconds, max_valid_seconds] de plc_service_rules. Un ciclo de
--     97 minutos (el PLC no cerró a tiempo) cuenta como lavado pero no entra
--     al promedio.
--   · Jornada activa: por día y máquina, del primer inicio al último cierre
--     de un lavado. Es una APROXIMACIÓN de las horas operativas: el gateway
--     informa las máquinas «en línea» las 24 horas, así que no hay una señal
--     de encendido/apagado ni de horario de apertura.
--   · Fallas: eventos FAULT_STARTED. Tiempo en falla: machine_error_incidents
--     (PARCIAL: hay incidentes que el sistema cerró en 0 s).
--   · NO se calcula disponibilidad: sin horario de apertura ni intervalos de
--     detención reales sería un número inventado.
--   · El PLC no está atado a una sucursal (plc_gateways.branch_id es null):
--     se filtra por organización.
--
--   CLIENTES (sólo clientes identificados; los lavados a Consumidor Final se
--   informan aparte y no entran en ninguna métrica de clientes)
--   · Cliente activo: con al menos un lavado en el período.
--   · Nuevo: su PRIMER lavado de toda la historia cae dentro del período.
--   · Recurrente: activo en el período, con un lavado anterior al período.
--   · Frecuencia: lavados ÷ clientes activos (visita = carro lavado).
--   · Días entre lavados: brecha entre días distintos de lavado del mismo
--     cliente, cuando el día posterior cae en el período.
--   · Retención a N días: de los clientes cuyo primer lavado DEL PERÍODO fue
--     el día d, los que volvieron entre d+1 y d+N. Sólo se mide a quien ya
--     cumplió d+N (cohorte madura); el resto no entra en la muestra.
--   · Gasto por cliente: ventas (servicio, adicionales, cupones) a clientes
--     identificados ÷ clientes activos.
-- ============================================================


-- ─────────────────────────────────────────────
-- 1. Máquinas
-- ─────────────────────────────────────────────
create or replace function public.bi_maquinas_rango(p_desde date, p_hasta date, p_maquina text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with reglas as (
    select coalesce(min(min_valid_seconds) filter (where machine_id = '*'), 180) as minv,
           coalesce(max(max_valid_seconds) filter (where machine_id = '*'), 650) as maxv
      from public.plc_service_rules
     where organization_id = public.get_my_organization_id()
  ),
  ciclos as (
    select c.machine_id, c.started_at, c.completed_at, c.duration_seconds, c.service_type,
           (c.started_at at time zone 'America/El_Salvador')::date as dia
      from public.plc_wash_cycles c
     where c.organization_id = public.get_my_organization_id()
       and c.started_at >= public.bi_inicio(p_desde)
       and c.started_at <  public.bi_inicio(p_hasta + 1)
       and public.corsa_cuenta_como_lavado(c.status)
       and (p_maquina is null or c.machine_id = p_maquina)
  ),
  jornadas as (
    select machine_id, dia,
           extract(epoch from (max(coalesce(completed_at, started_at)) - min(started_at))) as segundos
      from ciclos group by machine_id, dia
  ),
  fallas as (
    select e.machine_id, count(*)::int as n
      from public.plc_machine_events e
     where e.organization_id = public.get_my_organization_id()
       and e.event_type = 'FAULT_STARTED'
       and e.event_timestamp >= public.bi_inicio(p_desde)
       and e.event_timestamp <  public.bi_inicio(p_hasta + 1)
       and (p_maquina is null or e.machine_id = p_maquina)
     group by e.machine_id
  ),
  incidentes as (
    select i.machine_id, coalesce(sum(i.duration_seconds), 0) as segundos
      from public.machine_error_incidents i
     where i.organization_id = public.get_my_organization_id()
       and i.started_at >= public.bi_inicio(p_desde)
       and i.started_at <  public.bi_inicio(p_hasta + 1)
       and (p_maquina is null or i.machine_id = p_maquina)
     group by i.machine_id
  ),
  por_maquina as (
    select c.machine_id,
           count(*)::int                                                     as lavados,
           count(*) filter (where c.service_type = 'PRO')::int               as pro,
           count(*) filter (where c.service_type = 'ELITE')::int             as elite,
           count(*) filter (where c.service_type = 'SIGNATURE')::int         as signature,
           count(*) filter (where c.service_type not in ('PRO', 'ELITE', 'SIGNATURE') or c.service_type is null)::int as sin_clasificar,
           count(*) filter (where c.duration_seconds between r.minv and r.maxv)::int as ciclos_validos,
           count(*) filter (where c.duration_seconds is null or c.duration_seconds not between r.minv and r.maxv)::int as ciclos_fuera_de_rango,
           coalesce(sum(c.duration_seconds) filter (where c.duration_seconds between r.minv and r.maxv), 0) as segundos_lavando,
           count(distinct c.dia)::int                                        as dias_activos
      from ciclos c cross join reglas r
     group by c.machine_id
  ),
  maquinas as (
    select machine_id from por_maquina
    union select machine_id from fallas
    union select machine_id from incidentes
  )
  select jsonb_build_object(
    'reglas', (select jsonb_build_object('min_valid_seconds', minv, 'max_valid_seconds', maxv) from reglas),
    'maquinas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'machine_id',            m.machine_id,
        'nombre',                (select pm.name from public.plc_machines pm
                                   where pm.organization_id = public.get_my_organization_id() and pm.machine_code = m.machine_id limit 1),
        'lavados',               coalesce(p.lavados, 0),
        'pro',                   coalesce(p.pro, 0),
        'elite',                 coalesce(p.elite, 0),
        'signature',             coalesce(p.signature, 0),
        'sin_clasificar',        coalesce(p.sin_clasificar, 0),
        'ciclos_validos',        coalesce(p.ciclos_validos, 0),
        'ciclos_fuera_de_rango', coalesce(p.ciclos_fuera_de_rango, 0),
        'segundos_lavando',      coalesce(p.segundos_lavando, 0),
        'segundos_jornada',      coalesce((select sum(j.segundos) from jornadas j where j.machine_id = m.machine_id), 0),
        'dias_activos',          coalesce(p.dias_activos, 0),
        'fallas',                coalesce(f.n, 0),
        'segundos_en_falla',     coalesce(i.segundos, 0)
      ) order by m.machine_id)
        from maquinas m
        left join por_maquina p on p.machine_id = m.machine_id
        left join fallas f      on f.machine_id = m.machine_id
        left join incidentes i  on i.machine_id = m.machine_id
    ), '[]'::jsonb),
    'primer_ciclo', (select min((c.started_at at time zone 'America/El_Salvador')::date)
                       from public.plc_wash_cycles c
                      where c.organization_id = public.get_my_organization_id())
  );
$$;

revoke all on function public.bi_maquinas_rango(date, date, text) from public, anon, authenticated;

create or replace function public.bi_maquinas(
  p_desde date, p_hasta date, p_ant_desde date, p_ant_hasta date, p_maquina text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.bi_alcance(null);
  if p_hasta < p_desde or p_ant_hasta < p_ant_desde or p_hasta - p_desde > 3660 then
    raise exception 'Rango de fechas inválido' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'actual',   public.bi_maquinas_rango(p_desde, p_hasta, p_maquina),
    'anterior', public.bi_maquinas_rango(p_ant_desde, p_ant_hasta, p_maquina)
  );
end;
$$;

revoke all on function public.bi_maquinas(date, date, date, date, text) from public, anon;
grant execute on function public.bi_maquinas(date, date, date, date, text) to authenticated;


-- ─────────────────────────────────────────────
-- 2. Cuadre caja vs máquinas, por día y servicio
--
--    Caja: carros lavados (líneas con programa de máquina). Máquinas: ciclos
--    que cuentan como lavado, con el tipo que el PLC dedujo por duración.
-- ─────────────────────────────────────────────
create or replace function public.bi_cuadre(p_desde date, p_hasta date, p_branch_id uuid default null)
returns table (fecha date, servicio text, caja integer, maquinas integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ramas uuid[] := public.bi_alcance(p_branch_id);
begin
  if p_hasta < p_desde or p_hasta - p_desde > 3660 then
    raise exception 'Rango de fechas inválido' using errcode = '22023';
  end if;
  return query
  with caja as (
    select (wo.created_at at time zone 'America/El_Salvador')::date as f, upper(s.code) as srv, sum(i.quantity)::int as n
      from public.work_orders wo
      join public.work_order_items i on i.work_order_id = wo.id
      join public.services s on s.id = i.service_id and s.machine_program is not null
     where wo.organization_id = public.get_my_organization_id()
       and wo.branch_id = any(v_ramas)
       and wo.status <> 'cancelled'
       and wo.created_at >= public.bi_inicio(p_desde)
       and wo.created_at <  public.bi_inicio(p_hasta + 1)
     group by 1, 2
  ),
  plc as (
    select (c.started_at at time zone 'America/El_Salvador')::date as f,
           case when c.service_type in ('PRO', 'ELITE', 'SIGNATURE') then c.service_type else 'SIN_CLASIFICAR' end as srv,
           count(*)::int as n
      from public.plc_wash_cycles c
     where c.organization_id = public.get_my_organization_id()
       and c.started_at >= public.bi_inicio(p_desde)
       and c.started_at <  public.bi_inicio(p_hasta + 1)
       and public.corsa_cuenta_como_lavado(c.status)
     group by 1, 2
  )
  select coalesce(caja.f, plc.f), coalesce(caja.srv, plc.srv), coalesce(caja.n, 0), coalesce(plc.n, 0)
    from caja full join plc on plc.f = caja.f and plc.srv = caja.srv
   order by 1, 2;
end;
$$;

revoke all on function public.bi_cuadre(date, date, uuid) from public, anon;
grant execute on function public.bi_cuadre(date, date, uuid) to authenticated;


-- ─────────────────────────────────────────────
-- 3. Clientes y recurrencia
-- ─────────────────────────────────────────────
create or replace function public.bi_clientes_rango(p_ramas uuid[], p_desde date, p_hasta date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with lav as (   -- todos los carros lavados hasta el fin del período
    select wo.customer_id, i.vehicle_id, i.quantity,
           (wo.created_at at time zone 'America/El_Salvador')::date as dia
      from public.work_orders wo
      join public.work_order_items i on i.work_order_id = wo.id
      join public.services s on s.id = i.service_id and s.machine_program is not null
     where wo.organization_id = public.get_my_organization_id()
       and wo.branch_id = any(p_ramas)
       and wo.status <> 'cancelled'
       and wo.created_at < public.bi_inicio(p_hasta + 1)
  ),
  en_periodo as (select * from lav where dia >= p_desde),
  activos as (
    select customer_id, min(dia) as primero_periodo, sum(quantity) as lavados
      from en_periodo where customer_id is not null group by customer_id
  ),
  historia as (
    select customer_id, min(dia) as primero
      from lav where customer_id is not null group by customer_id
  ),
  dias as (       -- días distintos de lavado por cliente, con el anterior
    select customer_id, dia, lag(dia) over (partition by customer_id order by dia) as dia_anterior
      from (select distinct customer_id, dia from lav where customer_id is not null) d
  ),
  vehiculos as (
    select vehicle_id, count(distinct dia) as dias from en_periodo where vehicle_id is not null group by vehicle_id
  ),
  retencion as (
    select n.dias_n,
           count(*) filter (where a.primero_periodo + n.dias_n <= (now() at time zone 'America/El_Salvador')::date)::int as cohorte,
           count(*) filter (where a.primero_periodo + n.dias_n <= (now() at time zone 'America/El_Salvador')::date
                              and exists (select 1 from public.work_orders wo2
                                            join public.work_order_items i2 on i2.work_order_id = wo2.id
                                            join public.services s2 on s2.id = i2.service_id and s2.machine_program is not null
                                           where wo2.customer_id = a.customer_id
                                             and wo2.organization_id = public.get_my_organization_id()
                                             and wo2.branch_id = any(p_ramas)
                                             and wo2.status <> 'cancelled'
                                             and (wo2.created_at at time zone 'America/El_Salvador')::date > a.primero_periodo
                                             and (wo2.created_at at time zone 'America/El_Salvador')::date <= a.primero_periodo + n.dias_n))::int as retenidos
      from activos a cross join (values (30), (60), (90)) as n(dias_n)
     group by n.dias_n
  ),
  gasto as (
    select coalesce(sum(wo.total), 0) as ventas
      from public.work_orders wo
     where wo.organization_id = public.get_my_organization_id()
       and wo.branch_id = any(p_ramas)
       and wo.status <> 'cancelled'
       and wo.customer_id is not null
       and wo.order_kind in ('service', 'voucher_sale', 'addon_sale')
       and wo.created_at >= public.bi_inicio(p_desde)
       and wo.created_at <  public.bi_inicio(p_hasta + 1)
  )
  select jsonb_build_object(
    'lavados',                (select coalesce(sum(quantity), 0) from en_periodo),
    'lavados_identificados',  (select coalesce(sum(quantity), 0) from en_periodo where customer_id is not null),
    'clientes_activos',       (select count(*) from activos),
    'clientes_nuevos',        (select count(*) from activos a join historia h using (customer_id) where h.primero >= p_desde),
    'clientes_recurrentes',   (select count(*) from activos a join historia h using (customer_id) where h.primero < p_desde),
    'brechas',                (select count(*) from dias where dia >= p_desde and dia_anterior is not null),
    'dias_entre_lavados',     (select round(avg(dia - dia_anterior), 1) from dias where dia >= p_desde and dia_anterior is not null),
    'vehiculos_activos',      (select count(*) from vehiculos),
    'vehiculos_que_repiten',  (select count(*) from vehiculos where dias > 1),
    'ventas_identificadas',   (select ventas from gasto),
    'retencion',              coalesce((select jsonb_object_agg(dias_n::text, jsonb_build_object('cohorte', cohorte, 'retenidos', retenidos)) from retencion), '{}'::jsonb)
  );
$$;

revoke all on function public.bi_clientes_rango(uuid[], date, date) from public, anon, authenticated;

create or replace function public.bi_clientes(
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
  if p_hasta < p_desde or p_ant_hasta < p_ant_desde or p_hasta - p_desde > 3660 then
    raise exception 'Rango de fechas inválido' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'actual',   public.bi_clientes_rango(v_ramas, p_desde, p_hasta),
    'anterior', public.bi_clientes_rango(v_ramas, p_ant_desde, p_ant_hasta)
  );
end;
$$;

revoke all on function public.bi_clientes(date, date, date, date, uuid) from public, anon;
grant execute on function public.bi_clientes(date, date, date, date, uuid) to authenticated;
