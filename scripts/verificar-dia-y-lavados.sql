-- ============================================================
-- Verificación diaria: el día local, el conteo y el servicio detectado.
--
-- Pegar completo en el SQL Editor de Supabase. Cada bloque comprueba una cosa
-- y dice qué tiene que verse. Cubre las migraciones 0037 y 0038.
-- ============================================================

-- ── 1. ¿Qué día cree la base que es? ──
--
-- `inicio` y `fin` tienen que ser la medianoche de HOY y la de mañana en hora
-- de El Salvador. `zona_del_servidor` debería decir America/El_Salvador; si
-- todavía dice UTC es que el pool de conexiones no se recicló, y no importa:
-- las funciones convierten explícitamente y dan lo mismo igual.
select
  now() at time zone 'America/El_Salvador'  as ahora_aca,
  public.corsa_hoy()                        as hoy,
  public.corsa_inicio_del_dia()             as inicio,
  public.corsa_fin_del_dia()                as fin,
  current_setting('TimeZone')               as zona_del_servidor;


-- ── 2. Los límites vigentes por máquina ──
--
-- La fila '*' vale para toda la organización; una fila con el código de una
-- máquina manda sobre ella. Debajo de `min_valid` no hubo lavado; encima de
-- `max_valid` hubo lavado pero no se clasifica.
select
  m.machine_code                          as maquina,
  r.min_valid                             as minimo_valido,
  r.pro_max                               as pro_hasta,
  r.elite_max                             as elite_hasta,
  r.max_valid                             as maximo_valido
from public.plc_machines m
cross join lateral public.corsa_reglas_de_servicio(m.organization_id, m.machine_code) r
where m.active
order by 1;

-- Lo que hay configurado, tal cual está guardado.
select machine_id, min_valid_seconds, pro_max_seconds, elite_max_seconds,
       max_valid_seconds, notas,
       updated_at at time zone 'America/El_Salvador' as actualizado
from public.plc_service_rules
order by machine_id;


-- ── 3. Los ciclos de hoy, uno por uno ──
--
-- Cómo leer `status`:
--   COMPLETED                 → M18 lo confirmó
--   COMPLETED_WITHOUT_SIGNAL  → corrió completo y cerró sin falla, pero la
--                               señal de fin no se vio. Cuenta: el lavado pasó
--   COMPLETED_WITHOUT_START   → llegó el fin sin el inicio. Cuenta
--   IN_PROGRESS               → está lavando ahora mismo
--   STOPPED                   → se cortó antes del mínimo válido. NO cuenta
--   FAULTED / ABANDONED       → falla, o lavado nuevo encima. NO cuentan
--
-- Y `closed_by` dice con qué evidencia se cerró:
--   WASH_COMPLETED (M18) > WASH_STOPPED (M8) > MACHINE_READY (inferido)
select
  machine_id,
  started_at   at time zone 'America/El_Salvador' as inicio_local,
  completed_at at time zone 'America/El_Salvador' as fin_local,
  duration_seconds,
  status,
  closed_by,
  service_type,
  service_detection_method as metodo,
  service_confidence       as confianza,
  case when public.corsa_cuenta_como_lavado(status) then 'sí' else 'NO' end as cuenta
from public.plc_wash_cycles
where started_at >= public.corsa_inicio_del_dia()
  and started_at <  public.corsa_fin_del_dia()
order by machine_id, started_at;


-- ── 4. Lo que muestra la tarjeta del tablero ──
-- `washes_today` es el número grande, y PRO + ELITE + SIGNATURE + sin
-- clasificar tiene que dar exactamente ese número.
select machine_id, name, status, washes_today,
       pro_today, elite_today, signature_today, unknown_today,
       avg_seconds_today, washes_in_progress, interrupted_today, reporting
from public.v_plc_machines
order by machine_id;


-- ── 5. Validación diaria por servicio ──
select machine_id, service_type, washes, avg_seconds, min_seconds, max_seconds,
       baja_confianza
from public.v_plc_servicios_diarios
where day = public.corsa_hoy()
order by machine_id, service_type;


-- ── 6. ¿Hay que recalibrar los límites? ──
--
-- Compara lo que dicen los datos de los últimos 90 días contra los límites
-- configurados. Qué mirar:
--   · `separacion_seg` es el hueco entre el lavado más largo de un servicio y
--     el más corto del siguiente. Si se acerca a cero o queda negativo, los
--     servicios se solapan y el límite del medio quedó mal puesto.
--   · Si `min_seconds` de PRO está pegado a `min_valid`, hay lavados reales a
--     punto de dejar de contarse: bajar el mínimo.
--   · Muchos UNKNOWN con duraciones parecidas entre sí = un cuarto programa,
--     o un límite que se quedó corto.
select machine_id, service_type, washes,
       min_seconds, avg_seconds, max_seconds, separacion_seg,
       min_valid, pro_max, elite_max, max_valid
from public.v_plc_calibracion_servicios
order by machine_id, avg_seconds;


-- ── 7. Cuánta evidencia directa tiene el conteo ──
--
-- `washes_confirmados` son los que confirmó M18. `washes_sin_pulso` y
-- `cerrados_por_ready` se contaron por duración. Que haya algunos es normal —
-- el pulso dura menos que el segundo que tarda el gateway en leer—, pero si
-- son la mayoría, lo que hay que revisar es el gateway o el ancho del pulso
-- en el PLC, no el conteo.
select machine_id, day, washes, washes_confirmados, washes_sin_pulso,
       cerrados_por_ready, interrupted, faulted,
       pro, elite, signature, unknown, avg_seconds
from public.v_plc_production_daily
where day >= public.corsa_hoy() - 7
order by machine_id, day desc;


-- ── 8. Lavados por hora, hoy ──
select date_trunc('hour', hour) as hora_local, sum(washes) as lavados,
       sum(pro) as pro, sum(elite) as elite, sum(signature) as signature
from public.v_plc_production_hourly
where hour >= (public.corsa_hoy())::timestamp
  and hour <  (public.corsa_hoy() + 1)::timestamp
group by 1
order by 1;


-- ══ MANTENIMIENTO — descomentar sólo cuando haga falta ══

-- Cerrar ciclos que quedaron abiertos, con la evidencia de los eventos.
-- Segura de repetir: sólo mira ciclos sin hora de cierre.
-- select * from public.corsa_cerrar_ciclos_huerfanos();

-- Volver a decidir qué cuenta y reclasificar el servicio con los límites
-- vigentes. Se corre DESPUÉS de cambiar plc_service_rules.
-- select * from public.corsa_reclasificar_lavados();

-- Cambiar los límites de una máquina (ejemplo):
-- insert into public.plc_service_rules (
--   organization_id, machine_id,
--   min_valid_seconds, pro_max_seconds, elite_max_seconds, max_valid_seconds, notas)
-- select organization_id, 'machine-2', 190, 300, 420, 700, 'Recalibrado con 60 días de datos'
--   from public.plc_machines where machine_code = 'machine-2'
-- on conflict (organization_id, machine_id) do update
--   set min_valid_seconds = excluded.min_valid_seconds,
--       pro_max_seconds   = excluded.pro_max_seconds,
--       elite_max_seconds = excluded.elite_max_seconds,
--       max_valid_seconds = excluded.max_valid_seconds,
--       notas             = excluded.notas,
--       updated_at        = now();
