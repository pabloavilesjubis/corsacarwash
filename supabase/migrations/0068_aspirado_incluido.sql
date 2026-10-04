-- ═══════════════════════════════════════════════════════════════════════
-- 0068 — Aspirado incluido a $0 (flotillas) y líneas en cero fuera del DTE
--
-- Una flotilla con el aspirado incluido lo cobra a $0. En la orden de varios
-- carros eso se perdía: la línea del aspirado sólo se guardaba si costaba
-- más de $0, y el ticket marcaba «no lleva aspirado» con una X. Ahora:
--   · pos_register_sale_multi guarda el aspirado aunque sea $0 y lo marca;
--   · fiscal_sale_for_emission no manda al DTE las líneas de $0: no suman y
--     un ítem en cero es un rechazo de Hacienda que no hace falta arriesgar.
--     El ticket y el historial siguen mostrando el aspirado.
--
-- Incluye la firma de 0064 (p_facturar_ahora) para varios carros: borra la
-- anterior si 0064 todavía no se aplicó.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.pos_register_sale_multi(
  uuid, jsonb, numeric, text, uuid, text, text, uuid, text);

create or replace function public.pos_register_sale_multi(
  p_branch_id        uuid,
  p_lineas           jsonb,   -- [{vehicle_id, service_code, size, price, with_aspirado, aspirado_price}]
  p_total            numeric,
  p_payment_method   text,
  p_customer_id      uuid    default null,
  p_doc_type         text    default 'ticket',
  p_fcf_name         text    default null,
  p_ccf_customer_id  uuid    default null,
  p_order_type       text    default 'normal',
  -- 0064: con facturación consolidada, emitir el CCF de esta venta ahora.
  p_facturar_ahora   boolean default false
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

    -- El aspirado va aunque cueste $0 (incluido en el plan de la flotilla):
    -- es lo que dice al equipo en piso que el carro lleva aspirado (0068).
    if coalesce((v_l->>'with_aspirado')::boolean, false) and v_aspirado_id is not null then
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
      'with_aspirado',   coalesce((v_l->>'with_aspirado')::boolean, false),
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
    v_diferida := coalesce(v_diferida, false) and not coalesce(p_facturar_ahora, false);
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

revoke all on function public.pos_register_sale_multi(
  uuid, jsonb, numeric, text, uuid, text, text, uuid, text, boolean) from public, anon;
grant execute on function public.pos_register_sale_multi(
  uuid, jsonb, numeric, text, uuid, text, text, uuid, text, boolean) to authenticated;

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
   where i.work_order_id = v_inv.work_order_id
     -- Una línea de $0 (el aspirado incluido de una flotilla) no va al DTE:
     -- no suma nada y Hacienda no tiene por qué recibir ítems en cero (0068).
     and not (coalesce(i.unit_price, 0) = 0 and coalesce(i.discount_amount, 0) = 0);

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
