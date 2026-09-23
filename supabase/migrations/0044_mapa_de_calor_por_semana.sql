-- ============================================================
-- Migration: 0044_mapa_de_calor_por_semana.sql
-- Description: El mapa de calor deja de apilar todas las semanas.
--
-- EL PROBLEMA
--   v_plc_heatmap (0041) agrupa por día de la semana y hora SIN ventana de
--   tiempo. O sea que la fila «Lunes» no es un lunes: es la suma de todos los
--   lunes desde que el carwash existe. Cada semana que pasa, esa celda crece y
--   nunca baja.
--
--   Eso hace dos cosas malas a la vez. El número deja de significar algo —«4»
--   no son cuatro lavados, son cuatro repartidos entre vuelto a saber cuántos
--   lunes— y la escala de color se satura: los días viejos acumulan tanto que
--   el día en curso siempre se ve pálido, justo el que se está mirando.
--
--   Y no se arregla refrescando más seguido, que fue el arreglo anterior: por
--   más fresca que llegue la consulta, sigue sumando el historial entero.
--
-- LA CORRECCIÓN
--   La vista ahora expone `wash_date`, la fecha local del lavado, y agrupa por
--   ella. Cada fila pertenece a UN día concreto, no a una categoría de día.
--
--   Con eso el tablero pide la semana en curso y cada día arranca vacío cuando
--   le toca: el lunes se limpia el lunes, el martes el martes, y la grilla se
--   va llenando a medida que pasa la semana.
--
-- POR QUÉ LA VENTANA NO VA ADENTRO DE LA VISTA
--   Sería más corto escribir «where started_at >= date_trunc('week', now())» y
--   terminar. Pero eso deja una vista que sólo sabe contestar una pregunta:
--   cualquier análisis histórico —comparar esta semana con la anterior, o mirar
--   un mes— tendría que duplicarla. Exponiendo la fecha, el mismo objeto sirve
--   para la semana en curso y para cualquier rango, y quien consulta dice qué
--   quiere.
--
--   El día es el LOCAL de El Salvador, no el UTC. A las 18:00 de un lunes ya es
--   martes en UTC, y con la fecha UTC media tarde de cada día caería en la fila
--   equivocada — justo la mitad ocupada de la jornada.
-- ============================================================

drop view if exists public.v_plc_heatmap cascade;
create view public.v_plc_heatmap as
select
  c.organization_id,
  g.branch_id,
  c.machine_id,
  -- La fecha local del lavado. Es lo que permite pedir un rango y lo que hace
  -- que cada fila sea un día concreto y no una categoría de día.
  (c.started_at at time zone 'America/El_Salvador')::date               as wash_date,
  -- dow de Postgres: 0 = domingo. El tablero reordena para arrancar en lunes.
  extract(dow  from c.started_at at time zone 'America/El_Salvador')::int as day_of_week,
  to_char(c.started_at at time zone 'America/El_Salvador', 'Day')         as day_name,
  extract(hour from c.started_at at time zone 'America/El_Salvador')::int as hour_of_day,
  count(*)                                             as washes,
  count(*) filter (where c.service_type = 'PRO')       as pro,
  count(*) filter (where c.service_type = 'ELITE')     as elite,
  count(*) filter (where c.service_type = 'SIGNATURE') as signature,
  round(avg(c.duration_seconds))::int                  as avg_seconds
from public.plc_wash_cycles c
left join public.plc_gateways g
       on g.organization_id = c.organization_id
      and g.gateway_id = c.gateway_id
where public.corsa_cuenta_como_lavado(c.status)
group by 1, 2, 3, 4, 5, 6, 7;

comment on view public.v_plc_heatmap is
  'Lavados por día y hora, en hora de El Salvador. Una fila por fecha concreta: quien consulta elige el rango. Mide uso de las máquinas, no facturación.';
comment on column public.v_plc_heatmap.wash_date is
  'Fecha LOCAL del lavado. Filtrar por acá para pedir una semana; sin filtro se suma todo el historial y el mapa deja de significar algo.';

grant select on public.v_plc_heatmap to authenticated, service_role;
