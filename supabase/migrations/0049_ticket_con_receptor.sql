-- ═══════════════════════════════════════════════════════════════════════
-- 0049 — Ticket a nombre de un cliente: sus datos van en el DTE
--
-- Hasta acá la FCF del POS salía siempre sin receptor: «A nombre de…» era un
-- texto libre que sólo se imprimía en el papel. Ahora el cajero busca al
-- cliente en el modal de cobro y la factura guarda A QUIÉN se le emite:
--
--   invoices.receptor_customer_id
--     CCF                → el cliente del CCF
--     ticket con nombre  → el cliente elegido
--     ticket genérico    → null, aunque haya cliente en la caja
--
-- customer_id no cambia de significado (es el de la venta: cuentas por
-- cobrar, historial). Hacía falta la columna aparte porque con customer_id
-- solo no se distingue un ticket genérico de uno con nombre cuando el
-- cliente de la caja y el del ticket son el mismo.
--
-- pos_register_sale: misma firma; el receptor ya llegaba en
-- p_ccf_customer_id (el POS manda ahí también el del ticket). Ahora además se
-- verifica que sea de la organización: va a parar a un documento fiscal.
--
-- fiscal_sale_for_emission: devuelve `receptor_fcf` para el ticket con
-- nombre. Y vuelve a devolver `receptor` para el CCF: esa parte de la 0047
-- se agregó al archivo después de correrlo, y producción quedó sin ella.
--
-- Las facturas anteriores quedan con receptor_customer_id null: si alguna
-- se emite tarde, sale como salía, sin receptor.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.invoices
  add column if not exists receptor_customer_id uuid
    references public.customers(id) on delete restrict;

comment on column public.invoices.receptor_customer_id is
  'A quién se emite el documento fiscal: el cliente del CCF o del ticket con nombre. Null = ticket genérico de mostrador (0049).';

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
    'delivered', 'paid',
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
  if v_method_id is not null and p_total > 0 then
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
    'fcf_name',       p_fcf_name,
    'issued_at',      now(),
    -- Lo que el ticket necesita para imprimir la vigencia.
    'rain_policy',    v_policy_json,
    'rain_redeemed',  v_redeem_json
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
  if v_inv.work_order_id is null then
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
