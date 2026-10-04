-- ═══════════════════════════════════════════════════════════════════════
-- 0060 — Facturación consolidada: un CCF por período para clientes con crédito
--
-- Hay clientes con crédito que lavan 40-50 carros al mes y piden UN CCF cada
-- cierto tiempo, no uno por lavado. Para ellos (lo activa un administrador
-- en la ficha, corporate_accounts.consolidated_billing):
--
--   · una venta AL CRÉDITO se carga a CxC sin factura ni DTE
--     (work_orders.facturacion_diferida). Exige placa: es la línea del CCF;
--   · de contado, la venta se factura como siempre;
--   · desde Cuentas por cobrar, cxc_ccf_consolidado junta los lavados
--     pendientes en una factura (invoices.consolidado) y los marca
--     (work_orders.consolidated_invoice_id). El DTE se emite con el flujo de
--     siempre: el Worker arma, la estación fiscal firma;
--   · fiscal_sale_for_emission arma una línea por carro lavado: fecha, placa,
--     servicio + adicionales, al total de ese lavado.
--
-- De paso: anular una venta al crédito ahora revierte su deuda (antes la
-- venta quedaba anulada y el saldo la seguía cobrando), y una venta que ya
-- entró en un CCF consolidado no se puede anular sin invalidar ese CCF.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.corporate_accounts
  add column if not exists consolidated_billing boolean not null default false;
comment on column public.corporate_accounts.consolidated_billing is
  'Las ventas al crédito no se facturan una por una: se juntan en un CCF consolidado desde CxC (0060).';

alter table public.work_orders
  add column if not exists facturacion_diferida boolean not null default false,
  add column if not exists consolidated_invoice_id uuid references public.invoices(id) on delete set null;
create index if not exists idx_work_orders_diferidas
  on public.work_orders (customer_id) where facturacion_diferida;
create index if not exists idx_work_orders_consolidado
  on public.work_orders (consolidated_invoice_id) where consolidated_invoice_id is not null;

alter table public.invoices
  add column if not exists consolidado boolean not null default false;

alter table public.corporate_credit_events
  drop constraint if exists corporate_credit_events_tipo_valido,
  add  constraint corporate_credit_events_tipo_valido
    check (event_type in (
      'CREDIT_ENABLED', 'CREDIT_DISABLED', 'LIMIT_CHANGED', 'CHARGE', 'CHARGE_OVERRIDE',
      'PAYMENT', 'BLOCKED', 'UNBLOCKED',
      'CHARGE_VOID',                         -- se anuló una venta al crédito: su saldo se revierte
      'CONSOLIDATED_ON', 'CONSOLIDATED_OFF', -- facturación consolidada
      'CONSOLIDATED_CCF'                     -- se armó un CCF consolidado
    ));


-- ─────────────────────────────────────────────
-- Activar / desactivar la facturación consolidada
-- ─────────────────────────────────────────────
create or replace function public.credito_facturacion_consolidada(p_customer_id uuid, p_activa boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuenta public.corporate_accounts;
  v_org    uuid;
begin
  if not public.has_permission('corporate.manage') then
    raise exception 'No autorizado: se requiere corporate.manage' using errcode = '42501';
  end if;
  select organization_id into v_org from public.customers
   where id = p_customer_id and organization_id = public.get_my_organization_id();
  if v_org is null then raise exception 'No existe ese cliente' using errcode = 'P0002'; end if;

  select * into v_cuenta from public.corporate_accounts where customer_id = p_customer_id for update;
  if v_cuenta.customer_id is null or not v_cuenta.credit_enabled then
    raise exception 'Primero activá el crédito del cliente' using errcode = '22023';
  end if;

  update public.corporate_accounts set consolidated_billing = p_activa, updated_at = now()
   where customer_id = p_customer_id;
  insert into public.corporate_credit_events (organization_id, customer_id, event_type, actor_id, reason)
  values (v_org, p_customer_id, case when p_activa then 'CONSOLIDATED_ON' else 'CONSOLIDATED_OFF' end, auth.uid(),
          case when p_activa then 'Las ventas al crédito se facturan en CCF consolidado' else 'Vuelve a facturar cada venta' end);
end;
$$;
revoke all on function public.credito_facturacion_consolidada(uuid, boolean) from public, anon;
grant execute on function public.credito_facturacion_consolidada(uuid, boolean) to authenticated;

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
    'dias',        v_cuenta.credit_days,
    'consolidado', coalesce(v_cuenta.consolidated_billing, false)
  );
end;
$$;

create or replace function public.pos_register_sale(
  p_branch_id        uuid,
  p_service_code     text,                    -- 'PRO' | 'ELITE' | 'SIGNATURE'
  p_size             text,                    -- 'S' | 'M' | 'L'
  p_total            numeric,
  p_payment_method   text,                    -- id del POS: efectivo, tarjeta, …
  p_with_aspirado    boolean default false,
  p_aspirado_price   numeric default 0,
  p_customer_id      uuid    default null,
  p_vehicle_id       uuid    default null,
  p_doc_type         text    default 'ticket',-- 'ticket' | 'ccf'
  p_fcf_name         text    default null,
  p_ccf_customer_id  uuid    default null,
  p_order_type       text    default 'normal',-- 'normal' | 'flotilla' | 'membresia'
  -- Nuevos: el seguro de lluvia se vende, o se cobra un lavado con él.
  p_rain_insurance   boolean default false,
  p_rain_price       numeric default 0,
  p_rain_policy_id   uuid    default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org_id       uuid;
  v_branch_code  text;
  v_service_id   uuid;
  v_service_name text;
  v_program      smallint;
  v_order_id     uuid;
  v_order_number text;
  v_tax_rate     numeric(5,4) := 0.13;
  v_base         numeric(10,2);
  v_aspirado     numeric(10,2) := 0;
  v_seguro       numeric(10,2) := 0;
  v_subtotal     numeric(10,2);
  v_tax          numeric(10,2);
  v_method_id    uuid;
  v_method_code  text;
  v_invoice_type text;
  v_invoice_id   uuid;
  v_diferida     boolean := false;
  v_plate        text;
  v_policy       record;
  v_policy_id    uuid;
  v_policy_json  jsonb := null;
  v_redeem_json  jsonb := null;
begin
  if not public.has_permission('orders.create') then
    raise exception 'No autorizado: se requiere orders.create' using errcode = '42501';
  end if;

  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;

  select organization_id, code into v_org_id, v_branch_code
  from public.branches where id = p_branch_id;

  -- El receptor elegido al cobrar va a parar a un DTE: tiene que ser un
  -- cliente de esta organización (0049).
  if p_ccf_customer_id is not null and not exists (
    select 1 from public.customers
     where id = p_ccf_customer_id and organization_id = v_org_id
  ) then
    raise exception 'El cliente del documento no existe en esta organización' using errcode = '22023';
  end if;

  -- ── Reglas del seguro, antes de tocar nada ──
  --
  -- Se validan acá y no en la pantalla porque son las que sostienen el
  -- derecho: sin titular no hay a quién reconocerle el lavado, y sin placa no
  -- se sabe de qué carro estamos hablando. Que fallen ANTES de crear la orden
  -- evita el peor caso: una venta cobrada y una póliza que no existe.
  if p_rain_insurance then
    if not public.has_permission('rain.sell') then
      raise exception 'No autorizado: se requiere rain.sell' using errcode = '42501';
    end if;
    if p_customer_id is null then
      raise exception 'El seguro de lluvia necesita un cliente identificado: no se puede vender a Consumidor Final'
        using errcode = '22023';
    end if;
    if p_vehicle_id is null then
      raise exception 'El seguro de lluvia necesita un vehículo registrado' using errcode = '22023';
    end if;

    select plate into v_plate from public.vehicles
     where id = p_vehicle_id and organization_id = v_org_id;

    if v_plate is null or trim(v_plate) = '' then
      raise exception 'El vehículo no tiene placa registrada: sin placa el seguro no se puede reclamar'
        using errcode = '22023';
    end if;
  end if;

  -- ── Canje: la póliza se toma antes de cobrar, y bloqueada ──
  --
  -- `for update` evita el caso de dos cajas canjeando la misma póliza a la vez:
  -- la segunda espera, y cuando entra ya la ve canjeada.
  if p_rain_policy_id is not null then
    if not public.has_permission('rain.redeem') then
      raise exception 'No autorizado: se requiere rain.redeem' using errcode = '42501';
    end if;

    select * into v_policy
      from public.rain_policies
     where id = p_rain_policy_id and organization_id = v_org_id
       for update;

    if not found then
      raise exception 'El seguro de lluvia no existe' using errcode = '22023';
    end if;
    if v_policy.status = 'redeemed' then
      raise exception 'Ese seguro ya fue canjeado el %',
        to_char(v_policy.redeemed_at at time zone 'America/El_Salvador', 'DD/MM/YYYY HH24:MI')
        using errcode = '22023';
    end if;
    if v_policy.status = 'cancelled' then
      raise exception 'Ese seguro está anulado' using errcode = '22023';
    end if;
    if v_policy.valid_until <= now() then
      raise exception 'Ese seguro venció el %',
        to_char(v_policy.valid_until at time zone 'America/El_Salvador', 'DD/MM/YYYY HH24:MI')
        using errcode = '22023';
    end if;
    -- El seguro es del carro, no del cliente: se emitió sobre una placa y sólo
    -- se puede usar en esa.
    if p_vehicle_id is not null and v_policy.vehicle_id <> p_vehicle_id then
      raise exception 'Ese seguro es del vehículo %, no del que está en la orden', v_policy.plate
        using errcode = '22023';
    end if;
  end if;

  select id, name, machine_program
  into v_service_id, v_service_name, v_program
  from public.services
  where organization_id = v_org_id and code = p_service_code and active = true;

  if v_service_id is null then
    raise exception 'Servicio % no existe en el catálogo', p_service_code using errcode = '22023';
  end if;

  -- Tarifa vigente; si no hay configurada se asume el 13% de ley.
  select rate into v_tax_rate
  from public.tax_rates
  where organization_id = v_org_id and active = true
    and applicable_from <= public.corsa_hoy()
    and (applicable_to is null or applicable_to >= public.corsa_hoy())
  order by applicable_from desc limit 1;
  v_tax_rate := coalesce(v_tax_rate, 0.13);

  -- Los precios del POS ya llevan IVA incluido: se desglosa hacia atrás.
  v_aspirado := case when p_with_aspirado then coalesce(p_aspirado_price, 0) else 0 end;
  v_seguro   := case when p_rain_insurance then coalesce(p_rain_price, 0) else 0 end;
  v_base     := p_total - v_aspirado - v_seguro;
  v_subtotal := round(p_total / (1 + v_tax_rate), 2);
  v_tax      := p_total - v_subtotal;

  v_order_number := public.generate_order_number(
    v_org_id, v_branch_code, extract(year from now())::int
  );

  insert into public.work_orders (
    organization_id, branch_id, order_number, customer_id, vehicle_id,
    source, status, payment_status,
    subtotal, discount_total, tax_total, total,
    checked_in_at, completed_at, delivered_at, notes, created_by
  ) values (
    -- En un CCF el cliente puede venir sólo por el buscador del modal, sin
    -- haber sido elegido en la caja. Igual es el dueño de la venta: sin este
    -- coalesce la orden quedaba huérfana y el historial la mostraba como
    -- "Consumidor Final".
    v_org_id, p_branch_id, v_order_number,
    coalesce(p_customer_id, p_ccf_customer_id), p_vehicle_id,
    case when p_order_type = 'flotilla' then 'fleet' else 'walk_in' end,
    'delivered', case when p_payment_method = 'credito' and p_total > 0 then 'pending' else 'paid' end,
    v_subtotal, 0, v_tax, p_total,
    now(), now(), now(),
    format('Tamaño %s · %s%s', p_size, p_order_type,
           case when p_rain_policy_id is not null then ' · canje seguro de lluvia' else '' end),
    auth.uid()
  )
  returning id into v_order_id;

  insert into public.work_order_items (
    work_order_id, service_id, description_snapshot, price_snapshot,
    quantity, unit_price, discount_amount, tax_amount, total, sort_order
  ) values (
    v_order_id, v_service_id, format('%s %s', v_service_name, p_size), v_base,
    1, v_base, 0, round(v_base - (v_base / (1 + v_tax_rate)), 2), v_base, 1
  );

  if p_with_aspirado then
    insert into public.work_order_items (
      work_order_id, service_id, description_snapshot, price_snapshot,
      quantity, unit_price, discount_amount, tax_amount, total, sort_order
    )
    select v_order_id, s.id, s.name, v_aspirado,
           1, v_aspirado, 0, round(v_aspirado - (v_aspirado / (1 + v_tax_rate)), 2), v_aspirado, 2
    from public.services s
    where s.organization_id = v_org_id and s.code = 'ASPIRADO-INT';
  end if;

  -- ── La póliza, en la misma transacción que el cobro ──
  if p_rain_insurance then
    insert into public.work_order_items (
      work_order_id, service_id, description_snapshot, price_snapshot,
      quantity, unit_price, discount_amount, tax_amount, total, sort_order
    )
    select v_order_id, s.id, s.name, v_seguro,
           1, v_seguro, 0, round(v_seguro - (v_seguro / (1 + v_tax_rate)), 2), v_seguro, 3
    from public.services s
    where s.organization_id = v_org_id and s.code = 'SEGURO-LLUVIA';

    insert into public.rain_policies (
      organization_id, branch_id, work_order_id, customer_id, vehicle_id,
      plate, price, issued_at, valid_until, status, created_by
    ) values (
      v_org_id, p_branch_id, v_order_id, p_customer_id, p_vehicle_id,
      upper(trim(v_plate)), v_seguro, now(),
      -- 48 horas exactas desde el cobro. No «dos días»: si se vendiera a las
      -- 11 de la noche, «dos días» dejaría afuera casi una jornada entera.
      now() + interval '48 hours',
      'active', auth.uid()
    )
    returning id into v_policy_id;

    v_policy_json := jsonb_build_object(
      'id',          v_policy_id,
      'plate',       upper(trim(v_plate)),
      'price',       v_seguro,
      'issued_at',   now(),
      'valid_until', now() + interval '48 hours'
    );
  end if;

  -- ── El canje se consuma ──
  if p_rain_policy_id is not null then
    update public.rain_policies
       set status = 'redeemed',
           redeemed_at = now(),
           redeemed_work_order_id = v_order_id,
           redeemed_by = auth.uid(),
           updated_at = now()
     where id = p_rain_policy_id;

    v_redeem_json := jsonb_build_object(
      'id',    v_policy.id,
      'plate', v_policy.plate,
      'issued_at',   v_policy.issued_at,
      'valid_until', v_policy.valid_until
    );
  end if;

  -- Método de pago: el POS manda su propio id, acá se traduce al catálogo.
  v_method_code := case p_payment_method
    when 'efectivo'      then 'CASH'
    when 'tarjeta'       then 'CARD'
    when 'transferencia' then 'TRANSFER'
    when 'membresia'     then 'MEMBER'
    when 'credito'       then 'CORP'
    else 'CASH'
  end;

  select id into v_method_id
  from public.payment_methods
  where organization_id = v_org_id and code = v_method_code and active = true
  limit 1;

  -- Un canje se cobra en cero: registrar un pago de $0 ensuciaría el arqueo de
  -- caja con movimientos que no movieron plata.
  -- Al crédito (0058): no hay plata que registrar; la venta se carga a la
  -- cuenta del cliente con credito_cobrar, que verifica que el crédito esté
  -- habilitado y que alcance el cupo, con la cuenta bloqueada. Si no alcanza,
  -- lanza y la venta entera se deshace: nunca queda una venta al crédito sin
  -- su deuda registrada.
  if p_payment_method = 'credito' and p_total > 0 then
    if coalesce(p_customer_id, p_ccf_customer_id) is null then
      raise exception 'Una venta al crédito necesita el cliente que la debe' using errcode = '22023';
    end if;
    perform public.credito_cobrar(coalesce(p_customer_id, p_ccf_customer_id), p_total, v_order_id);

    -- Facturación consolidada (0060): el cliente pide un solo CCF por
    -- período. Esta venta queda en CxC sin factura ni DTE; se factura junto
    -- con las demás desde Cuentas por cobrar. Cada lavado necesita su placa:
    -- es lo que va a decir la línea del CCF.
    select coalesce(ca.consolidated_billing, false) into v_diferida
      from public.corporate_accounts ca
     where ca.customer_id = coalesce(p_customer_id, p_ccf_customer_id);
    v_diferida := coalesce(v_diferida, false);
    if v_diferida then
      if p_vehicle_id is null then
        raise exception 'Este cliente factura en CCF consolidado: elegí la placa del carro que se lava' using errcode = '22023';
      end if;
      update public.work_orders set facturacion_diferida = true where id = v_order_id;
    end if;
  end if;

  if v_method_id is not null and p_total > 0 and p_payment_method <> 'credito' then
    with p as (
      insert into public.payments (
        organization_id, branch_id, payment_method_id, amount, status, received_by
      ) values (
        v_org_id, p_branch_id, v_method_id, p_total, 'approved', auth.uid()
      )
      returning id
    )
    insert into public.payment_allocations (payment_id, work_order_id, amount)
    select p.id, v_order_id, p_total from p;
  end if;

  -- Factura. El DTE todavía no se transmite: queda el registro del documento
  -- que corresponde emitir, para conciliarlo cuando se conecte al MH.
  -- Con facturación diferida no hay factura todavía: la crea el CCF consolidado.
  if not v_diferida then
    v_invoice_type := case when p_doc_type = 'ccf' then 'credito_fiscal' else 'consumidor_final' end;

    -- customer_id sigue siendo el de la venta (cuentas por cobrar, historial).
    -- receptor_customer_id es a quién se le emite: el del CCF o el del ticket
    -- con nombre; null en un ticket genérico, aunque haya cliente en la caja.
    insert into public.invoices (
      organization_id, branch_id, work_order_id, customer_id, receptor_customer_id,
      invoice_type, invoice_number, subtotal, tax_amount, total,
      status, issued_at, created_by
    ) values (
      v_org_id, p_branch_id, v_order_id,
      coalesce(p_ccf_customer_id, p_customer_id),
      p_ccf_customer_id,
      v_invoice_type, v_order_number, v_subtotal, v_tax, p_total,
      'issued', now(), auth.uid()
    )
    returning id into v_invoice_id;

    -- La cuenta por cobrar queda atada a su factura: el estado de cuenta la
    -- muestra con su número.
    update public.accounts_receivable set invoice_id = v_invoice_id
     where work_order_id = v_order_id and invoice_id is null;
  end if;

  return jsonb_build_object(
    'order_id',       v_order_id,
    'order_number',   v_order_number,
    'invoice_id',     v_invoice_id,
    'service_name',   v_service_name,
    'machine_program', v_program,
    'size',           p_size,
    'with_aspirado',  p_with_aspirado,
    'subtotal',       v_subtotal,
    'tax',            v_tax,
    'total',          p_total,
    'doc_type',       p_doc_type,
    'facturacion_diferida', v_diferida,
    'fcf_name',       p_fcf_name,
    'issued_at',      now(),
    -- Lo que el ticket necesita para imprimir la vigencia.
    'rain_policy',    v_policy_json,
    'rain_redeemed',  v_redeem_json
  );
end;
$$;

create or replace function public.pos_register_sale_multi(
  p_branch_id        uuid,
  p_lineas           jsonb,   -- [{vehicle_id, service_code, size, price, with_aspirado, aspirado_price}]
  p_total            numeric,
  p_payment_method   text,
  p_customer_id      uuid    default null,
  p_doc_type         text    default 'ticket',
  p_fcf_name         text    default null,
  p_ccf_customer_id  uuid    default null,
  p_order_type       text    default 'normal'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org_id       uuid;
  v_branch_code  text;
  v_tax_rate     numeric(5,4) := 0.13;
  v_subtotal     numeric(10,2);
  v_tax          numeric(10,2);
  v_suma         numeric(12,2) := 0;
  v_order_id     uuid;
  v_order_number text;
  v_method_id    uuid;
  v_method_code  text;
  v_invoice_type text;
  v_invoice_id   uuid;
  v_diferida     boolean := false;
  v_l            jsonb;
  v_i            int := 0;
  v_plate        text;
  v_service      record;
  v_aspirado_id  uuid;
  v_aspirado_nm  text;
  v_precio       numeric(10,2);
  v_asp          numeric(10,2);
  v_primero      uuid;
  v_vistos       uuid[] := '{}';
  v_resumen      jsonb := '[]'::jsonb;
begin
  if not public.has_permission('orders.create') then
    raise exception 'No autorizado: se requiere orders.create' using errcode = '42501';
  end if;
  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;

  select organization_id, code into v_org_id, v_branch_code
    from public.branches where id = p_branch_id;

  if p_ccf_customer_id is not null and not exists (
    select 1 from public.customers where id = p_ccf_customer_id and organization_id = v_org_id
  ) then
    raise exception 'El cliente del documento no existe en esta organización' using errcode = '22023';
  end if;
  if p_customer_id is not null and not exists (
    select 1 from public.customers where id = p_customer_id and organization_id = v_org_id
  ) then
    raise exception 'El cliente no existe en esta organización' using errcode = '22023';
  end if;

  if jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) < 1 then
    raise exception 'La orden no tiene carros' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lineas) > 30 then
    raise exception 'Como mucho 30 carros por orden' using errcode = '22023';
  end if;

  -- ── Validar todo antes de escribir nada ──
  for v_l in select * from jsonb_array_elements(p_lineas) loop
    if (v_l->>'vehicle_id') is null then
      raise exception 'Cada carro de la orden necesita su placa' using errcode = '22023';
    end if;
    if (v_l->>'vehicle_id')::uuid = any(v_vistos) then
      raise exception 'Hay un carro repetido en la orden' using errcode = '22023';
    end if;
    v_vistos := v_vistos || (v_l->>'vehicle_id')::uuid;
    if not exists (select 1 from public.vehicles
                    where id = (v_l->>'vehicle_id')::uuid and organization_id = v_org_id) then
      raise exception 'Un vehículo de la orden no existe' using errcode = '22023';
    end if;
    if upper(coalesce(v_l->>'size', '')) not in ('S', 'M', 'L') then
      raise exception 'Tamaño inválido en la orden' using errcode = '22023';
    end if;
    if coalesce((v_l->>'price')::numeric, -1) < 0
       or coalesce((v_l->>'aspirado_price')::numeric, 0) < 0 then
      raise exception 'Precio inválido en la orden' using errcode = '22023';
    end if;
    if not exists (select 1 from public.services
                    where organization_id = v_org_id and code = upper(v_l->>'service_code') and active) then
      raise exception 'Servicio % no existe en el catálogo', v_l->>'service_code' using errcode = '22023';
    end if;
    v_suma := v_suma + (v_l->>'price')::numeric
            + case when coalesce((v_l->>'with_aspirado')::boolean, false)
                   then coalesce((v_l->>'aspirado_price')::numeric, 0) else 0 end;
  end loop;

  -- Lo cobrado tiene que ser la suma de las líneas: si no, la factura diría
  -- un total y el DTE otro.
  if abs(v_suma - p_total) > 0.005 then
    raise exception 'El total (%) no coincide con la suma de los carros (%)', p_total, v_suma using errcode = '22023';
  end if;

  select rate into v_tax_rate
    from public.tax_rates
   where organization_id = v_org_id and active = true
     and applicable_from <= public.corsa_hoy()
     and (applicable_to is null or applicable_to >= public.corsa_hoy())
   order by applicable_from desc limit 1;
  v_tax_rate := coalesce(v_tax_rate, 0.13);

  v_subtotal := round(p_total / (1 + v_tax_rate), 2);
  v_tax      := p_total - v_subtotal;

  select id, name into v_aspirado_id, v_aspirado_nm
    from public.services where organization_id = v_org_id and code = 'ASPIRADO-INT';

  v_primero := (p_lineas->0->>'vehicle_id')::uuid;
  v_order_number := public.generate_order_number(v_org_id, v_branch_code, extract(year from now())::int);

  insert into public.work_orders (
    organization_id, branch_id, order_number, customer_id, vehicle_id,
    source, status, payment_status,
    subtotal, discount_total, tax_total, total,
    checked_in_at, completed_at, delivered_at, notes, created_by
  ) values (
    v_org_id, p_branch_id, v_order_number,
    coalesce(p_customer_id, p_ccf_customer_id), v_primero,
    case when p_order_type = 'flotilla' then 'fleet' else 'walk_in' end,
    'delivered', case when p_payment_method = 'credito' and p_total > 0 then 'pending' else 'paid' end,
    v_subtotal, 0, v_tax, p_total,
    now(), now(), now(),
    format('%s carros · %s', jsonb_array_length(p_lineas), p_order_type),
    auth.uid()
  )
  returning id into v_order_id;

  for v_l in select * from jsonb_array_elements(p_lineas) loop
    v_i := v_i + 1;
    select upper(coalesce(nullif(trim(plate), ''), 'SIN PLACA')) into v_plate
      from public.vehicles where id = (v_l->>'vehicle_id')::uuid;
    select id, name, machine_program into v_service
      from public.services
     where organization_id = v_org_id and code = upper(v_l->>'service_code') and active;
    v_precio := (v_l->>'price')::numeric;
    v_asp := case when coalesce((v_l->>'with_aspirado')::boolean, false)
                  then coalesce((v_l->>'aspirado_price')::numeric, 0) else 0 end;

    insert into public.work_order_items (
      work_order_id, service_id, description_snapshot, price_snapshot,
      quantity, unit_price, discount_amount, tax_amount, total, sort_order
    ) values (
      v_order_id, v_service.id, format('%s %s · %s', v_service.name, upper(v_l->>'size'), v_plate), v_precio,
      1, v_precio, 0, round(v_precio - (v_precio / (1 + v_tax_rate)), 2), v_precio, v_i * 10
    );

    if v_asp > 0 and v_aspirado_id is not null then
      insert into public.work_order_items (
        work_order_id, service_id, description_snapshot, price_snapshot,
        quantity, unit_price, discount_amount, tax_amount, total, sort_order
      ) values (
        v_order_id, v_aspirado_id, format('%s · %s', v_aspirado_nm, v_plate), v_asp,
        1, v_asp, 0, round(v_asp - (v_asp / (1 + v_tax_rate)), 2), v_asp, v_i * 10 + 1
      );
    end if;

    v_resumen := v_resumen || jsonb_build_object(
      'vehicle_id',      v_l->>'vehicle_id',
      'plate',           v_plate,
      'service_name',    v_service.name,
      'machine_program', v_service.machine_program,
      'size',            upper(v_l->>'size'),
      'price',           v_precio,
      'with_aspirado',   v_asp > 0,
      'aspirado_price',  v_asp
    );
  end loop;

  v_method_code := case p_payment_method
    when 'efectivo'      then 'CASH'
    when 'tarjeta'       then 'CARD'
    when 'transferencia' then 'TRANSFER'
    when 'membresia'     then 'MEMBER'
    when 'credito'       then 'CORP'
    else 'CASH'
  end;
  select id into v_method_id from public.payment_methods
   where organization_id = v_org_id and code = v_method_code and active = true limit 1;

  -- Al crédito (0058): no hay plata que registrar; la venta se carga a la
  -- cuenta del cliente con credito_cobrar, que verifica que el crédito esté
  -- habilitado y que alcance el cupo, con la cuenta bloqueada. Si no alcanza,
  -- lanza y la venta entera se deshace: nunca queda una venta al crédito sin
  -- su deuda registrada.
  if p_payment_method = 'credito' and p_total > 0 then
    if coalesce(p_customer_id, p_ccf_customer_id) is null then
      raise exception 'Una venta al crédito necesita el cliente que la debe' using errcode = '22023';
    end if;
    perform public.credito_cobrar(coalesce(p_customer_id, p_ccf_customer_id), p_total, v_order_id);

    -- Facturación consolidada (0060): el cliente pide un solo CCF por
    -- período. Esta venta queda en CxC sin factura ni DTE; se factura junto
    -- con las demás desde Cuentas por cobrar. Cada lavado necesita su placa:
    -- es lo que va a decir la línea del CCF.
    select coalesce(ca.consolidated_billing, false) into v_diferida
      from public.corporate_accounts ca
     where ca.customer_id = coalesce(p_customer_id, p_ccf_customer_id);
    v_diferida := coalesce(v_diferida, false);
    if v_diferida then
      update public.work_orders set facturacion_diferida = true where id = v_order_id;
    end if;
  end if;

  if v_method_id is not null and p_total > 0 and p_payment_method <> 'credito' then
    with p as (
      insert into public.payments (organization_id, branch_id, payment_method_id, amount, status, received_by)
      values (v_org_id, p_branch_id, v_method_id, p_total, 'approved', auth.uid())
      returning id
    )
    insert into public.payment_allocations (payment_id, work_order_id, amount)
    select p.id, v_order_id, p_total from p;
  end if;

  -- Con facturación diferida no hay factura todavía: la crea el CCF consolidado.
  if not v_diferida then
    v_invoice_type := case when p_doc_type = 'ccf' then 'credito_fiscal' else 'consumidor_final' end;
    insert into public.invoices (
      organization_id, branch_id, work_order_id, customer_id, receptor_customer_id,
      invoice_type, invoice_number, subtotal, tax_amount, total,
      status, issued_at, created_by
    ) values (
      v_org_id, p_branch_id, v_order_id,
      coalesce(p_ccf_customer_id, p_customer_id), p_ccf_customer_id,
      v_invoice_type, v_order_number, v_subtotal, v_tax, p_total,
      'issued', now(), auth.uid()
    )
    returning id into v_invoice_id;

    -- La cuenta por cobrar queda atada a su factura: el estado de cuenta la
    -- muestra con su número.
    update public.accounts_receivable set invoice_id = v_invoice_id
     where work_order_id = v_order_id and invoice_id is null;
  end if;

  return jsonb_build_object(
    'order_id',     v_order_id,
    'order_number', v_order_number,
    'invoice_id',   v_invoice_id,
    'subtotal',     v_subtotal,
    'tax',          v_tax,
    'total',        p_total,
    'doc_type',     p_doc_type,
    'facturacion_diferida', v_diferida,
    'fcf_name',     p_fcf_name,
    'issued_at',    now(),
    'lineas',       v_resumen
  );
end;
$$;

create or replace function public.fiscal_sale_for_emission(
  p_invoice_id      uuid,
  p_organization_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_inv      public.invoices;
  v_lineas   jsonb;
  v_receptor jsonb;
  v_receptor_fcf jsonb;
begin
  -- Con la organización: el id llega del navegador, y el de otra empresa
  -- pondría su venta en un documento nuestro.
  select * into v_inv
    from public.invoices
   where id = p_invoice_id and organization_id = p_organization_id;
  if not found then
    raise exception 'No existe esa factura' using errcode = 'P0002';
  end if;
  if v_inv.status = 'voided' then
    raise exception 'La factura está anulada; no se emite' using errcode = '22023';
  end if;
  if v_inv.work_order_id is null and not coalesce(v_inv.consolidado, false) then
    raise exception 'La factura no tiene una orden asociada' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'descripcion', i.description_snapshot,
           'cantidad',    i.quantity,
           'precioUni',   i.unit_price,
           'montoDescu',  i.discount_amount
         ) order by i.sort_order, i.created_at), '[]'::jsonb)
    into v_lineas
    from public.work_order_items i
   where i.work_order_id = v_inv.work_order_id;

  -- CCF consolidado (0060): una línea por carro lavado, con su fecha, su
  -- placa, el servicio y los adicionales, al precio total de ese lavado. En
  -- una venta de varios carros cada ítem trae « · PLACA» (0057); en la de uno,
  -- la placa es la del carro de la orden.
  if coalesce(v_inv.consolidado, false) then
    select coalesce(jsonb_agg(jsonb_build_object(
             'descripcion', l.descripcion,
             'cantidad',    1,
             'precioUni',   l.total,
             'montoDescu',  l.descuento
           ) order by l.fecha, l.orden, l.placa), '[]'::jsonb)
      into v_lineas
      from (
        select wo.created_at as fecha, wo.order_number as orden, x.placa,
               to_char(wo.created_at at time zone 'America/El_Salvador', 'DD/MM/YYYY') || ' · ' || x.placa || ' · '
                 || string_agg(x.servicio, ' + ' order by x.sort_order) as descripcion,
               sum(x.total) as total,
               sum(x.descuento) as descuento
          from public.work_orders wo
          join lateral (
            select i.sort_order, i.total, i.discount_amount as descuento,
                   coalesce(substring(i.description_snapshot from ' · ([A-Z0-9-]+)$'),
                            upper(coalesce(nullif(trim(v.plate), ''), 'SIN PLACA'))) as placa,
                   regexp_replace(regexp_replace(i.description_snapshot, ' · [A-Z0-9-]+$', ''),
                                  '^Aspirado de interiores$', 'Aspirado') as servicio
              from public.work_order_items i
              left join public.vehicles v on v.id = wo.vehicle_id
             where i.work_order_id = wo.id
          ) x on true
         where wo.consolidated_invoice_id = v_inv.id
         group by wo.id, wo.created_at, wo.order_number, x.placa
      ) l;
  end if;

  select jsonb_build_object(
           'nit',             c.normalized_nit,
           'nrc',             c.normalized_nrc,
           'nombre',          case when c.customer_type = 'company'
                                   then coalesce(nullif(c.legal_name, ''), c.trade_name)
                                   else nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')
                              end,
           'codActividad',    c.cod_actividad,
           'descActividad',   c.desc_actividad,
           'nombreComercial', nullif(c.trade_name, ''),
           'direccion',       jsonb_build_object(
                                'departamento', c.fiscal_departamento,
                                'municipio',    c.fiscal_municipio,
                                'complemento',  c.fiscal_complemento),
           'telefono',        nullif(c.normalized_phone, ''),
           'correo',          coalesce(nullif(c.billing_email, ''), nullif(c.email, ''))
         )
    into v_receptor
    from public.customers c
   where c.id = v_inv.customer_id;

  -- El receptor del ticket: sólo si el cajero lo pidió a nombre de alguien
  -- (receptor_customer_id). Un ticket genérico sale sin receptor aunque la
  -- venta tenga cliente. El Worker lo traduce a fe-fc-v1 y descarta lo que
  -- no cumpla el schema.
  if v_inv.invoice_type = 'consumidor_final' and v_inv.receptor_customer_id is not null then
    select jsonb_build_object(
             'tipoDocumento', nullif(c.fiscal_doc_type, ''),
             'dui',           nullif(c.dui, ''),
             'nit',           nullif(c.normalized_nit, ''),
             'numDocumento',  nullif(c.fiscal_doc_number, ''),
             'nrc',           nullif(c.normalized_nrc, ''),
             'nombre',        case when c.customer_type = 'company'
                                   then coalesce(nullif(c.legal_name, ''), c.trade_name)
                                   else nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '')
                              end,
             'codActividad',  c.cod_actividad,
             'descActividad', c.desc_actividad,
             'direccion',     jsonb_build_object(
                                'departamento', c.fiscal_departamento,
                                'municipio',    c.fiscal_municipio,
                                'complemento',  c.fiscal_complemento),
             'telefono',      nullif(c.normalized_phone, ''),
             'correo',        coalesce(nullif(c.billing_email, ''), nullif(c.email, ''))
           )
      into v_receptor_fcf
      from public.customers c
     where c.id = v_inv.receptor_customer_id
       and c.organization_id = p_organization_id;
  end if;

  return jsonb_build_object(
    'invoice_id',   v_inv.id,
    'branch_id',    v_inv.branch_id,
    'customer_id',  v_inv.customer_id,
    'invoice_type', v_inv.invoice_type,
    'total',        v_inv.total,
    'lineas',       v_lineas,
    'receptor',     v_receptor,
    'receptor_fcf', v_receptor_fcf
  );
end;
$$;

-- ─────────────────────────────────────────────
-- Armar el CCF consolidado
-- ─────────────────────────────────────────────
create or replace function public.cxc_ccf_consolidado(p_customer_id uuid, p_work_order_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_branch   uuid;
  v_total    numeric(12,2);
  v_n        int;
  v_tax_rate numeric(5,4) := 0.13;
  v_subtotal numeric(12,2);
  v_inv      uuid;
  v_numero   text;
  v_desde    timestamptz;
  v_hasta    timestamptz;
begin
  if not public.has_permission('fiscal.issue') then
    raise exception 'No autorizado: se requiere fiscal.issue' using errcode = '42501';
  end if;
  select organization_id into v_org from public.customers
   where id = p_customer_id and organization_id = public.get_my_organization_id();
  if v_org is null then raise exception 'No existe ese cliente' using errcode = 'P0002'; end if;
  if p_work_order_ids is null or array_length(p_work_order_ids, 1) is null then
    raise exception 'Elegí al menos un lavado para facturar' using errcode = '22023';
  end if;

  -- Bloqueadas: dos personas facturando lo mismo a la vez no generan dos CCF.
  perform 1 from public.work_orders where id = any(p_work_order_ids) for update;

  if exists (
    select 1 from unnest(p_work_order_ids) w(id)
    left join public.work_orders wo on wo.id = w.id
     where wo.id is null or wo.organization_id <> v_org or wo.customer_id <> p_customer_id
        or not wo.facturacion_diferida or wo.status = 'cancelled' or wo.consolidated_invoice_id is not null
  ) then
    raise exception 'Algún lavado no es de este cliente, está anulado o ya se facturó' using errcode = '22023';
  end if;

  select count(*), sum(total), min(created_at), max(created_at), (array_agg(branch_id order by created_at desc))[1]
    into v_n, v_total, v_desde, v_hasta, v_branch
    from public.work_orders where id = any(p_work_order_ids);

  select rate into v_tax_rate from public.tax_rates
   where organization_id = v_org and active and applicable_from <= public.corsa_hoy()
     and (applicable_to is null or applicable_to >= public.corsa_hoy())
   order by applicable_from desc limit 1;
  v_tax_rate := coalesce(v_tax_rate, 0.13);
  v_subtotal := round(v_total / (1 + v_tax_rate), 2);

  v_numero := 'CONS-' || to_char(now() at time zone 'America/El_Salvador', 'YYMMDD-HH24MISS')
              || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  insert into public.invoices (
    organization_id, branch_id, work_order_id, customer_id, receptor_customer_id,
    invoice_type, invoice_number, subtotal, tax_amount, total, status, issued_at, created_by, consolidado
  ) values (
    v_org, v_branch, null, p_customer_id, p_customer_id,
    'credito_fiscal', v_numero, v_subtotal, v_total - v_subtotal, v_total, 'issued', now(), auth.uid(), true
  ) returning id into v_inv;

  update public.work_orders set consolidated_invoice_id = v_inv, updated_at = now()
   where id = any(p_work_order_ids);
  update public.accounts_receivable set invoice_id = v_inv, updated_at = now()
   where work_order_id = any(p_work_order_ids) and invoice_id is null;

  insert into public.corporate_credit_events (organization_id, customer_id, event_type, amount, actor_id, reason)
  values (v_org, p_customer_id, 'CONSOLIDATED_CCF', v_total, auth.uid(), format('%s lavados en %s', v_n, v_numero));

  return jsonb_build_object('invoice_id', v_inv, 'invoice_number', v_numero, 'total', v_total,
                            'lavados', v_n, 'desde', v_desde, 'hasta', v_hasta);
end;
$$;
revoke all on function public.cxc_ccf_consolidado(uuid, uuid[]) from public, anon;
grant execute on function public.cxc_ccf_consolidado(uuid, uuid[]) to authenticated;


-- ─────────────────────────────────────────────
-- Anular una venta al crédito revierte su deuda
-- ─────────────────────────────────────────────
create or replace function public.work_orders_anular_credito()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ar    record;
  v_saldo numeric(12,2);
begin
  if new.status <> 'cancelled' or old.status = 'cancelled' then return new; end if;

  if new.consolidated_invoice_id is not null then
    raise exception 'Este lavado ya se facturó en un CCF consolidado: invalidá ese CCF antes de anular' using errcode = '22023';
  end if;

  for v_ar in
    select * from public.accounts_receivable
     where work_order_id = new.id and status in ('open', 'partial', 'overdue')
     for update
  loop
    update public.corporate_accounts
       set current_balance = greatest(0, current_balance - v_ar.balance), updated_at = now()
     where customer_id = v_ar.customer_id
     returning current_balance into v_saldo;
    update public.accounts_receivable set status = 'void', balance = 0, updated_at = now() where id = v_ar.id;
    insert into public.corporate_credit_events
      (organization_id, customer_id, event_type, amount, balance_after, work_order_id, actor_id, reason)
    values (v_ar.organization_id, v_ar.customer_id, 'CHARGE_VOID', v_ar.balance, v_saldo, new.id, auth.uid(),
            'Venta anulada' || case when v_ar.amount > v_ar.balance
                                    then format(' (ya tenía abonado %s)', v_ar.amount - v_ar.balance) else '' end);
  end loop;
  return new;
end;
$$;

drop trigger if exists work_orders_anular_credito on public.work_orders;
create trigger work_orders_anular_credito
  before update of status on public.work_orders
  for each row execute function public.work_orders_anular_credito();


-- ─────────────────────────────────────────────
-- Los lavados al crédito diferidos, para CxC
-- ─────────────────────────────────────────────
create or replace view public.v_lavados_credito
with (security_invoker = true) as
select
  wo.id                 as work_order_id,
  wo.organization_id,
  wo.customer_id,
  wo.order_number,
  wo.created_at,
  wo.total,
  wo.status,
  coalesce(nullif(trim(v.plate), ''), '—') as placa_principal,
  (select string_agg(regexp_replace(i.description_snapshot, '^Aspirado de interiores', 'Aspirado'), ' + ' order by i.sort_order)
     from public.work_order_items i where i.work_order_id = wo.id) as detalle,
  wo.consolidated_invoice_id,
  inv.invoice_number    as ccf_interno,
  fd.status             as dte_status,
  fd.numero_control,
  fd.sello_recepcion
from public.work_orders wo
left join public.vehicles v on v.id = wo.vehicle_id
left join public.invoices inv on inv.id = wo.consolidated_invoice_id
left join lateral (
  select d.status, d.numero_control, d.sello_recepcion
    from public.fiscal_documents d
   where d.invoice_id = wo.consolidated_invoice_id
   order by (d.status in ('ACCEPTED', 'INVALIDATED')) desc, d.created_at desc
   limit 1
) fd on true
where wo.facturacion_diferida;

comment on view public.v_lavados_credito is
  'Ventas al crédito con facturación consolidada: pendientes de facturar o en qué CCF quedaron (0060).';
grant select on public.v_lavados_credito to authenticated;
