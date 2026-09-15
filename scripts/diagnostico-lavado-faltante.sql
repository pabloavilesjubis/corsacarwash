-- ============================================================
-- ¿Por qué falta un lavado en la cuenta del día?
--
-- Pegar en el SQL Editor de Supabase. Son dos consultas: la primera dice en
-- qué estado quedó cada ciclo de hoy, la segunda muestra la secuencia de
-- señales para poder leer qué pasó con el que falta.
-- ============================================================

-- ── 1. Todos los ciclos de hoy, contados y no contados ──
--
-- Cómo leer el resultado:
--   COMPLETED / COMPLETED_WITHOUT_START → cuenta
--   IN_PROGRESS  → la máquina está lavando ahora mismo; todavía no terminó
--   STOPPED      → M8 bajó y M18 nunca llegó: el gateway no vio la señal de
--                  «lavado completo», o el ciclo se cortó de verdad
--   ABANDONED    → empezó otro lavado sin que éste cerrara
--   FAULTED      → una falla lo interrumpió
select
  machine_id,
  started_at   at time zone 'America/El_Salvador' as inicio_local,
  completed_at at time zone 'America/El_Salvador' as fin_local,
  status,
  duration_seconds,
  case when status in ('COMPLETED','COMPLETED_WITHOUT_START')
       then 'sí' else 'NO' end                    as cuenta
from public.plc_wash_cycles
where started_at >= public.corsa_inicio_del_dia()
order by machine_id, started_at;


-- ── 2. La secuencia de señales de hoy ──
--
-- Un lavado normal se ve así:
--   WASH_STARTED … WASH_STOPPED … WASH_COMPLETED
--
-- Si en el que falta aparece WASH_STARTED y WASH_STOPPED pero NO
-- WASH_COMPLETED, el PLC pulsó M18 y el gateway no alcanzó a verlo: lee cada
-- segundo, y si el pulso dura menos, se pierde.
select
  event_timestamp at time zone 'America/El_Salvador' as hora_local,
  machine_id,
  event_type,
  sequence
from public.plc_machine_events
where event_timestamp >= public.corsa_inicio_del_dia()
  and event_type like 'WASH%'
order by machine_id, event_timestamp;


-- ── 3. Resumen por máquina ──
select
  machine_id,
  count(*)                                                              as ciclos_totales,
  count(*) filter (where status in ('COMPLETED','COMPLETED_WITHOUT_START')) as contados,
  count(*) filter (where status = 'STOPPED')                            as sin_senal_de_fin,
  count(*) filter (where status = 'IN_PROGRESS')                        as en_curso,
  count(*) filter (where status = 'ABANDONED')                          as abandonados,
  count(*) filter (where status = 'FAULTED')                            as con_falla
from public.plc_wash_cycles
where started_at >= public.corsa_inicio_del_dia()
group by machine_id
order by machine_id;
