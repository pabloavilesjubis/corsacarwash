-- ============================================================
-- Migration: 0033_voucher_sale_detail.sql
-- Description: Detalle de la venta de cupones + receptor en los documentos.
--
--   DOS PROBLEMAS:
--
--   1. sell_service_vouchers() no creaba work_order_items, así que el ticket
--      y la factura de una venta de cupones mostraban una sola línea genérica
--      ("Servicio · 1 × $90.00"). El comprador no podía saber qué compró.
--
--   2. Ni el ticket ni la representación gráfica imprimían los datos del
--      receptor. Para un CCF el MH exige nombre, NIT, NRC, actividad
--      económica, dirección, teléfono y correo (fe-ccf-v3.json, receptor.
--      required): un documento sin eso no cumple. v_sales_history no los
--      exponía, así que los documentos no tenían de dónde sacarlos.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. LÍNEAS DE LA VENTA DE CUPONES
-- ─────────────────────────────────────────────
create or replace function public.sell_service_vouchers(
  p_branch_id        uuid,
  p_customer_id      uuid,
  p_service_code     text,
  p_size             text,
  p_quantity         int,
  p_unit_price_service  numeric,
  p_includes_aspirado   boolean default false,
  p_unit_price_aspirado numeric default 0,
  p_payment_method   text    default 'efectivo',
  p_doc_type         text    default 'ticket',
  p_is_gift          boolean default false
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
  v_aspirado_id  uuid;
  v_unit_total   numeric(10,2);
  v_total        numeric(10,2);
  v_linea_serv   numeric(10,2);
  v_linea_asp    numeric(10,2);
  v_tax_rate     numeric(5,4);
  v_subtotal     numeric(10,2);
  v_tax          numeric(10,2);
  v_order_id     uuid;
  v_order_number text;
  v_batch_id     uuid;
  v_last_seq     int;
  v_method_id    uuid;
  v_invoice_type text;
  v_codes        jsonb;
begin
  if not public.has_permission('vouchers.sell') then
    raise exception 'No autorizado: se requiere vouchers.sell' using errcode = '42501';
  end if;

  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity < 1 then
    raise exception 'Indicá cuántos cupones vender' using errcode = '22023';
  end if;

  select organization_id, code into v_org_id, v_branch_code
  from public.branches where id = p_branch_id;

  select id, name into v_service_id, v_service_name
  from public.services
  where organization_id = v_org_id and code = p_service_code and active = true;

  if v_service_id is null then
    raise exception 'Servicio % no existe en el catálogo', p_service_code using errcode = '22023';
  end if;

  select id into v_aspirado_id
  from public.services
  where organization_id = v_org_id and code = 'ASPIRADO-INT' and active = true;

  if not p_is_gift then
    if p_customer_id is null then
      raise exception 'Indicá el cliente al que se le venden los cupones' using errcode = '22023';
    end if;
    if not exists (select 1 from public.customers
                   where id = p_customer_id and organization_id = v_org_id) then
      raise exception 'Cliente no encontrado' using errcode = '22023';
    end if;
  end if;

  if p_is_gift then
    v_unit_total := 0;
    v_total      := 0;
    v_linea_serv := 0;
    v_linea_asp  := 0;
  else
    v_linea_serv := coalesce(p_unit_price_service, 0) * p_quantity;
    v_linea_asp  := case when p_includes_aspirado
                         then coalesce(p_unit_price_aspirado, 0) * p_quantity else 0 end;
    v_unit_total := coalesce(p_unit_price_service, 0)
                  + case when p_includes_aspirado then coalesce(p_unit_price_aspirado, 0) else 0 end;
    v_total      := v_linea_serv + v_linea_asp;
  end if;

  select rate into v_tax_rate
  from public.tax_rates
  where organization_id = v_org_id and active = true
    and applicable_from <= current_date
    and (applicable_to is null or applicable_to >= current_date)
  order by applicable_from desc limit 1;
  v_tax_rate := coalesce(v_tax_rate, 0.13);

  v_subtotal := round(v_total / (1 + v_tax_rate), 2);
  v_tax      := v_total - v_subtotal;

  v_order_number := public.generate_order_number(
    v_org_id, v_branch_code, extract(year from now())::int
  );

  insert into public.work_orders (
    organization_id, branch_id, order_number, customer_id,
    source, status, payment_status, order_kind,
    subtotal, discount_total, tax_total, total,
    checked_in_at, completed_at, delivered_at, notes, created_by
  ) values (
    v_org_id, p_branch_id, v_order_number,
    case when p_is_gift then null else p_customer_id end,
    'walk_in', 'delivered', 'paid',
    case when p_is_gift then 'voucher_gift' else 'voucher_sale' end,
    v_subtotal, 0, v_tax, v_total,
    now(), now(), now(),
    format('%s de %s cupones · %s %s',
           case when p_is_gift then 'Regalía' else 'Venta' end,
           p_quantity, v_service_name, coalesce(p_size, '')),
    auth.uid()
  )
  returning id into v_order_id;

  -- Detalle de la venta. Sin estas líneas el ticket y la factura mostraban
  -- «Servicio · 1 × $90.00», que no dice qué se compró.
  insert into public.work_order_items (
    work_order_id, service_id, description_snapshot, price_snapshot,
    quantity, unit_price, discount_amount, tax_amount, total, sort_order
  ) values (
    v_order_id, v_service_id,
    format('%s cupones de %s %s', p_quantity, v_service_name, coalesce(p_size, '')),
    coalesce(p_unit_price_service, 0),
    p_quantity, coalesce(p_unit_price_service, 0), 0,
    round(v_linea_serv - (v_linea_serv / (1 + v_tax_rate)), 2),
    v_linea_serv, 1
  );

  if p_includes_aspirado and v_aspirado_id is not null then
    insert into public.work_order_items (
      work_order_id, service_id, description_snapshot, price_snapshot,
      quantity, unit_price, discount_amount, tax_amount, total, sort_order
    ) values (
      v_order_id, v_aspirado_id,
      format('%s aspirados de interiores', p_quantity),
      coalesce(p_unit_price_aspirado, 0),
      p_quantity, coalesce(p_unit_price_aspirado, 0), 0,
      round(v_linea_asp - (v_linea_asp / (1 + v_tax_rate)), 2),
      v_linea_asp, 2
    );
  end if;

  if not p_is_gift then
    select id into v_method_id
    from public.payment_methods
    where organization_id = v_org_id
      and code = case p_payment_method
        when 'efectivo' then 'CASH' when 'tarjeta' then 'CARD'
        when 'transferencia' then 'TRANSFER' when 'credito' then 'CORP'
        else 'CASH' end
      and active = true
    limit 1;

    if v_method_id is not null then
      with p as (
        insert into public.payments (organization_id, branch_id, payment_method_id, amount, status, received_by)
        values (v_org_id, p_branch_id, v_method_id, v_total, 'approved', auth.uid())
        returning id
      )
      insert into public.payment_allocations (payment_id, work_order_id, amount)
      select p.id, v_order_id, v_total from p;
    end if;

    v_invoice_type := case when p_doc_type = 'ccf' then 'credito_fiscal' else 'consumidor_final' end;
    insert into public.invoices (
      organization_id, branch_id, work_order_id, customer_id,
      invoice_type, invoice_number, subtotal, tax_amount, total,
      status, issued_at, created_by
    ) values (
      v_org_id, p_branch_id, v_order_id, p_customer_id,
      v_invoice_type, v_order_number, v_subtotal, v_tax, v_total,
      'issued', now(), auth.uid()
    );
  end if;

  insert into public.voucher_batches (
    organization_id, branch_id, customer_id, work_order_id, is_gift,
    quantity, service_code, service_name, size, includes_aspirado,
    unit_price_service, unit_price_aspirado, unit_total, total, sold_by
  ) values (
    v_org_id, p_branch_id,
    case when p_is_gift then null else p_customer_id end,
    v_order_id, p_is_gift,
    p_quantity, p_service_code, v_service_name, p_size, p_includes_aspirado,
    case when p_is_gift then 0 else coalesce(p_unit_price_service, 0) end,
    case when p_is_gift then 0 else coalesce(p_unit_price_aspirado, 0) end,
    v_unit_total, v_total, auth.uid()
  )
  returning id into v_batch_id;

  v_last_seq := public.next_voucher_numbers(v_org_id, p_quantity);

  insert into public.service_vouchers (
    organization_id, batch_id, code, sequence_number, service_code, service_name,
    size, includes_aspirado, is_gift, unit_value
  )
  select
    v_org_id, v_batch_id,
    public.generate_voucher_code(v_org_id),
    v_last_seq + n,
    p_service_code, v_service_name, p_size, p_includes_aspirado, p_is_gift, v_unit_total
  from generate_series(1, p_quantity) as n;

  select jsonb_agg(jsonb_build_object(
           'id', sv.id, 'code', sv.code,
           'sequence', sv.sequence_number, 'token', sv.validation_token)
         order by sv.sequence_number)
  into v_codes
  from public.service_vouchers sv
  where sv.batch_id = v_batch_id;

  return jsonb_build_object(
    'batch_id',       v_batch_id,
    'order_id',       v_order_id,
    'order_number',   v_order_number,
    'quantity',       p_quantity,
    'service_name',   v_service_name,
    'size',           p_size,
    'includes_aspirado', p_includes_aspirado,
    'unit_total',     v_unit_total,
    'subtotal',       v_subtotal,
    'tax',            v_tax,
    'total',          v_total,
    'doc_type',       p_doc_type,
    'is_gift',        p_is_gift,
    'vouchers',       coalesce(v_codes, '[]'::jsonb),
    'issued_at',      now()
  );
end;
$$;


-- ─────────────────────────────────────────────
-- 2. RESCATE — ventas de cupones ya emitidas sin detalle
-- ─────────────────────────────────────────────
do $$
declare r record; v_serv uuid; v_asp uuid; v_rate numeric(5,4) := 0.13;
begin
  for r in
    select vb.*, wo.id as wid
    from public.voucher_batches vb
    join public.work_orders wo on wo.id = vb.work_order_id
    where not exists (select 1 from public.work_order_items wi where wi.work_order_id = wo.id)
  loop
    select id into v_serv from public.services
    where organization_id = r.organization_id and code = r.service_code limit 1;
    select id into v_asp from public.services
    where organization_id = r.organization_id and code = 'ASPIRADO-INT' limit 1;

    if v_serv is not null then
      insert into public.work_order_items (
        work_order_id, service_id, description_snapshot, price_snapshot,
        quantity, unit_price, discount_amount, tax_amount, total, sort_order
      ) values (
        r.wid, v_serv,
        format('%s cupones de %s %s', r.quantity, r.service_name, coalesce(r.size,'')),
        r.unit_price_service, r.quantity, r.unit_price_service, 0,
        round((r.unit_price_service * r.quantity)
              - ((r.unit_price_service * r.quantity) / (1 + v_rate)), 2),
        r.unit_price_service * r.quantity, 1
      );
    end if;

    if r.includes_aspirado and v_asp is not null then
      insert into public.work_order_items (
        work_order_id, service_id, description_snapshot, price_snapshot,
        quantity, unit_price, discount_amount, tax_amount, total, sort_order
      ) values (
        r.wid, v_asp,
        format('%s aspirados de interiores', r.quantity),
        r.unit_price_aspirado, r.quantity, r.unit_price_aspirado, 0,
        round((r.unit_price_aspirado * r.quantity)
              - ((r.unit_price_aspirado * r.quantity) / (1 + v_rate)), 2),
        r.unit_price_aspirado * r.quantity, 2
      );
    end if;
  end loop;
end $$;


-- ─────────────────────────────────────────────
-- 3. RECEPTOR EN LOS DOCUMENTOS
--
--    fe-ccf-v3.json exige en `receptor`: nit, nrc, nombre, codActividad,
--    descActividad, nombreComercial, direccion{departamento, municipio,
--    complemento}, telefono y correo. La representación gráfica tiene que
--    mostrarlos; hasta ahora sólo salía el nombre.
--
--    Se agregan a v_sales_history para que ticket y factura lean de una sola
--    fuente en vez de consultar al cliente por separado y arriesgarse a
--    mostrar datos distintos en cada documento.
-- ─────────────────────────────────────────────
drop view if exists public.v_sales_history;

create view public.v_sales_history as
select
  wo.id                as order_id,
  wo.organization_id,
  wo.branch_id,
  b.name               as branch_name,
  wo.order_number,
  wo.created_at,
  (wo.created_at at time zone 'America/El_Salvador')::date as sale_date,
  wo.status,
  wo.order_kind,
  wo.subtotal,
  wo.tax_total,
  wo.total,
  wo.notes,
  (select wi.description_snapshot
     from public.work_order_items wi
    where wi.work_order_id = wo.id
    order by wi.sort_order limit 1)              as service_name,
  exists (
    select 1 from public.work_order_items wi
    join public.services s on s.id = wi.service_id
    where wi.work_order_id = wo.id and s.code = 'ASPIRADO-INT'
  )                                              as with_aspirado,
  (select jsonb_agg(jsonb_build_object(
            'descripcion', wi.description_snapshot,
            'cantidad',    wi.quantity,
            'unitario',    wi.unit_price,
            'total',       wi.total)
          order by wi.sort_order)
     from public.work_order_items wi
    where wi.work_order_id = wo.id)              as items,
  coalesce(
    case when c.customer_type = 'company'
         then coalesce(c.legal_name, c.trade_name)
         else nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), '')
    end, 'Consumidor Final')                     as customer_name,

  -- ── Receptor, tal como lo exige el MH ──
  c.customer_type,
  c.trade_name                                   as customer_trade_name,
  c.nit                                          as customer_nit,
  c.nrc                                          as customer_nrc,
  c.dui                                          as customer_dui,
  c.cod_actividad                                as customer_cod_actividad,
  c.desc_actividad                               as customer_desc_actividad,
  c.phone                                        as customer_phone,
  coalesce(nullif(c.billing_email, ''), c.email) as customer_email,
  c.fiscal_departamento                          as customer_departamento,
  c.fiscal_municipio                             as customer_municipio,
  c.fiscal_complemento                           as customer_direccion,

  v.plate                                        as plate,
  pm.name                                        as payment_method,
  inv.id                                         as invoice_id,
  inv.invoice_type,
  inv.invoice_number,
  fd.id                                          as fiscal_document_id,
  coalesce(fd.status, 'no_emitido')              as dte_status,
  (fd.payload is not null)                       as has_dte_payload,
  vb.id                                          as voucher_batch_id,
  vb.quantity                                    as voucher_quantity
from public.work_orders wo
join public.branches b            on b.id = wo.branch_id
left join public.customers c      on c.id = wo.customer_id
left join public.vehicles v       on v.id = wo.vehicle_id
left join public.invoices inv     on inv.work_order_id = wo.id
left join public.fiscal_documents fd on fd.invoice_id = inv.id
left join public.payment_allocations pa on pa.work_order_id = wo.id
left join public.payments pay     on pay.id = pa.payment_id
left join public.payment_methods pm on pm.id = pay.payment_method_id
left join public.voucher_batches vb on vb.work_order_id = wo.id;

comment on view public.v_sales_history is
  'Una fila por venta con la naturaleza de la orden y los datos del receptor que el MH exige en la representación gráfica.';
