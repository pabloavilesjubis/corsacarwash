-- ============================================================
-- Migration: 0037_dia_local_y_conteo_de_lavados.sql
-- Description: Dos problemas que daban números equivocados sin fallar nunca.
--
--   1. EL DÍA. «Hoy» significaba cosas distintas según dónde se preguntara:
--      UTC en la base, la zona del dispositivo en el navegador, El Salvador en
--      algunas vistas. Acá el día del negocio queda definido en un solo lugar
--      y el servidor deja de pensar en UTC.
--
--   2. EL CONTEO. Un lavado terminado que el gateway no alcanzó a confirmar no
--      se contaba. El PLC pulsa M18 al terminar y el gateway lee una vez por
--      segundo: si el pulso dura menos, nadie lo ve, y un lavado real quedaba
--      registrado como interrumpido. Acá se decide por duración, que es el
--      dato que sí está siempre.
--
--   De paso, lo segundo obliga a algo que el negocio quería igual: aprender
--   cuánto dura cada programa de cada máquina. Son tres —corto, intermedio y
--   completo con encerado— y los tiempos difieren entre máquinas, así que no
--   se pueden escribir a mano: se deducen de lo que la máquina ya hizo.
-- ============================================================


-- ═════════════════════════════════════════════════════════════
-- PARTE 1 — EL DÍA DEL CARWASH
-- ═════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1.1 La zona del servidor
--
--     Postgres en Supabase viene en UTC. Eso hace que `current_date`, los
--     casteos `::date` y `date_trunc` sobre un timestamptz respondan en un día
--     que acá empieza a las 6 de la tarde. Ninguna de esas expresiones falla:
--     todas devuelven un número, sólo que del día equivocado, y ese es
--     exactamente el tipo de error que nadie encuentra hasta que un total no
--     cuadra.
--
--     Poner la zona del negocio como la del servidor arregla de una vez todo
--     lo que quedó escrito con `current_date` —antigüedad de cuentas por
--     cobrar, vencimientos de membresías, vigencia de precios— sin tener que
--     reescribir cada consulta ni acordarse de la regla cada vez que se
--     escribe una nueva.
--
--     OJO: aplica a conexiones NUEVAS. Las que ya están abiertas (el pool de
--     PostgREST) siguen en UTC hasta que se reciclen o se reinicie el proyecto.
--     Por eso nada de lo que sigue depende de este ajuste: es el cinturón,
--     no los tirantes.
-- ─────────────────────────────────────────────
do $$
begin
  execute format('alter database %I set timezone to %L',
                 current_database(), 'America/El_Salvador');
exception when insufficient_privilege then
  -- Si el rol que corre la migración no es dueño de la base, el resto de la
  -- migración sigue siendo correcto: todo lo de abajo convierte la zona
  -- explícitamente.
  raise notice 'Sin privilegios para fijar la zona de la base; se deja en UTC.';
end $$;


-- ─────────────────────────────────────────────
-- 1.2 El día, en funciones
--
--     `corsa_inicio_del_dia()` existía sin parámetros. Agregarle uno con valor
--     por defecto haría ambigua la llamada sin argumentos («function is not
--     unique»), así que se la reemplaza. Las vistas que la usaban se vuelven a
--     crear más abajo.
-- ─────────────────────────────────────────────
drop view if exists public.v_plc_machines cascade;
drop view if exists public.v_plc_gateway_status cascade;
drop view if exists public.v_plc_production_daily cascade;
drop view if exists public.v_plc_production_hourly cascade;
drop view if exists public.v_plc_faults cascade;
drop view if exists public.v_plc_availability cascade;
-- Vista nueva de esta migración; también se dropea para que 0037 se pueda
-- volver a correr entera sin chocar con lo que dejó la corrida anterior.
drop view if exists public.v_plc_programas_diarios cascade;

drop function if exists public.corsa_inicio_del_dia();

-- Qué día es hoy en el carwash. Todo lo que sea una columna `date` sale de acá.
create or replace function public.corsa_hoy()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/El_Salvador')::date
$$;

comment on function public.corsa_hoy() is
  'El día de hoy en El Salvador, sin importar en qué zona esté el servidor.';

-- El instante exacto en que empieza ese día. Es lo que se compara contra una
-- columna timestamptz.
--
-- El `::timestamp` del medio no es decorativo: sin él Postgres castea la date a
-- timestamptz (medianoche UTC) y `at time zone` CONVIERTE en vez de
-- INTERPRETAR, devolviendo un instante seis horas corrido. Nada se rompe a la
-- vista; simplemente «hoy» empieza a las 6 de la tarde de ayer.
create or replace function public.corsa_inicio_del_dia(p_fecha date default null)
returns timestamptz
language sql
stable
as $$
  select ((coalesce(p_fecha, public.corsa_hoy()))::timestamp)
           at time zone 'America/El_Salvador'
$$;

comment on function public.corsa_inicio_del_dia(date) is
  'Medianoche de esa fecha (hoy por defecto) en hora de El Salvador.';

-- El límite superior del día: la medianoche siguiente. Siempre exclusivo, que
-- es lo que evita el lavado de las 23:59:59.7 contado dos veces o ninguna.
create or replace function public.corsa_fin_del_dia(p_fecha date default null)
returns timestamptz
language sql
stable
as $$
  select public.corsa_inicio_del_dia(coalesce(p_fecha, public.corsa_hoy()) + 1)
$$;

-- La app lee las vistas como el usuario que inició sesión, y las vistas llaman
-- a estas funciones. Sin el permiso, el tablero fallaría con «permission
-- denied» en lugar de mostrar los lavados. No exponen nada: devuelven una hora.
grant execute on function public.corsa_hoy()                     to anon, authenticated, service_role;
grant execute on function public.corsa_inicio_del_dia(date)      to anon, authenticated, service_role;
grant execute on function public.corsa_fin_del_dia(date)         to anon, authenticated, service_role;


-- ─────────────────────────────────────────────
-- 1.3 Los valores por defecto que eran UTC
--
--     Un gasto cargado a las 7 de la noche se guardaba con la fecha de mañana.
--     La zona del servidor (1.1) ya lo arreglaría, pero dejarlo escrito acá
--     hace que siga siendo correcto aunque alguien revierta aquel ajuste.
-- ─────────────────────────────────────────────
alter table public.service_prices            alter column effective_from set default public.corsa_hoy();
alter table public.customer_price_agreements alter column effective_from set default public.corsa_hoy();
alter table public.payable_payments          alter column payment_date   set default public.corsa_hoy();
alter table public.goods_receipts            alter column receipt_date   set default public.corsa_hoy();
alter table public.expenses                  alter column expense_date   set default public.corsa_hoy();
alter table public.bank_deposits             alter column deposit_date   set default public.corsa_hoy();


-- ═════════════════════════════════════════════════════════════
-- PARTE 2 — LOS PROGRAMAS DE LAVADO
--
--   Cada máquina corre tres programas: corto, intermedio y completo con
--   encerado. Duran distinto, y entre las dos máquinas también difieren. El
--   PLC no dice cuál corrió —sólo «empezó» y «terminó»— así que la duración es
--   la única evidencia disponible, y alcanza: los tres programas se separan
--   por minutos, no por segundos.
--
--   Por qué se aprende y no se configura: un número escrito a mano envejece
--   —se cambia un cepillo, se ajusta el ciclo— y nadie se acuerda de venir a
--   corregirlo. Lo que la máquina hizo ayer no envejece.
-- ═════════════════════════════════════════════════════════════

create table if not exists public.plc_machine_programs (
  organization_id  uuid        not null references public.organizations(id) on delete cascade,
  machine_id       text        not null,

  -- 1 es el más corto. El orden es la identidad del programa: es lo único que
  -- se mantiene estable aunque los tiempos se corran.
  rango            int         not null check (rango between 1 and 3),
  etiqueta         text        not null,

  centro_segundos  int         not null,
  min_segundos     int         not null,
  max_segundos     int         not null,
  muestras         int         not null,

  actualizado_at   timestamptz not null default now(),

  primary key (organization_id, machine_id, rango)
);

comment on table public.plc_machine_programs is
  'Los programas de cada máquina, deducidos de la duración de los lavados que sí se confirmaron. Se recalcula solo, una vez por día.';

alter table public.plc_machine_programs enable row level security;

drop policy if exists "plc_machine_programs_select" on public.plc_machine_programs;
create policy "plc_machine_programs_select"
  on public.plc_machine_programs for select
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('plc.read'));


-- ─────────────────────────────────────────────
-- 2.1 Aprender los programas de una máquina
--
--     Se agrupa por cortes naturales, no por k-means: las duraciones de un
--     mismo programa se amontonan en unos pocos segundos y entre programas hay
--     minutos de diferencia, así que los huecos grandes en la lista ordenada
--     SON las fronteras. Un método que fuerza tres grupos partiría en tres un
--     programa único cuando todavía no se usaron los otros dos; éste, si no
--     hay huecos, devuelve un solo grupo, que es la verdad.
--
--     Sólo se aprende de ciclos COMPLETED: los confirmados por M18. Aprender
--     de los que este mismo módulo dedujo sería enseñarle al sistema sus
--     propias suposiciones.
-- ─────────────────────────────────────────────
create or replace function public.corsa_aprender_programas(
  p_org     uuid,
  p_machine text
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s          int[];
  v_n          int;
  v_min_grupo  int;
  v_cortes     int[] := '{}';
  v_i          int;
  v_prop       int[];
  v_ok         boolean;
  v_ini        int;
  v_fin        int;
  v_k          int;
  v_grupo      int[];
  v_etiquetas  text[];
  v_grupos     int;
begin
  select array_agg(duration_seconds order by duration_seconds)
    into v_s
    from public.plc_wash_cycles
   where organization_id = p_org
     and machine_id = p_machine
     and status = 'COMPLETED'
     and duration_seconds is not null
     and duration_seconds > 0
     and started_at > now() - interval '120 days';

  v_n := coalesce(array_length(v_s, 1), 0);

  -- Con menos de doce lavados cualquier corte es ruido. Se prefiere no tener
  -- perfil —y usar el piso fijo de más abajo— antes que inventar uno.
  if v_n < 12 then
    return 0;
  end if;

  -- Ningún programa real deja menos de una décima parte de los lavados del
  -- período. Un grupo más chico que eso es un ciclo que se trabó, no un
  -- programa.
  v_min_grupo := greatest(3, (v_n / 10)::int);

  -- Candidatos a frontera, del hueco más grande al más chico. El umbral es
  -- relativo: 15% del valor, con un piso de 15 segundos para que en ciclos
  -- cortos no alcance con cualquier diferencia.
  for v_i in
    select i
      from generate_series(1, v_n - 1) i
     where v_s[i + 1] - v_s[i] >= greatest(15, (v_s[i] * 0.15)::int)
     order by v_s[i + 1] - v_s[i] desc, i
  loop
    exit when coalesce(array_length(v_cortes, 1), 0) >= 2;

    -- Se acepta el corte sólo si los grupos que quedan siguen siendo creíbles.
    select array_agg(x order by x) into v_prop from unnest(v_cortes || v_i) x;

    v_ok := true;
    v_ini := 0;
    foreach v_k in array (v_prop || v_n) loop
      if v_k - v_ini < v_min_grupo then v_ok := false; end if;
      v_ini := v_k;
    end loop;

    if v_ok then
      v_cortes := v_prop;
    end if;
  end loop;

  v_grupos := coalesce(array_length(v_cortes, 1), 0) + 1;

  -- Con un solo grupo no se sabe cuál de los tres programas es: puede ser que
  -- sólo se use uno, o que todavía no haya datos de los otros. Decirlo es más
  -- útil que ponerle un nombre que quizá sea falso.
  v_etiquetas := case v_grupos
    when 1 then array['indeterminado']
    when 2 then array['corto', 'completo']
    else        array['corto', 'intermedio', 'completo']
  end;

  delete from public.plc_machine_programs
   where organization_id = p_org and machine_id = p_machine;

  v_ini := 1;
  for v_k in 1..v_grupos loop
    v_fin := case when v_k > coalesce(array_length(v_cortes, 1), 0)
                  then v_n else v_cortes[v_k] end;
    v_grupo := v_s[v_ini:v_fin];

    insert into public.plc_machine_programs (
      organization_id, machine_id, rango, etiqueta,
      centro_segundos, min_segundos, max_segundos, muestras, actualizado_at
    )
    select
      p_org, p_machine, v_k, v_etiquetas[v_k],
      round(avg(x))::int, min(x), max(x), count(*)::int, now()
    from unnest(v_grupo) x;

    v_ini := v_fin + 1;
  end loop;

  return v_n;
end $$;

comment on function public.corsa_aprender_programas(uuid, text) is
  'Recalcula los programas de una máquina desde sus lavados confirmados. Devuelve cuántas muestras usó (0 = todavía no alcanzan).';

-- Toma la organización como parámetro, así que no se le abre a la app: la
-- corre el Worker, la derivación (que ya es security definer) o quien entre
-- por el SQL Editor.
revoke all on function public.corsa_aprender_programas(uuid, text) from public, anon, authenticated;
grant execute on function public.corsa_aprender_programas(uuid, text) to service_role;


-- ─────────────────────────────────────────────
-- 2.2 El umbral: a partir de cuánto un ciclo fue un lavado
--
--     70% del programa más corto. Un lavado que se interrumpe se corta al
--     principio —el operador ve algo mal y para—, no a un 70% de terminado; y
--     un programa corto que se pasa de revoluciones sigue por encima de ese
--     valor. El 30% de margen absorbe la variación normal entre un ciclo y otro.
--
--     Sin perfil todavía, 60 segundos: suficiente para descartar un arranque
--     en falso y bajo como para no perder ningún lavado real.
-- ─────────────────────────────────────────────
create or replace function public.corsa_umbral_lavado(
  p_org     uuid,
  p_machine text
) returns int
language sql
stable
as $$
  select greatest(45, coalesce(
    (select round(centro_segundos * 0.7)::int
       from public.plc_machine_programs
      where organization_id = p_org and machine_id = p_machine and rango = 1),
    60))
$$;

grant execute on function public.corsa_umbral_lavado(uuid, text) to authenticated, service_role;


-- ─────────────────────────────────────────────
-- 2.3 Qué programa fue un ciclo
--     El de centro más cercano a su duración.
-- ─────────────────────────────────────────────
-- Sin security definer a propósito: leída desde la app, respeta la RLS de
-- plc_machine_programs y cada quien ve su organización. Llamada desde la
-- derivación, que sí es definer, corre con los permisos de aquélla.
create or replace function public.corsa_programa_de(
  p_org      uuid,
  p_machine  text,
  p_segundos int
) returns text
language sql
stable
as $$
  select etiqueta
    from public.plc_machine_programs
   where organization_id = p_org and machine_id = p_machine
     and p_segundos is not null
   order by abs(centro_segundos - p_segundos)
   limit 1
$$;

grant execute on function public.corsa_programa_de(uuid, text, int) to authenticated, service_role;


-- ═════════════════════════════════════════════════════════════
-- PARTE 3 — EL CONTEO
-- ═════════════════════════════════════════════════════════════

alter table public.plc_wash_cycles
  add column if not exists programa text;

comment on column public.plc_wash_cycles.programa is
  'Programa deducido por duración: corto, intermedio o completo. Deducido, no declarado por el PLC.';

-- Un solo lugar define qué cuenta como lavado del día. Cuando mañana aparezca
-- otro estado, se agrega acá y todas las vistas quedan al día solas.
--
--   COMPLETED               → M18 lo confirmó.
--   COMPLETED_WITHOUT_START → llegó el fin sin el inicio (gateway instalado a
--                             mitad de lavado, o arranque perdido).
--   COMPLETED_WITHOUT_SIGNAL→ corrió el ciclo entero y cerró sin falla, pero
--                             el pulso M18 duró menos que el segundo que tarda
--                             el gateway en leer. El lavado ocurrió igual.
create or replace function public.corsa_cuenta_como_lavado(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status in ('COMPLETED', 'COMPLETED_WITHOUT_START', 'COMPLETED_WITHOUT_SIGNAL')
$$;

grant execute on function public.corsa_cuenta_como_lavado(text) to anon, authenticated, service_role;


-- ─────────────────────────────────────────────
-- 3.1 Derivación
--
--     Igual que en 0036, con dos cambios: un WASH_STOPPED que duró lo que dura
--     un lavado se cierra como lavado, y todo cierre queda etiquetado con su
--     programa.
-- ─────────────────────────────────────────────
create or replace function public.plc_derive_from_event(
  p_org        uuid,
  p_gateway    text,
  p_machine    text,
  p_event_id   uuid,
  p_type       text,
  p_at         timestamptz,
  p_payload    jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status   text;
  v_service  text;
  v_open     record;
  v_dur      int;
  v_umbral   int;
  v_cierre   text;
  v_viejo    timestamptz;
begin
  -- ── Qué estado implica este evento ──
  v_status := case p_type
    when 'WASH_STARTED'      then 'WASHING'
    when 'WASH_COMPLETED'    then 'READY'
    when 'WASH_STOPPED'      then 'READY'
    when 'MACHINE_READY'     then 'READY'
    when 'MACHINE_NOT_READY' then 'NOT_READY'
    when 'FAULT_STARTED'     then 'FAULT'
    when 'MACHINE_FAULT'     then 'FAULT'
    when 'FAULT_CLEARED'     then 'READY'
    when 'PLC_DISCONNECTED'  then 'OFFLINE'
    when 'MACHINE_OFFLINE'   then 'OFFLINE'
    when 'PLC_RECONNECTED'   then 'ONLINE'
    when 'MACHINE_ONLINE'    then 'ONLINE'
    else null
  end;

  v_service := nullif(p_payload->'data'->>'service_type', '');

  -- ── Sesiones ──
  if p_type = 'WASH_STARTED' then
    -- Una sesión abierta anterior nunca recibió su cierre: el gateway se
    -- reinició a mitad de lavado, o se perdió el evento. Se marca y se sigue;
    -- dejarla abierta contaminaría para siempre el «¿qué está lavando ahora?».
    update public.plc_wash_cycles
       set status = 'ABANDONED', updated_at = now()
     where organization_id = p_org
       and machine_id = p_machine
       and completed_at is null
       and status not in ('ABANDONED', 'COMPLETED');

    insert into public.plc_wash_cycles (
      id, organization_id, gateway_id, machine_id,
      started_at, status, service_type, source_event_id, source, metadata
    ) values (
      gen_random_uuid(), p_org, p_gateway, p_machine,
      p_at, 'IN_PROGRESS', v_service, p_event_id, 'derived', p_payload->'data'
    )
    on conflict (source_event_id) do nothing;

  elsif p_type in ('WASH_COMPLETED', 'WASH_STOPPED') then
    select * into v_open
      from public.plc_wash_cycles
     where organization_id = p_org
       and machine_id = p_machine
       and completed_at is null
       and started_at <= p_at
       and status = 'IN_PROGRESS'
     order by started_at desc
     limit 1
       for update;

    if found then
      v_dur := greatest(0, extract(epoch from (p_at - v_open.started_at))::int);

      if p_type = 'WASH_COMPLETED' then
        v_cierre := 'COMPLETED';
      else
        -- Acá está el lavado que antes se perdía. El PLC baja M8 y pulsa M18
        -- en el mismo segundo; el gateway lee una vez por segundo, así que un
        -- pulso más corto que eso simplemente no existe para el sistema. Lo
        -- que sí queda es cuánto corrió la máquina, y un ciclo que corrió lo
        -- que dura un programa entero y cerró sin falla es un lavado, lo haya
        -- confirmado M18 o no.
        --
        -- Al revés también importa: un ciclo cortado a los veinte segundos
        -- sigue siendo STOPPED y no se cobra. La duración es lo que separa un
        -- lavado de una interrupción.
        v_umbral := public.corsa_umbral_lavado(p_org, p_machine);
        v_cierre := case when v_dur >= v_umbral
                         then 'COMPLETED_WITHOUT_SIGNAL' else 'STOPPED' end;
      end if;

      update public.plc_wash_cycles
         set completed_at = p_at,
             duration_seconds = v_dur,
             status = v_cierre,
             completion_event_id = p_event_id,
             service_type = coalesce(service_type, v_service),
             -- Sólo se etiqueta lo que fue un lavado. Ponerle «corto» a un
             -- ciclo que se cortó a los veinte segundos sería nombrar un
             -- programa que nadie corrió.
             programa = case when public.corsa_cuenta_como_lavado(v_cierre)
                             then public.corsa_programa_de(p_org, p_machine, v_dur) end,
             updated_at = now()
       where id = v_open.id;

    elsif p_type = 'WASH_COMPLETED' then
      -- Al terminar un lavado el PLC baja M8 y pulsa M18 en el mismo segundo:
      -- llegan WASH_STOPPED y WASH_COMPLETED juntos, y el orden entre ellos no
      -- está garantizado. Si el STOPPED se procesó primero, la sesión ya está
      -- cerrada y este COMPLETED parecería huérfano — creando una SEGUNDA
      -- sesión para el mismo lavado. Contarlo dos veces es peor que cualquier
      -- otro error de este módulo, así que acá se busca la sesión recién
      -- cerrada y se la corrige en lugar de crear otra.
      --
      -- La búsqueda incluye COMPLETED_WITHOUT_SIGNAL: ese estado es el mismo
      -- cierre visto sin la confirmación, y si la confirmación llega después
      -- hay que ASCENDER esa fila, no abrir otra. Sin esto, la regla nueva de
      -- arriba duplicaría justamente lo que vino a arreglar.
      select * into v_open
        from public.plc_wash_cycles
       where organization_id = p_org
         and machine_id = p_machine
         and status in ('STOPPED', 'COMPLETED_WITHOUT_SIGNAL')
         and completed_at between p_at - interval '10 minutes' and p_at + interval '10 minutes'
       order by completed_at desc
       limit 1
         for update;

      if found then
        v_viejo := greatest(v_open.completed_at, p_at);
        v_dur := greatest(0, extract(epoch from (v_viejo - v_open.started_at))::int);

        update public.plc_wash_cycles
           set status = 'COMPLETED',
               completed_at = v_viejo,
               duration_seconds = v_dur,
               completion_event_id = p_event_id,
               service_type = coalesce(service_type, v_service),
               programa = public.corsa_programa_de(p_org, p_machine, v_dur),
               updated_at = now()
         where id = v_open.id;
      else
      -- Llegó un fin sin su inicio: el gateway se instaló a mitad de lavado, o
      -- el evento de arranque se perdió. Se registra el lavado igual, sin
      -- duración. Perder la cuenta de un lavado real es peor que tener una
      -- sesión sin hora de inicio, y el estado queda explícito en el status.
      insert into public.plc_wash_cycles (
        id, organization_id, gateway_id, machine_id,
        started_at, completed_at, status, service_type,
        source_event_id, completion_event_id, source, metadata
      ) values (
        gen_random_uuid(), p_org, p_gateway, p_machine,
        p_at, p_at, 'COMPLETED_WITHOUT_START', v_service,
        p_event_id, p_event_id, 'derived', p_payload->'data'
      )
      on conflict (source_event_id) do nothing;
      end if;
    end if;

    -- El perfil de programas se mantiene solo. Se recalcula a lo sumo una vez
    -- por día y por máquina, al cerrar un lavado: un cron más para vigilar, en
    -- un sistema que corre sin nadie mirándolo, es una pieza que se va a
    -- romper en silencio.
    if not exists (
      select 1 from public.plc_machine_programs
       where organization_id = p_org and machine_id = p_machine
         and actualizado_at > now() - interval '1 day'
    ) then
      perform public.corsa_aprender_programas(p_org, p_machine);
    end if;

  elsif p_type in ('FAULT_STARTED', 'MACHINE_FAULT') then
    -- Una falla interrumpe el lavado en curso.
    update public.plc_wash_cycles
       set status = 'FAULTED', completed_at = p_at,
           duration_seconds = greatest(0, extract(epoch from (p_at - started_at))::int),
           updated_at = now()
     where organization_id = p_org
       and machine_id = p_machine
       and completed_at is null
       and status = 'IN_PROGRESS';
  end if;

  -- ── Estado actual ──

  -- Una máquina en falla también está «no lista», así que M13↑ y M14↓ llegan
  -- casi juntos. Si MACHINE_NOT_READY pisara a FAULT, el tablero diría «no
  -- lista» de una máquina averiada: pierde justo el dato que hace falta para
  -- ir a atenderla. La falla manda hasta que se limpie.
  if p_type in ('MACHINE_NOT_READY') and exists (
       select 1 from public.plc_machine_status
        where organization_id = p_org and machine_id = p_machine
          and status = 'FAULT') then
    v_status := null;
  end if;

  -- La condición del where es lo que hace esto seguro ante reenvíos: un
  -- evento más viejo que el último aplicado no puede retroceder el estado.
  if v_status is not null then
    insert into public.plc_machine_status as s (
      organization_id, machine_id, gateway_id, status,
      current_service, last_event_type, last_event_timestamp, updated_at
    ) values (
      p_org, p_machine, p_gateway, v_status,
      v_service, p_type, p_at, now()
    )
    on conflict (organization_id, machine_id) do update
       set status               = excluded.status,
           current_service      = coalesce(excluded.current_service, s.current_service),
           last_event_type      = excluded.last_event_type,
           last_event_timestamp = excluded.last_event_timestamp,
           gateway_id           = excluded.gateway_id,
           updated_at           = now()
     where excluded.last_event_timestamp >= s.last_event_timestamp;
  end if;

  -- SERVICE_SELECTED no cambia el estado, sólo qué se está por lavar.
  if p_type = 'SERVICE_SELECTED' and v_service is not null then
    update public.plc_machine_status
       set current_service = v_service, updated_at = now()
     where organization_id = p_org and machine_id = p_machine
       and last_event_timestamp <= p_at;
  end if;
end $$;

revoke all on function public.plc_derive_from_event(uuid, text, text, uuid, text, timestamptz, jsonb) from public, anon, authenticated;


-- ─────────────────────────────────────────────
-- 3.2 Reclasificar lo ya registrado
--
--     Los ciclos guardados antes de esta migración se cerraron con la regla
--     vieja. Ésta los vuelve a evaluar con el perfil aprendido, que es también
--     la forma de recuperar los lavados que ya se habían perdido de la cuenta.
--
--     Nunca toca un COMPLETED: lo que M18 confirmó no se revisa. Sólo mira los
--     STOPPED —que pueden ascender— y los COMPLETED_WITHOUT_SIGNAL —que pueden
--     volver a bajar si el perfil dice que aquel ciclo fue demasiado corto.
-- ─────────────────────────────────────────────
create or replace function public.corsa_reclasificar_lavados(
  p_desde date default null
) returns table (maquina text, ascendidos int, degradados int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_desde timestamptz := public.corsa_inicio_del_dia(
                           coalesce(p_desde, public.corsa_hoy() - 90));
  v_m     record;
  v_up    int;
  v_down  int;
begin
  for v_m in
    select distinct organization_id, machine_id
      from public.plc_wash_cycles
     where started_at >= v_desde
  loop
    perform public.corsa_aprender_programas(v_m.organization_id, v_m.machine_id);

    with cambio as (
      update public.plc_wash_cycles c
         set status = 'COMPLETED_WITHOUT_SIGNAL',
             programa = public.corsa_programa_de(
                          c.organization_id, c.machine_id, c.duration_seconds),
             updated_at = now()
       where c.organization_id = v_m.organization_id
         and c.machine_id = v_m.machine_id
         and c.started_at >= v_desde
         and c.status = 'STOPPED'
         and c.duration_seconds >= public.corsa_umbral_lavado(
                                     c.organization_id, c.machine_id)
      returning 1
    )
    select count(*) into v_up from cambio;

    with cambio as (
      update public.plc_wash_cycles c
         set status = 'STOPPED', programa = null, updated_at = now()
       where c.organization_id = v_m.organization_id
         and c.machine_id = v_m.machine_id
         and c.started_at >= v_desde
         and c.status = 'COMPLETED_WITHOUT_SIGNAL'
         and c.duration_seconds < public.corsa_umbral_lavado(
                                    c.organization_id, c.machine_id)
      returning 1
    )
    select count(*) into v_down from cambio;

    -- La etiqueta de programa se refresca para todo lo que sí es un lavado,
    -- incluidos los que ya estaban bien contados: el perfil de hoy es mejor
    -- que el del día en que se cerraron.
    update public.plc_wash_cycles c
       set programa = public.corsa_programa_de(
                        c.organization_id, c.machine_id, c.duration_seconds)
     where c.organization_id = v_m.organization_id
       and c.machine_id = v_m.machine_id
       and c.started_at >= v_desde
       and public.corsa_cuenta_como_lavado(c.status)
       and c.duration_seconds is not null;

    -- Y se le quita a lo que no es un lavado, incluidos los ciclos que esta
    -- misma función acaba de degradar: un ciclo interrumpido no corrió ningún
    -- programa, y dejarle el nombre viejo haría que los totales por programa
    -- no cerraran contra los totales de lavados.
    update public.plc_wash_cycles c
       set programa = null, updated_at = now()
     where c.organization_id = v_m.organization_id
       and c.machine_id = v_m.machine_id
       and c.started_at >= v_desde
       and not public.corsa_cuenta_como_lavado(c.status)
       and c.programa is not null;

    maquina := v_m.machine_id;
    ascendidos := v_up;
    degradados := v_down;
    return next;
  end loop;
end $$;

comment on function public.corsa_reclasificar_lavados(date) is
  'Vuelve a evaluar los ciclos cerrados sin confirmación de M18 con el perfil aprendido. Por defecto, los últimos 90 días.';

revoke all on function public.corsa_reclasificar_lavados(date) from public, anon, authenticated;
grant execute on function public.corsa_reclasificar_lavados(date) to service_role;

-- Y se corre ahora, que es lo que devuelve a la cuenta los lavados que hoy
-- faltan en el tablero.
do $$
declare r record;
begin
  for r in select * from public.corsa_reclasificar_lavados() loop
    raise notice 'Máquina %: % lavados recuperados, % degradados.',
      r.maquina, r.ascendidos, r.degradados;
  end loop;
end $$;


-- ═════════════════════════════════════════════════════════════
-- PARTE 4 — LAS VISTAS, OTRA VEZ
--
--   Se recrean todas: las que perdió el drop de 1.2 y las que agrupaban por
--   día UTC. `started_at::date` sobre un timestamptz devuelve el día de la
--   zona del servidor; el resumen diario le sumaba a mañana todo lo lavado
--   después de las 6 de la tarde. Acá la conversión es explícita, así que
--   sigue siendo correcta aunque el servidor vuelva a UTC.
-- ═════════════════════════════════════════════════════════════

create view public.v_plc_machines as
select
  m.organization_id,
  m.gateway_id,
  m.machine_code                       as machine_id,
  coalesce(m.name, m.machine_code)     as name,
  m.active,
  m.auto_registered,
  m.last_seen_at,
  s.status,
  s.current_service,
  s.last_event_type,
  s.last_event_timestamp,
  -- Se mide contra last_seen_at, que actualiza el heartbeat cada 30 s, y no
  -- contra el último evento: una máquina puede estar diez minutos sin lavar
  -- nada y estar perfectamente viva. Usar los eventos haría que toda máquina
  -- ociosa apareciera como caída, y entonces el indicador no significaría nada.
  (m.last_seen_at is not null
   and m.last_seen_at > now() - interval '5 minutes') as reporting,
  (select count(*) from public.plc_wash_cycles c
    where c.organization_id = m.organization_id
      and c.machine_id = m.machine_code
      and public.corsa_cuenta_como_lavado(c.status)
      and c.started_at >= public.corsa_inicio_del_dia()
      and c.started_at <  public.corsa_fin_del_dia())            as washes_today,
  -- En curso ahora mismo. Sin esto, una máquina lavando parece una máquina
  -- que no lavó: el ciclo todavía no cuenta y no hay dónde verlo.
  (select count(*) from public.plc_wash_cycles c
    where c.organization_id = m.organization_id
      and c.machine_id = m.machine_code
      and c.status = 'IN_PROGRESS')                              as washes_in_progress,
  -- Ciclos de hoy que corrieron pero no llegaron a ser un lavado. Si este
  -- número crece, hay algo que atender en la máquina.
  (select count(*) from public.plc_wash_cycles c
    where c.organization_id = m.organization_id
      and c.machine_id = m.machine_code
      and c.status in ('STOPPED', 'FAULTED', 'ABANDONED')
      and c.started_at >= public.corsa_inicio_del_dia()
      and c.started_at <  public.corsa_fin_del_dia())            as interrupted_today
from public.plc_machines m
left join public.plc_machine_status s
       on s.organization_id = m.organization_id
      and s.machine_id = m.machine_code;

-- Producción por hora. La base de «¿a qué hora trabajamos más?».
create view public.v_plc_production_hourly as
select
  organization_id,
  gateway_id,
  machine_id,
  date_trunc('hour', started_at at time zone 'America/El_Salvador') as hour,
  count(*) filter (where public.corsa_cuenta_como_lavado(status))   as washes,
  count(*) filter (where status = 'FAULTED')          as faulted,
  count(*) filter (where status = 'ABANDONED')        as abandoned,
  round(avg(duration_seconds) filter (
    where status = 'COMPLETED' and duration_seconds > 0))::int as avg_seconds,
  min(duration_seconds) filter (where status = 'COMPLETED' and duration_seconds > 0) as min_seconds,
  max(duration_seconds) filter (where status = 'COMPLETED') as max_seconds
from public.plc_wash_cycles
group by 1, 2, 3, 4;

-- Producción por día, con el programa más corrido.
create view public.v_plc_production_daily as
select
  organization_id,
  gateway_id,
  machine_id,
  (started_at at time zone 'America/El_Salvador')::date           as day,
  count(*) filter (where public.corsa_cuenta_como_lavado(status)) as washes,
  count(*) filter (where status = 'COMPLETED')                    as washes_confirmados,
  -- Cuántos de los del día se contaron por duración porque el gateway no vio
  -- el pulso. Si esto se dispara, el que hay que revisar es el gateway.
  count(*) filter (where status = 'COMPLETED_WITHOUT_SIGNAL')     as washes_sin_pulso,
  count(*) filter (where status = 'FAULTED')                      as faulted,
  count(*) filter (where status = 'STOPPED')                      as interrupted,
  round(avg(duration_seconds) filter (
    where status = 'COMPLETED' and duration_seconds > 0))::int     as avg_seconds,
  sum(duration_seconds) filter (where status = 'COMPLETED')        as busy_seconds,
  mode() within group (order by programa)                          as top_program,
  mode() within group (order by service_type)                      as top_service
from public.plc_wash_cycles
group by 1, 2, 3, 4;

-- Cuántos lavados de cada programa, por día y máquina. Es la respuesta a «qué
-- se vende de verdad», que hasta ahora sólo se sabía por lo que se facturó.
create view public.v_plc_programas_diarios as
select
  c.organization_id,
  c.machine_id,
  (c.started_at at time zone 'America/El_Salvador')::date as day,
  coalesce(c.programa, 'sin_clasificar')                  as programa,
  count(*)                                                as washes,
  round(avg(c.duration_seconds))::int                     as avg_seconds
from public.plc_wash_cycles c
where public.corsa_cuenta_como_lavado(c.status)
group by 1, 2, 3, 4;

comment on view public.v_plc_programas_diarios is
  'Lavados por programa deducido. El programa sale de la duración, no de lo que declare el PLC.';

-- Fallas: cuándo empezó cada una y cuánto duró hasta que se limpió.
create view public.v_plc_faults as
select
  e.organization_id,
  e.gateway_id,
  e.machine_id,
  e.id                                                as event_id,
  e.event_timestamp                                   as started_at,
  (select min(c.event_timestamp)
     from public.plc_machine_events c
    where c.organization_id = e.organization_id
      and c.machine_id = e.machine_id
      and c.event_type in ('FAULT_CLEARED', 'MACHINE_READY')
      and c.event_timestamp > e.event_timestamp)      as cleared_at,
  extract(epoch from (
    (select min(c.event_timestamp)
       from public.plc_machine_events c
      where c.organization_id = e.organization_id
        and c.machine_id = e.machine_id
        and c.event_type in ('FAULT_CLEARED', 'MACHINE_READY')
        and c.event_timestamp > e.event_timestamp) - e.event_timestamp))::int as downtime_seconds
from public.plc_machine_events e
where e.event_type in ('FAULT_STARTED', 'MACHINE_FAULT');

-- Disponibilidad diaria: cuánto del tiempo la máquina estuvo utilizable.
create view public.v_plc_availability as
select
  organization_id,
  gateway_id,
  machine_id,
  day,
  down_seconds,
  86400 - down_seconds                                as up_seconds,
  round(100.0 * (86400 - down_seconds) / 86400, 2)    as availability_pct
from (
  select
    organization_id, gateway_id, machine_id,
    (started_at at time zone 'America/El_Salvador')::date  as day,
    least(86400, coalesce(sum(downtime_seconds), 0))::int  as down_seconds
  from public.v_plc_faults
  where cleared_at is not null
  group by 1, 2, 3, 4
) f;

comment on view public.v_plc_availability is
  'Disponibilidad por día. Sólo cuenta fallas ya resueltas: una falla abierta no tiene duración conocida todavía.';

create view public.v_plc_gateway_status as
select
  g.id,
  g.organization_id,
  g.gateway_id,
  g.name,
  g.branch_id,
  g.location,
  g.active,
  g.last_seen_at,
  g.last_version,
  g.pending_events,
  (g.last_seen_at is not null and g.last_seen_at > now() - interval '3 minutes') as online,
  (select count(*) from public.plc_machine_events e
    where e.organization_id = g.organization_id and e.gateway_id = g.gateway_id
      and e.event_timestamp >= public.corsa_inicio_del_dia()
      and e.event_timestamp <  public.corsa_fin_del_dia())      as events_today,
  (select count(*) from public.plc_wash_cycles c
    where c.organization_id = g.organization_id and c.gateway_id = g.gateway_id
      and public.corsa_cuenta_como_lavado(c.status)
      and c.started_at >= public.corsa_inicio_del_dia()
      and c.started_at <  public.corsa_fin_del_dia())           as washes_today,
  (select count(*) from public.plc_machines m
    where m.organization_id = g.organization_id and m.gateway_id = g.gateway_id
      and m.active)                                             as machines
from public.plc_gateways g;

comment on view public.v_plc_gateway_status is
  'Estado de cada gateway: si está vivo, su versión y la actividad del día.';

-- ─────────────────────────────────────────────
-- Permisos de lectura
--
--     Supabase ya concede select por defecto sobre lo nuevo del esquema
--     public, pero dejarlo escrito evita que el tablero dependa de una
--     configuración que no controlamos: sin esto, el día que esos defaults
--     cambien, las tarjetas fallan con «permission denied».
--     Qué ve cada usuario lo sigue decidiendo la RLS de las tablas.
-- ─────────────────────────────────────────────
grant select on public.plc_machine_programs        to authenticated, service_role;
grant select on public.v_plc_machines              to authenticated, service_role;
grant select on public.v_plc_production_daily      to authenticated, service_role;
grant select on public.v_plc_production_hourly     to authenticated, service_role;
grant select on public.v_plc_programas_diarios     to authenticated, service_role;
grant select on public.v_plc_faults                to authenticated, service_role;
grant select on public.v_plc_availability          to authenticated, service_role;
grant select on public.v_plc_gateway_status        to authenticated, service_role;
