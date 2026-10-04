-- ═══════════════════════════════════════════════════════════════════════
-- 0063 — Adicionales sueltos: aspirado o seguro sin lavado
--
-- Un cliente que se fue sin aspirado o sin seguro de lluvia y lo quiere
-- pagar después. Hasta acá el POS sólo los vendía colgados de un lavado.
--
--   · pos_register_sale acepta p_service_code null: la orden lleva sólo las
--     líneas de los adicionales y queda como order_kind = 'addon_sale';
--   · todo lo demás es igual que una venta: pago, factura y DTE, crédito
--     (credito_cobrar) y facturación consolidada, donde el CCF muestra
--     «fecha · placa · Aspirado»;
--   · v_daily_totals la suma a la venta del día (gross_revenue,
--     venta_facturada; venta_solo_cxc ya toma toda venta diferida), pero no
--     cuenta como vehículo atendido ni entra en el ticket promedio.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.work_orders
  drop constraint if exists work_orders_order_kind_valid,
  add  constraint work_orders_order_kind_valid
    check (order_kind in ('service', 'voucher_sale', 'voucher_gift', 'voucher_redemption', 'addon_sale'));

comment on column public.work_orders.order_kind is
  'service = venta normal; voucher_sale = venta de cupones (plata sin servicio); voucher_gift = regalía (ni plata ni servicio, sólo trazabilidad); voucher_redemption = canje (servicio sin plata); addon_sale = adicionales sin lavado (plata, no cuenta como vehículo).';

create or replace function public.pos_register_sale(
  p_branch_id        uuid,
  p_service_code     text,                    -- 'PRO' | 'ELITE' | 'SIGNATURE' | null: sólo adicionales (0063)
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
  v_solo_adicionales boolean := nullif(trim(coalesce(p_service_code, '')), '') is null;
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

  -- Sólo adicionales (0063): el aspirado o el seguro que el cliente no llevó
  -- con su lavado y paga después. Sin lavado no hay programa de máquina ni
  -- canje de seguro, y el total es exactamente lo de los adicionales.
  if v_solo_adicionales then
    if not (coalesce(p_with_aspirado, false) or coalesce(p_rain_insurance, false)) then
      raise exception 'Elegí un servicio o un adicional para cobrar' using errcode = '22023';
    end if;
    if p_rain_policy_id is not null then
      raise exception 'El canje del seguro de lluvia es un lavado: elegí el servicio' using errcode = '22023';
    end if;
    if abs(p_total - (case when p_with_aspirado then coalesce(p_aspirado_price, 0) else 0 end)
                   - (case when p_rain_insurance then coalesce(p_rain_price, 0) else 0 end)) > 0.005 then
      raise exception 'El total no coincide con los adicionales' using errcode = '22023';
    end if;
    if p_total <= 0 then
      raise exception 'Un adicional suelto sin costo no se registra como venta' using errcode = '22023';
    end if;
  else
    select id, name, machine_program
    into v_service_id, v_service_name, v_program
    from public.services
    where organization_id = v_org_id and code = p_service_code and active = true;

    if v_service_id is null then
      raise exception 'Servicio % no existe en el catálogo', p_service_code using errcode = '22023';
    end if;
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
    source, status, payment_status, order_kind,
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
    case when v_solo_adicionales then 'addon_sale' else 'service' end,
    v_subtotal, 0, v_tax, p_total,
    now(), now(), now(),
    case when v_solo_adicionales then format('Adicionales sin lavado · %s', p_order_type)
         else format('Tamaño %s · %s%s', p_size, p_order_type,
                     case when p_rain_policy_id is not null then ' · canje seguro de lluvia' else '' end) end,
    auth.uid()
  )
  returning id into v_order_id;

  if not v_solo_adicionales then
    insert into public.work_order_items (
      work_order_id, service_id, description_snapshot, price_snapshot,
      quantity, unit_price, discount_amount, tax_amount, total, sort_order
    ) values (
      v_order_id, v_service_id, format('%s %s', v_service_name, p_size), v_base,
      1, v_base, 0, round(v_base - (v_base / (1 + v_tax_rate)), 2), v_base, 1
    );
  end if;

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
        raise exception 'Este cliente factura en CCF consolidado: elegí la placa del carro' using errcode = '22023';
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
    'size',           case when v_solo_adicionales then null else p_size end,
    'solo_adicionales', v_solo_adicionales,
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

create or replace view public.v_daily_totals as
 SELECT branch_id,
    (created_at AT TIME ZONE 'America/El_Salvador'::text)::date AS sale_date,
    COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'::text AND (order_kind = ANY (ARRAY['service'::text, 'voucher_sale'::text, 'addon_sale'::text]))), 0::numeric) AS gross_revenue,
    COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'voucher_sale'::text), 0::numeric) AS voucher_revenue,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND (order_kind = ANY (ARRAY['service'::text, 'voucher_redemption'::text]))) AS services_delivered,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'voucher_redemption'::text) AS vouchers_redeemed,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'voucher_sale'::text) AS voucher_sales,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'voucher_gift'::text) AS voucher_gifts,
        CASE
            WHEN count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'service'::text) > 0 THEN round(sum(total) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'service'::text) / count(*) FILTER (WHERE status <> 'cancelled'::text AND order_kind = 'service'::text)::numeric, 2)
            ELSE 0::numeric
        END AS avg_ticket,
    COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'::text AND order_kind = ANY (ARRAY['service'::text, 'voucher_sale'::text, 'addon_sale'::text]) AND NOT facturacion_diferida), 0::numeric) AS venta_facturada,
    COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'::text AND facturacion_diferida), 0::numeric) AS venta_solo_cxc,
    count(*) FILTER (WHERE status <> 'cancelled'::text AND facturacion_diferida AND order_kind = 'service'::text) AS servicios_solo_cxc
   FROM work_orders wo
  GROUP BY branch_id, ((created_at AT TIME ZONE 'America/El_Salvador'::text)::date);
