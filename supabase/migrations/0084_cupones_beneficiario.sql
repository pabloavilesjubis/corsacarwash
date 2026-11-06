-- ============================================================
-- Migration: 0084_cupones_beneficiario.sql
-- Description: Cupones facturados a una empresa y emitidos a nombre de otra.
--
--   EL CASO
--   Airbox S.A. de C.V. compra cupones para Teleperformance. Se le factura a
--   Airbox, pero los cupones, la Cuponera Digital, el PDF, el correo de
--   entrega y el canje en caja tienen que decir Teleperformance. El
--   beneficiario no debe ver en ningún lado quién los compró.
--
--   CÓMO QUEDA
--   · Quién paga (facturado): work_orders.customer_id e invoices.customer_id,
--     igual que siempre. El DTE, el estado de cuenta y la contabilidad no
--     cambian.
--   · A nombre de quién están los cupones (titular): voucher_batches
--     .customer_id. Sin beneficiario es el mismo cliente que paga, como hasta
--     ahora. Con beneficiario, es el beneficiario.
--
--   Por qué el titular va en voucher_batches.customer_id y no en una columna
--   nueva: todo lo que ve el beneficiario ya sale de ahí (cuponera_cupones_de,
--   cuponera_portal_entregar, cuponera_cargar_lote, lookup_service_voucher,
--   v_vouchers → PDF y correo). Así no hay ninguna consulta que se olvide de
--   cambiar y deje ver al comprador. Ningún reporte usaba ese campo como
--   comprador: los de ventas leen la orden y la factura.
--
--   El comprador sólo se agrega a lo que ve el personal de CORSA:
--   v_vouchers.facturado_a (pantalla Cupones) y cuponera_admin_lotes. Las
--   RPC del portal (cuponera_portal_*) no lo devuelven.
-- ============================================================

comment on column public.voucher_batches.customer_id is
  'Titular de los cupones: a nombre de quién salen y a qué cuponera van (0084). A quién se le facturó está en la orden (work_orders.customer_id); difieren cuando la venta lleva beneficiario.';


-- ─────────────────────────────────────────────
-- 1. VENDER CON BENEFICIARIO
--    Mismo cuerpo que 0033 más p_beneficiary_customer_id. Cambia la firma,
--    así que se borra la vieja: dos versiones dejarían ambigua la llamada.
-- ─────────────────────────────────────────────
drop function if exists public.sell_service_vouchers(uuid, uuid, text, text, int, numeric, boolean, numeric, text, text, boolean);

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
  p_is_gift          boolean default false,
  -- Titular de los cupones cuando no es quien paga (0084). Null = el mismo cliente.
  p_beneficiary_customer_id uuid default null
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
  v_titular_id   uuid;
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

  -- Beneficiario (0084): la factura va a p_customer_id; los cupones, a nombre
  -- del beneficiario. Elegir al mismo cliente como beneficiario es lo mismo
  -- que no elegir ninguno.
  if p_beneficiary_customer_id is not null and p_beneficiary_customer_id <> p_customer_id then
    if p_is_gift then
      raise exception 'Una regalía no lleva beneficiario: sale a nombre de Cliente General' using errcode = '22023';
    end if;
    if not exists (select 1 from public.customers
                   where id = p_beneficiary_customer_id and organization_id = v_org_id) then
      raise exception 'Beneficiario no encontrado' using errcode = '22023';
    end if;
    v_titular_id := p_beneficiary_customer_id;
  else
    v_titular_id := case when p_is_gift then null else p_customer_id end;
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
    v_titular_id,
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
    'beneficiary_customer_id', v_titular_id,
    'vouchers',       coalesce(v_codes, '[]'::jsonb),
    'issued_at',      now()
  );
end;
$$;



revoke all on function public.sell_service_vouchers(uuid, uuid, text, text, int, numeric, boolean, numeric, text, text, boolean, uuid) from public, anon;
grant execute on function public.sell_service_vouchers(uuid, uuid, text, text, int, numeric, boolean, numeric, text, text, boolean, uuid) to authenticated;


-- ─────────────────────────────────────────────
-- 2. CUPONES: a quién se le facturó (sólo personal de CORSA)
--    v_vouchers es security_invoker y el portal no la puede leer (guardián
--    de 0083). customer_name sigue siendo el titular: el PDF y el correo de
--    la cuponera lo usan.
-- ─────────────────────────────────────────────
create or replace view public.v_vouchers
with (security_invoker = true)
as
select
  sv.id,
  sv.organization_id,
  sv.code,
  sv.sequence_number,
  sv.validation_token,
  sv.status,
  sv.service_code,
  sv.service_name,
  sv.size,
  sv.includes_aspirado,
  sv.is_gift,
  sv.unit_value,
  sv.created_at,
  (sv.created_at at time zone 'America/El_Salvador')::date as sold_date,
  sv.redeemed_at,
  (sv.redeemed_at at time zone 'America/El_Salvador')::date as redeemed_date,
  vb.id            as batch_id,
  vb.quantity      as batch_quantity,
  vb.customer_id,
  coalesce(
    case when c.customer_type = 'company'
         then coalesce(c.legal_name, c.trade_name)
         else nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), '')
    end, 'Cliente General')  as customer_name,
  wo.order_number            as redeemed_order_number,
  vb.cuponera                as en_cuponera,
  ce.destinatario_nombre     as entregado_a,
  ce.destinatario_correo     as entregado_correo,
  ce.created_at              as entregado_at,
  -- Sólo cuando el que pagó no es el titular; si es el mismo, null.
  case when sale.customer_id is distinct from vb.customer_id then sale.customer_id end
                             as facturado_customer_id,
  case when sale.customer_id is distinct from vb.customer_id then
    coalesce(
      case when fc.customer_type = 'company'
           then coalesce(fc.legal_name, fc.trade_name)
           else nullif(trim(coalesce(fc.first_name,'') || ' ' || coalesce(fc.last_name,'')), '')
      end, 'Cliente')
  end                        as facturado_a
from public.service_vouchers sv
join public.voucher_batches vb on vb.id = sv.batch_id
left join public.customers c on c.id = vb.customer_id
left join public.work_orders wo on wo.id = sv.redeemed_work_order_id
left join public.work_orders sale on sale.id = vb.work_order_id
left join public.customers fc on fc.id = sale.customer_id
left join public.cuponera_entrega_cupones cec on cec.voucher_id = sv.id
left join public.cuponera_entregas ce on ce.id = cec.entrega_id;

revoke all on public.v_vouchers from anon;
revoke insert, update, delete, truncate, references, trigger on public.v_vouchers from authenticated;
grant select on public.v_vouchers to authenticated;


-- ─────────────────────────────────────────────
-- 3. CUPONERA DIGITAL (pantalla interna): lotes con su facturado
-- ─────────────────────────────────────────────
create or replace function public.cuponera_admin_lotes(p_customer_id uuid)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.get_my_organization_id();
begin
  if not public.has_permission('cuponera.manage') then
    raise exception 'No autorizado: se requiere cuponera.manage' using errcode = '42501';
  end if;

  return query
  select jsonb_build_object(
    'batch_id',          vb.id,
    'created_at',        vb.created_at,
    'quantity',          vb.quantity,
    'service_name',      vb.service_name,
    'size',              vb.size,
    'includes_aspirado', vb.includes_aspirado,
    'unit_total',        vb.unit_total,
    'total',             vb.total,
    'cuponera',          vb.cuponera,
    'order_number',      wo.order_number,
    'anulado',           wo.status = 'cancelled',
    'facturado_a',       case when wo.customer_id is distinct from vb.customer_id
                              then public.cuponera_nombre_cliente(wo.customer_id) end,
    'activos',    (select count(*) from public.service_vouchers sv where sv.batch_id = vb.id and sv.status = 'active'),
    'redimidos',  (select count(*) from public.service_vouchers sv where sv.batch_id = vb.id and sv.status = 'redeemed'),
    'entregados', (select count(*) from public.service_vouchers sv
                     join public.cuponera_entrega_cupones ec on ec.voucher_id = sv.id
                    where sv.batch_id = vb.id)
  )
  from public.voucher_batches vb
  left join public.work_orders wo on wo.id = vb.work_order_id
  where vb.customer_id = p_customer_id
    and vb.organization_id = v_org
    and not vb.is_gift
  order by vb.created_at desc;
end;
$$;

revoke all on function public.cuponera_admin_lotes(uuid) from public, anon;
grant execute on function public.cuponera_admin_lotes(uuid) to authenticated;

notify pgrst, 'reload schema';
