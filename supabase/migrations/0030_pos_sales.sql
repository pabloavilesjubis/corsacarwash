-- ============================================================
-- Migration: 0030_pos_sales.sql
-- Description: Registro real de ventas del POS + catálogo de servicios real.
--
--   BUG DE ORIGEN: POSPage llamaba
--     create_work_order(p_branch_id, p_customer_id, p_vehicle_id,
--                       p_service_name, p_size, p_total, p_payment_method,
--                       p_with_aspirado, p_doc_type, p_fcf_name,
--                       p_ccf_customer_id, p_order_type)
--   pero la única definición (0010) tiene otra firma:
--     create_work_order(p_branch_id, p_customer_id, p_vehicle_id,
--                       p_source, p_priority, p_notes, p_services jsonb)
--   PostgREST no encontraba la función, así que "Confirmar y cobrar" fallaba
--   y NINGUNA venta se estaba guardando. De ahí que no hubiera historial.
--
--   Esta migración:
--   1. Siembra el catálogo real (PRO / ÉLITE / SIGNATURE + Aspirado). El
--      seed de 0009 (LAV-BASIC, LAV-COMP…) era de demo y nunca se usó desde
--      el POS: se desactiva, no se borra, para no romper referencias.
--   2. Agrega services.machine_program — el número que el operario marca en
--      la máquina. Estaba hardcodeado en el frontend (servicePrograms.ts).
--   3. pos_register_sale(): una sola transacción que crea la orden, sus
--      líneas, el pago y la factura, y devuelve lo que el ticket necesita.
--   4. v_sales_history: una fila por venta, para la pantalla de Ventas.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. PROGRAMA DE MÁQUINA POR SERVICIO
-- ─────────────────────────────────────────────
alter table public.services
  add column if not exists machine_program smallint;

comment on column public.services.machine_program is
  'Número de programa que el operario activa en la máquina. Se imprime en grande en el ticket.';


-- ─────────────────────────────────────────────
-- 2. CATÁLOGO REAL
--    El de 0009 era demo. Se desactiva en vez de borrarse: work_order_items
--    referencia services con on delete restrict, y un borrado rompería
--    cualquier orden histórica.
-- ─────────────────────────────────────────────
update public.services
set active = false
where organization_id = '00000000-0000-0000-0000-000000000001'
  and code in ('LAV-BASIC','LAV-COMP','LAV-PREM','ASPIRADO','ENCERADO',
               'PULIDO-FAR','VESTIDURAS','DETAILING','LAV-MOTOR');

insert into public.services
  (id, organization_id, category_id, code, name, description,
   estimated_minutes, taxable, active, sort_order, machine_program)
values
  ('00000000-0000-0000-0004-000000000101', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0003-000000000001', 'PRO', 'PRO',
   'Elimina toda suciedad y brinda brillo excepcional en minutos', 20, true, true, 1, 1),
  ('00000000-0000-0000-0004-000000000102', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0003-000000000001', 'ELITE', 'ÉLITE',
   'PRO + acabado superior con acondicionador de pintura', 30, true, true, 2, 2),
  ('00000000-0000-0000-0004-000000000103', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0003-000000000001', 'SIGNATURE', 'SIGNATURE',
   'Experiencia completa con acondicionador de pintura y cera protectora', 45, true, true, 3, 3),
  -- El aspirado es un complemento, no un programa de máquina: sin número.
  ('00000000-0000-0000-0004-000000000104', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0003-000000000001', 'ASPIRADO-INT', 'Aspirado de interiores',
   'Aspirado de interiores, sin importar el tamaño del vehículo', 10, true, true, 4, null)
on conflict (id) do update set
  name            = excluded.name,
  description     = excluded.description,
  machine_program = excluded.machine_program,
  active          = true;


-- ─────────────────────────────────────────────
-- 3. RPC — registrar una venta del POS
--
--    El POS cobra y entrega en el mismo acto (el auto sale lavado), así que
--    la orden nace 'delivered' y 'paid'. No hay flujo de cuenta abierta.
-- ─────────────────────────────────────────────
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
  p_order_type       text    default 'normal' -- 'normal' | 'flotilla' | 'membresia'
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
  v_subtotal     numeric(10,2);
  v_tax          numeric(10,2);
  v_method_id    uuid;
  v_method_code  text;
  v_invoice_type text;
  v_invoice_id   uuid;
begin
  if not public.has_permission('orders.create') then
    raise exception 'No autorizado: se requiere orders.create' using errcode = '42501';
  end if;

  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;

  select organization_id, code into v_org_id, v_branch_code
  from public.branches where id = p_branch_id;

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
    and applicable_from <= current_date
    and (applicable_to is null or applicable_to >= current_date)
  order by applicable_from desc limit 1;
  v_tax_rate := coalesce(v_tax_rate, 0.13);

  -- Los precios del POS ya llevan IVA incluido: se desglosa hacia atrás.
  v_aspirado := case when p_with_aspirado then coalesce(p_aspirado_price, 0) else 0 end;
  v_base     := p_total - v_aspirado;
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
    -- El tamaño y el tipo de orden no tienen columna propia; van a notas para
    -- no perderlos y poder reconstruir el ticket.
    format('Tamaño %s · %s', p_size, p_order_type),
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

  if v_method_id is not null then
    with p as (
      insert into public.payments (
        organization_id, branch_id, payment_method_id, amount, status, received_by
      ) values (
        -- 0013 acepta pending/approved/rejected/voided/refunded: un cobro
        -- efectuado en caja es 'approved', no 'completed'.
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

  insert into public.invoices (
    organization_id, branch_id, work_order_id, customer_id,
    invoice_type, invoice_number, subtotal, tax_amount, total,
    status, issued_at, created_by
  ) values (
    v_org_id, p_branch_id, v_order_id,
    coalesce(p_ccf_customer_id, p_customer_id),
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
    'issued_at',      now()
  );
end;
$$;

comment on function public.pos_register_sale is
  'Registra una venta del POS (orden + líneas + pago + factura) en una sola transacción. Devuelve lo que necesita el ticket.';

grant execute on function public.pos_register_sale(
  uuid, text, text, numeric, text, boolean, numeric, uuid, uuid, text, text, uuid, text
) to authenticated;


-- ─────────────────────────────────────────────
-- 4. VISTA — historial de ventas, una fila por venta
-- ─────────────────────────────────────────────
-- `create or replace view` no admite agregar columnas en medio ni renombrarlas,
-- así que se recrea. Es seguro: ninguna otra vista depende de ésta.
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
  wo.subtotal,
  wo.tax_total,
  wo.total,
  wo.notes,
  -- Servicio principal = la primera línea; el aspirado va aparte.
  (select wi.description_snapshot
     from public.work_order_items wi
    where wi.work_order_id = wo.id
    order by wi.sort_order limit 1)              as service_name,
  exists (
    select 1 from public.work_order_items wi
    join public.services s on s.id = wi.service_id
    where wi.work_order_id = wo.id and s.code = 'ASPIRADO-INT'
  )                                              as with_aspirado,
  -- Las líneas reales de la venta. Sin esto, el ticket y la factura tenían que
  -- reconstruirlas y terminaban con el precio del aspirado hardcodeado: si el
  -- precio cambia, los documentos reimpresos mentirían.
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
  v.plate                                        as plate,
  pm.name                                        as payment_method,
  inv.id                                         as invoice_id,
  inv.invoice_type,
  inv.invoice_number,
  -- Estado del DTE. Mientras no se transmita al MH no hay JSON ni sello, y la
  -- pantalla de Ventas usa esto para saber qué descargas ofrecer.
  fd.id                                          as fiscal_document_id,
  coalesce(fd.status, 'no_emitido')              as dte_status,
  (fd.payload is not null)                       as has_dte_payload
from public.work_orders wo
join public.branches b            on b.id = wo.branch_id
left join public.customers c      on c.id = wo.customer_id
left join public.vehicles v       on v.id = wo.vehicle_id
left join public.invoices inv     on inv.work_order_id = wo.id
left join public.fiscal_documents fd on fd.invoice_id = inv.id
left join public.payment_allocations pa on pa.work_order_id = wo.id
left join public.payments pay     on pay.id = pa.payment_id
left join public.payment_methods pm on pm.id = pay.payment_method_id;

comment on view public.v_sales_history is
  'Una fila por venta con cliente, servicio, placa, pago y documento fiscal. Alimenta la pantalla de Ventas.';


-- ─────────────────────────────────────────────
-- 5. PANTALLA «Ventas»
--    Sigue el esquema de 0027: un permiso screens.* por pantalla.
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description)
values ('screens.sales', 'screens', 'Pantalla: Ventas (historial)')
on conflict (code) do nothing;

-- Quien ya puede ver reportes de ventas o el resumen del día, entra.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where p.code = 'screens.sales'
  and r.organization_id = '00000000-0000-0000-0000-000000000001'
  and exists (
    select 1 from public.role_permissions rp
    join public.permissions p2 on p2.id = rp.permission_id
    where rp.role_id = r.id and p2.code in ('reports.sales', 'screens.analytics')
  )
on conflict do nothing;
