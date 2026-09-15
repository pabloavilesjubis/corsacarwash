-- ============================================================
-- ¿Por qué las tarjetas muestran 0 lavados?
--
-- Pegar completo en el SQL Editor de Supabase. Cada bloque descarta una
-- causa posible; el que salga raro dice cuál es.
-- ============================================================

-- ── 1. ¿Qué hora cree la base que es? ──
-- Si `inicio_del_dia` no es la medianoche de hoy en El Salvador, el problema
-- es la ventana de tiempo y no los datos.
select
  now()                                            as ahora_utc,
  now() at time zone 'America/El_Salvador'         as ahora_en_el_salvador,
  public.corsa_inicio_del_dia()                    as inicio_del_dia,
  current_setting('TimeZone')                      as zona_del_servidor;


-- ── 2. ¿Qué hay realmente en plc_wash_cycles? ──
-- Acá se ve si los 7 y 5 son lavados completados o algo distinto, y de qué
-- día son.
select
  machine_id,
  status,
  count(*)                                         as cantidad,
  min(started_at at time zone 'America/El_Salvador') as mas_viejo_local,
  max(started_at at time zone 'America/El_Salvador') as mas_nuevo_local,
  count(*) filter (where started_at >= public.corsa_inicio_del_dia()) as caen_en_hoy
from public.plc_wash_cycles
group by machine_id, status
order by machine_id, status;


-- ── 3. ¿Y los eventos crudos? ──
-- Si acá hay WASH_STARTED pero no WASH_COMPLETED, el PLC no está entregando
-- M18 y ningún lavado va a poder cerrarse.
select
  machine_id,
  event_type,
  count(*)                                         as cantidad,
  max(event_timestamp at time zone 'America/El_Salvador') as ultimo_local
from public.plc_machine_events
group by machine_id, event_type
order by machine_id, cantidad desc;


-- ── 4. ¿Coincide la organización? ──
-- La vista cruza plc_machines con plc_wash_cycles por organización y código.
-- Si no coinciden, el conteo da 0 aunque los datos estén.
select
  m.machine_code,
  m.organization_id                                as org_de_la_maquina,
  (select count(distinct c.organization_id) from public.plc_wash_cycles c
    where c.machine_id = m.machine_code)           as orgs_en_los_ciclos,
  (select count(*) from public.plc_wash_cycles c
    where c.machine_id = m.machine_code
      and c.organization_id = m.organization_id)   as ciclos_que_cruzan
from public.plc_machines m
order by m.machine_code;


-- ── 5. Lo que la tarjeta está leyendo ──
select machine_id, name, status, washes_today, reporting, last_seen_at
  from public.v_plc_machines
 order by machine_id;


-- ── 6. Los últimos 15 eventos, en orden ──
-- Para leer la secuencia real de señales de un lavado: si aparece
-- WASH_STARTED seguido de WASH_STOPPED sin WASH_COMPLETED, ahí está.
select
  event_timestamp at time zone 'America/El_Salvador' as hora_local,
  machine_id,
  event_type,
  sequence
from public.plc_machine_events
order by event_timestamp desc
limit 15;
