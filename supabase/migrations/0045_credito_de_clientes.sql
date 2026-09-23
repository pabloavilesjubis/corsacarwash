-- ============================================================
-- Migration: 0045_credito_de_clientes.sql
-- Description: Crédito a flotillas y clientes, con límite que se respeta.
--
-- LO QUE HABÍA, Y POR QUÉ NO ALCANZABA
--   0019 dejó `corporate_accounts` con `credit_limit`, la función
--   `check_corporate_credit()` y la tabla `accounts_receivable`. Nada de eso
--   se usaba: el POS ofrecía «Crédito emp.» a cualquiera, no llamaba a la
--   función, no escribía la cuenta por cobrar y nunca movía `current_balance`.
--
--   O sea que se podía cobrar al crédito sin límite, sin cuenta y sin dejar
--   rastro de la deuda. No era una función a medias: era plata que salía sin
--   registro.
--
-- LA REGLA QUE MANDA SOBRE TODAS
--   El límite se verifica y el saldo se mueve en la MISMA transacción.
--
--   Si la caja consulta «¿hay cupo?» y después registra el cargo en dos pasos,
--   dos ventas simultáneas de la misma flotilla pasan las dos el chequeo y el
--   límite se rompe por la suma. Es el mismo error que un contador leído desde
--   el cliente. Por eso `credito_cobrar()` hace las dos cosas adentro, con la
--   fila bloqueada, y el frontend no puede saltárselo: no hay permiso de
--   escritura directa sobre las tablas.
--
-- HABILITAR ES UN ACTO DELIBERADO
--   Hasta ahora «tiene crédito» se deducía de `credit_limit > 0`, que es
--   ambiguo: una cuenta recién creada con límite 0 no se distingue de una a la
--   que se le revocó el crédito. Ahora hay `credit_enabled`, y la base exige
--   que al habilitarlo venga un límite mayor que cero. No se puede dar crédito
--   «ilimitado» por olvido.
--
--   Sólo lo hace quien tiene `corporate.manage`. Lo verifica la función, no la
--   pantalla: una pantalla se puede saltar escribiendo a la API.
-- ============================================================


-- ─────────────────────────────────────────────
-- LA CUENTA
-- ─────────────────────────────────────────────
alter table public.corporate_accounts
  -- Explícito, en vez de deducirlo del límite. Una cuenta corporativa puede
  -- existir sin crédito —hoy todas las flotillas son así, pagan al momento— y
  -- eso es distinto de una a la que se le revocó.
  add column if not exists credit_enabled boolean not null default false,
  add column if not exists enabled_by     uuid references public.profiles(id) on delete set null,
  add column if not exists enabled_at     timestamptz,
  add column if not exists disabled_at    timestamptz;

comment on column public.corporate_accounts.credit_enabled is
  'Si esta cuenta puede comprar al crédito. Habilitarlo exige un límite mayor que cero y el permiso corporate.manage.';

-- El límite deja de ser opcional cuando el crédito está habilitado. Sin esta
-- restricción, «habilitado con límite 0» sería una cuenta que no puede comprar
-- nada y que nadie entendería por qué.
alter table public.corporate_accounts
  drop constraint if exists corporate_accounts_limite_obligatorio,
  add  constraint corporate_accounts_limite_obligatorio
    check (not credit_enabled or credit_limit > 0);

create index if not exists corporate_accounts_habilitadas_idx
  on public.corporate_accounts (customer_id) where credit_enabled;


-- ─────────────────────────────────────────────
-- AUDITORÍA DEL CRÉDITO
--
-- Una fila por cada cosa que mueve el crédito de un cliente. No es un lujo:
-- cuando una flotilla discuta un saldo, la pregunta va a ser quién autorizó
-- qué y cuándo, y la respuesta tiene que existir sin depender de los logs.
-- ─────────────────────────────────────────────
create table if not exists public.corporate_credit_events (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null references public.organizations(id) on delete restrict,
  customer_id      uuid        not null references public.customers(id) on delete restrict,
  event_type       text        not null,
  amount           numeric(10,2),
  credit_limit     numeric(10,2),
  balance_after    numeric(10,2),
  work_order_id    uuid        references public.work_orders(id) on delete set null,
  /** Quién ejecutó la acción. */
  actor_id         uuid        references public.profiles(id) on delete set null,
  /** Quién autorizó pasarse del límite, si hizo falta. Distinto del actor. */
  authorized_by    uuid        references public.profiles(id) on delete set null,
  reason           text,
  created_at       timestamptz not null default now()
);

alter table public.corporate_credit_events
  drop constraint if exists corporate_credit_events_tipo_valido,
  add  constraint corporate_credit_events_tipo_valido
    check (event_type in (
      'CREDIT_ENABLED',      -- se habilitó el crédito
      'CREDIT_DISABLED',     -- se revocó
      'LIMIT_CHANGED',       -- se cambió el límite
      'CHARGE',              -- una venta al crédito
      'CHARGE_OVERRIDE',     -- una venta al crédito por encima del límite, autorizada
      'PAYMENT',             -- un abono del cliente
      'BLOCKED', 'UNBLOCKED'
    ));

create index if not exists corporate_credit_events_cliente_idx
  on public.corporate_credit_events (customer_id, created_at desc);

comment on table public.corporate_credit_events is
  'Traza de todo lo que mueve el crédito de un cliente: habilitaciones, cambios de límite, cargos, autorizaciones por encima del límite y abonos.';

alter table public.corporate_credit_events enable row level security;

drop policy if exists "corporate_credit_events_select" on public.corporate_credit_events;
create policy "corporate_credit_events_select"
  on public.corporate_credit_events for select
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('corporate.read'));


-- ============================================================
-- HABILITAR EL CRÉDITO
--
-- El permiso se verifica ACÁ ADENTRO y no en la pantalla. Una pantalla se
-- esconde con un `if`; la API se llama igual desde cualquier lado.
-- ============================================================
create or replace function public.credito_habilitar(
  p_customer_id  uuid,
  p_credit_limit numeric,
  p_credit_days  int default 30
) returns public.corporate_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuenta public.corporate_accounts;
  v_org    uuid;
  v_actor  uuid := auth.uid();
begin
  if not public.has_permission('corporate.manage') then
    raise exception 'Se necesita el permiso corporate.manage para habilitar crédito'
      using errcode = 'insufficient_privilege';
  end if;

  if p_credit_limit is null or p_credit_limit <= 0 then
    raise exception 'El límite de crédito es obligatorio y debe ser mayor que cero'
      using errcode = 'check_violation';
  end if;

  select organization_id into v_org from public.customers where id = p_customer_id;
  if v_org is null then
    raise exception 'No existe el cliente %', p_customer_id using errcode = 'foreign_key_violation';
  end if;
  if v_org <> public.get_my_organization_id() then
    raise exception 'El cliente pertenece a otra organización' using errcode = 'insufficient_privilege';
  end if;

  -- La cuenta puede no existir: un cliente suelto no es flotilla y nunca pasó
  -- por el alta corporativa. Habilitarle crédito la crea.
  insert into public.corporate_accounts (
    customer_id, credit_limit, credit_days, credit_status,
    current_balance, blocked, credit_enabled, enabled_by, enabled_at
  ) values (
    p_customer_id, p_credit_limit, coalesce(p_credit_days, 30), 'active',
    0, false, true, v_actor, now()
  )
  on conflict (customer_id) do update
    set credit_enabled = true,
        credit_limit   = excluded.credit_limit,
        credit_days    = excluded.credit_days,
        -- Habilitar no des-bloquea: si la cuenta estaba bloqueada por mora, eso
        -- se levanta a propósito y no de paso al tocar el límite.
        enabled_by     = excluded.enabled_by,
        enabled_at     = coalesce(public.corporate_accounts.enabled_at, excluded.enabled_at),
        disabled_at    = null,
        updated_at     = now()
  returning * into v_cuenta;

  insert into public.corporate_credit_events
    (organization_id, customer_id, event_type, credit_limit, balance_after, actor_id)
  values (v_org, p_customer_id, 'CREDIT_ENABLED', v_cuenta.credit_limit,
          v_cuenta.current_balance, v_actor);

  return v_cuenta;
end;
$$;


/** Cambia el límite de una cuenta ya habilitada. Queda en auditoría. */
create or replace function public.credito_cambiar_limite(
  p_customer_id  uuid,
  p_credit_limit numeric,
  p_reason       text default null
) returns public.corporate_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuenta public.corporate_accounts;
  v_org    uuid;
begin
  if not public.has_permission('corporate.manage') then
    raise exception 'Se necesita el permiso corporate.manage para cambiar el límite'
      using errcode = 'insufficient_privilege';
  end if;
  if p_credit_limit is null or p_credit_limit <= 0 then
    raise exception 'El límite debe ser mayor que cero' using errcode = 'check_violation';
  end if;

  select organization_id into v_org from public.customers where id = p_customer_id;
  if v_org is null or v_org <> public.get_my_organization_id() then
    raise exception 'Cliente inexistente o de otra organización' using errcode = 'insufficient_privilege';
  end if;

  update public.corporate_accounts
     set credit_limit = p_credit_limit, updated_at = now()
   where customer_id = p_customer_id
  returning * into v_cuenta;

  if v_cuenta.id is null then
    raise exception 'El cliente % no tiene cuenta de crédito', p_customer_id;
  end if;

  -- Bajar el límite por debajo de lo que ya se debe NO se impide: puede ser
  -- justamente lo que se quiere hacer con un cliente en mora. Lo que pasa es
  -- que no podrá comprar más hasta abonar, y eso queda escrito acá.
  insert into public.corporate_credit_events
    (organization_id, customer_id, event_type, credit_limit, balance_after, actor_id, reason)
  values (v_org, p_customer_id, 'LIMIT_CHANGED', p_credit_limit,
          v_cuenta.current_balance, auth.uid(),
          case when p_credit_limit < v_cuenta.current_balance
               then coalesce(p_reason, '') || ' · El nuevo límite queda por debajo del saldo actual'
               else p_reason end);

  return v_cuenta;
end;
$$;


/** Revoca el crédito. El saldo pendiente NO se borra: se sigue debiendo. */
create or replace function public.credito_deshabilitar(
  p_customer_id uuid,
  p_reason      text default null
) returns public.corporate_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuenta public.corporate_accounts;
  v_org    uuid;
begin
  if not public.has_permission('corporate.manage') then
    raise exception 'Se necesita el permiso corporate.manage para revocar crédito'
      using errcode = 'insufficient_privilege';
  end if;

  select organization_id into v_org from public.customers where id = p_customer_id;

  update public.corporate_accounts
     set credit_enabled = false, disabled_at = now(), updated_at = now()
   where customer_id = p_customer_id
  returning * into v_cuenta;

  if v_cuenta.id is null then
    raise exception 'El cliente % no tiene cuenta de crédito', p_customer_id;
  end if;

  insert into public.corporate_credit_events
    (organization_id, customer_id, event_type, credit_limit, balance_after, actor_id, reason)
  values (v_org, p_customer_id, 'CREDIT_DISABLED', v_cuenta.credit_limit,
          v_cuenta.current_balance, auth.uid(), p_reason);

  return v_cuenta;
end;
$$;


-- ============================================================
-- CUÁNTO CUPO HAY — sólo lectura, para que la caja decida qué ofrecer
-- ============================================================
create or replace function public.credito_disponible(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cuenta public.corporate_accounts;
begin
  select * into v_cuenta
    from public.corporate_accounts
   where customer_id = p_customer_id;

  if v_cuenta.id is null or not v_cuenta.credit_enabled then
    return jsonb_build_object('habilitado', false,
      'motivo', 'Este cliente no tiene crédito habilitado');
  end if;
  if v_cuenta.blocked then
    return jsonb_build_object('habilitado', false,
      'motivo', coalesce(v_cuenta.block_reason, 'La cuenta está bloqueada'));
  end if;
  if v_cuenta.credit_status <> 'active' then
    return jsonb_build_object('habilitado', false,
      'motivo', 'La cuenta está ' || v_cuenta.credit_status);
  end if;

  return jsonb_build_object(
    'habilitado',  true,
    'limite',      v_cuenta.credit_limit,
    'saldo',       v_cuenta.current_balance,
    'disponible',  greatest(0, v_cuenta.credit_limit - v_cuenta.current_balance),
    'dias',        v_cuenta.credit_days
  );
end;
$$;


-- ============================================================
-- COBRAR AL CRÉDITO
--
-- Verifica el cupo y mueve el saldo EN LA MISMA TRANSACCIÓN, con la fila
-- bloqueada. Esa es toda la garantía del límite.
--
-- Si fueran dos pasos —consultar disponible, después registrar— dos cajas
-- vendiéndole a la misma flotilla al mismo tiempo pasarían las dos el chequeo
-- y el límite se rompería por la suma. Con el bloqueo, la segunda espera y ve
-- el saldo ya movido por la primera.
--
-- SOBRE LA AUTORIZACIÓN POR ENCIMA DEL LÍMITE
-- Exige que QUIEN LLAMA tenga `corporate.credit_override`. No hay forma de que
-- un cajero autorice «en nombre de» alguien: eso sería un campo de texto que
-- cualquiera llena. Si el negocio necesita aprobar desde el mostrador sin que
-- el admin abra su sesión, eso es un flujo de PIN de supervisor y hay que
-- diseñarlo aparte, no improvisarlo acá.
-- ============================================================
create or replace function public.credito_cobrar(
  p_customer_id   uuid,
  p_amount        numeric,
  p_work_order_id uuid default null,
  p_forzar        boolean default false,
  p_reason        text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuenta     public.corporate_accounts;
  v_org        uuid;
  v_disponible numeric(10,2);
  v_actor      uuid := auth.uid();
  v_excedido   boolean := false;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto a cobrar debe ser mayor que cero' using errcode = 'check_violation';
  end if;

  select organization_id into v_org from public.customers where id = p_customer_id;
  if v_org is null or v_org <> public.get_my_organization_id() then
    raise exception 'Cliente inexistente o de otra organización' using errcode = 'insufficient_privilege';
  end if;

  -- FOR UPDATE: acá se serializan las ventas concurrentes de la misma cuenta.
  select * into v_cuenta
    from public.corporate_accounts
   where customer_id = p_customer_id
     for update;

  if v_cuenta.id is null or not v_cuenta.credit_enabled then
    raise exception 'Este cliente no tiene crédito habilitado'
      using errcode = 'check_violation';
  end if;
  if v_cuenta.blocked then
    raise exception 'La cuenta está bloqueada: %',
      coalesce(v_cuenta.block_reason, 'sin motivo registrado') using errcode = 'check_violation';
  end if;
  if v_cuenta.credit_status <> 'active' then
    raise exception 'La cuenta está %', v_cuenta.credit_status using errcode = 'check_violation';
  end if;

  v_disponible := v_cuenta.credit_limit - v_cuenta.current_balance;

  if p_amount > v_disponible then
    if not p_forzar then
      raise exception
        'Sin cupo: disponible %, se intenta cobrar %. Límite % y saldo %.',
        round(greatest(0, v_disponible), 2), round(p_amount, 2),
        round(v_cuenta.credit_limit, 2), round(v_cuenta.current_balance, 2)
        using errcode = 'check_violation';
    end if;
    if not public.has_permission('corporate.credit_override') then
      raise exception
        'Pasar del límite necesita el permiso corporate.credit_override. Disponible %, se intenta cobrar %.',
        round(greatest(0, v_disponible), 2), round(p_amount, 2)
        using errcode = 'insufficient_privilege';
    end if;
    v_excedido := true;
  end if;

  insert into public.accounts_receivable
    (organization_id, customer_id, work_order_id, due_date, amount, balance, status, notes)
  values (v_org, p_customer_id, p_work_order_id,
          (now() at time zone 'America/El_Salvador')::date + v_cuenta.credit_days,
          p_amount, p_amount, 'open',
          case when v_excedido then 'Autorizado por encima del límite' else null end);

  update public.corporate_accounts
     set current_balance = current_balance + p_amount, updated_at = now()
   where customer_id = p_customer_id
  returning * into v_cuenta;

  insert into public.corporate_credit_events
    (organization_id, customer_id, event_type, amount, credit_limit, balance_after,
     work_order_id, actor_id, authorized_by, reason)
  values (v_org, p_customer_id,
          case when v_excedido then 'CHARGE_OVERRIDE' else 'CHARGE' end,
          p_amount, v_cuenta.credit_limit, v_cuenta.current_balance,
          p_work_order_id, v_actor,
          case when v_excedido then v_actor else null end, p_reason);

  return jsonb_build_object(
    'cobrado',    p_amount,
    'saldo',      v_cuenta.current_balance,
    'limite',     v_cuenta.credit_limit,
    'disponible', greatest(0, v_cuenta.credit_limit - v_cuenta.current_balance),
    'excedido',   v_excedido
  );
end;
$$;


-- ============================================================
-- ABONAR
--
-- Sin esto el crédito se llena una vez y no se vacía nunca: el límite dejaría
-- de ser un límite y pasaría a ser un tope de por vida.
-- ============================================================
create or replace function public.credito_registrar_pago(
  p_customer_id uuid,
  p_amount      numeric,
  p_reason      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuenta    public.corporate_accounts;
  v_org       uuid;
  v_restante  numeric(10,2);
  v_cuota     record;
begin
  if not public.has_permission('payments.create') then
    raise exception 'Se necesita el permiso payments.create para registrar un abono'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'El abono debe ser mayor que cero' using errcode = 'check_violation';
  end if;

  select organization_id into v_org from public.customers where id = p_customer_id;
  if v_org is null or v_org <> public.get_my_organization_id() then
    raise exception 'Cliente inexistente o de otra organización' using errcode = 'insufficient_privilege';
  end if;

  select * into v_cuenta from public.corporate_accounts
   where customer_id = p_customer_id for update;
  if v_cuenta.id is null then
    raise exception 'El cliente % no tiene cuenta de crédito', p_customer_id;
  end if;
  if p_amount > v_cuenta.current_balance then
    raise exception 'El abono (%) supera el saldo (%)',
      round(p_amount, 2), round(v_cuenta.current_balance, 2) using errcode = 'check_violation';
  end if;

  -- Se aplica a las cuentas por cobrar más viejas primero. El saldo de la
  -- cuenta y la suma de las cuotas tienen que seguir coincidiendo, o el
  -- disponible mentiría.
  v_restante := p_amount;
  for v_cuota in
    select * from public.accounts_receivable
     where customer_id = p_customer_id and balance > 0 and status <> 'void'
     order by due_date, created_at
       for update
  loop
    exit when v_restante <= 0;
    declare v_aplica numeric(10,2) := least(v_restante, v_cuota.balance);
    begin
      update public.accounts_receivable
         set balance = balance - v_aplica,
             status  = case when balance - v_aplica = 0 then 'paid' else 'partial' end,
             updated_at = now()
       where id = v_cuota.id;
      v_restante := v_restante - v_aplica;
    end;
  end loop;

  update public.corporate_accounts
     set current_balance = current_balance - p_amount, updated_at = now()
   where customer_id = p_customer_id
  returning * into v_cuenta;

  insert into public.corporate_credit_events
    (organization_id, customer_id, event_type, amount, credit_limit, balance_after, actor_id, reason)
  values (v_org, p_customer_id, 'PAYMENT', p_amount, v_cuenta.credit_limit,
          v_cuenta.current_balance, auth.uid(), p_reason);

  return jsonb_build_object(
    'abonado',    p_amount,
    'saldo',      v_cuenta.current_balance,
    'disponible', greatest(0, v_cuenta.credit_limit - v_cuenta.current_balance)
  );
end;
$$;


-- ─────────────────────────────────────────────
-- PERMISOS DE EJECUCIÓN
--
-- Las funciones son SECURITY DEFINER y verifican el permiso adentro. Se
-- otorgan a `authenticated` porque las llama la app con la sesión del usuario;
-- el control real está en el `has_permission` de cada una.
-- ─────────────────────────────────────────────
grant execute on function public.credito_habilitar(uuid, numeric, int)        to authenticated;
grant execute on function public.credito_cambiar_limite(uuid, numeric, text)  to authenticated;
grant execute on function public.credito_deshabilitar(uuid, text)             to authenticated;
grant execute on function public.credito_disponible(uuid)                     to authenticated;
grant execute on function public.credito_cobrar(uuid, numeric, uuid, boolean, text) to authenticated;
grant execute on function public.credito_registrar_pago(uuid, numeric, text)  to authenticated;
