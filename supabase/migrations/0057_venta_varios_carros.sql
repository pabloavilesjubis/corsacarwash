-- ═══════════════════════════════════════════════════════════════════════
-- 0057 — Una venta con varios carros
--
-- Un cliente (empresa, rent a car, familia) trae varios carros y paga todo
-- junto: una orden, una factura, un DTE. Cada carro es su línea de servicio
-- —«ÉLITE M · P123456»— más su aspirado si lo lleva, así el documento dice
-- qué carro se lavó con qué servicio.
--
-- Es una función aparte de pos_register_sale para no tocar el cobro de un
-- carro, que es el de todos los días. Lo que no maneja a propósito: seguro de
-- lluvia, canje de seguro y cupones. Son de UN carro; con varios se dan
-- aparte.
--
-- El DTE no cambia: fiscal_sale_for_emission ya arma una línea por cada
-- work_order_item de la orden.
--
-- work_orders.vehicle_id queda con el primer carro (la columna es única); las
-- placas de todos van en las líneas.
-- ═══════════════════════════════════════════════════════════════════════

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
    'delivered', 'paid',
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

  if v_method_id is not null and p_total > 0 then
    with p as (
      insert into public.payments (organization_id, branch_id, payment_method_id, amount, status, received_by)
      values (v_org_id, p_branch_id, v_method_id, p_total, 'approved', auth.uid())
      returning id
    )
    insert into public.payment_allocations (payment_id, work_order_id, amount)
    select p.id, v_order_id, p_total from p;
  end if;

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

  return jsonb_build_object(
    'order_id',     v_order_id,
    'order_number', v_order_number,
    'invoice_id',   v_invoice_id,
    'subtotal',     v_subtotal,
    'tax',          v_tax,
    'total',        p_total,
    'doc_type',     p_doc_type,
    'fcf_name',     p_fcf_name,
    'issued_at',    now(),
    'lineas',       v_resumen
  );
end;
$$;

comment on function public.pos_register_sale_multi(uuid, jsonb, numeric, text, uuid, text, text, uuid, text) is
  'Venta del POS con varios carros (0057): una orden, una factura, una línea por carro y su aspirado.';

revoke all on function public.pos_register_sale_multi(uuid, jsonb, numeric, text, uuid, text, text, uuid, text) from public, anon;
grant execute on function public.pos_register_sale_multi(uuid, jsonb, numeric, text, uuid, text, text, uuid, text) to authenticated;
