-- ═══════════════════════════════════════════════════════════════════════
-- 0081 — Productos y servicios del POS administrativo
--
-- El POS administrativo vendía sólo cupones. Ahora tiene su propio catálogo
-- de productos y servicios (lo que no es un lavado: un ambientador, un
-- detallado, un servicio a una empresa) y los factura con FCF o CCF a un
-- cliente de la base, como cualquier venta.
--
--   · services.admin_catalog  el ítem es del POS administrativo: sólo se ve y
--                             se vende ahí. La caja no lo ofrece (su catálogo
--                             de lavados está fijo).
--   · services.item_type      producto (bien) o servicio: decide el tipoItem
--                             del DTE (1 o 2) y la unidad de medida.
--   · services.default_price  precio sugerido, con IVA; se puede cambiar al
--                             facturar.
--
-- admin_sell_items registra la venta como una «venta sin lavado» (order_kind
-- addon_sale, 0063): así entra sola en Ventas, en el cierre de caja y en la
-- inteligencia de negocio. Un ítem sin machine_program nunca cuenta como
-- lavado (v_lavados, 0074).
--
-- Lo maneja quien tiene vouchers.sell, el mismo permiso que abre el POS
-- administrativo.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 1. Catálogo
-- ─────────────────────────────────────────────
alter table public.services
  add column if not exists admin_catalog boolean       not null default false,
  add column if not exists item_type     text          not null default 'servicio',
  add column if not exists default_price numeric(10,2);

alter table public.services drop constraint if exists services_item_type_check;
alter table public.services
  add constraint services_item_type_check check (item_type in ('producto', 'servicio'));
alter table public.services drop constraint if exists services_default_price_check;
alter table public.services
  add constraint services_default_price_check check (default_price is null or default_price >= 0);
-- Un ítem del POS administrativo nunca es un programa de máquina: si lo fuera,
-- contaría como lavado.
alter table public.services drop constraint if exists services_admin_catalog_no_machine;
alter table public.services
  add constraint services_admin_catalog_no_machine check (not admin_catalog or machine_program is null);

comment on column public.services.admin_catalog is
  'Ítem del catálogo del POS administrativo (0081): sólo se factura desde ahí.';
comment on column public.services.item_type is
  'producto (bien, tipoItem 1 en el DTE) o servicio (tipoItem 2) (0081).';
comment on column public.services.default_price is
  'Precio sugerido con IVA para el POS administrativo (0081).';

-- Quien vende en el POS administrativo mantiene su catálogo, y sólo ése: los
-- lavados y el resto de services siguen siendo de settings.manage.
drop policy if exists "services_admin_catalog_manage" on public.services;
create policy "services_admin_catalog_manage" on public.services for all
  using (organization_id = public.get_my_organization_id()
         and admin_catalog
         and public.has_permission('vouchers.sell'))
  with check (organization_id = public.get_my_organization_id()
              and admin_catalog
              and machine_program is null
              and public.has_permission('vouchers.sell'));

-- ─────────────────────────────────────────────
-- 2. Venta
--
-- p_items: [{ service_id, cantidad, precio, descripcion? }], precios con IVA.
-- Un CCF se emite al cliente; un FCF sale a su nombre (receptor_customer_id).
-- ─────────────────────────────────────────────
create or replace function public.admin_sell_items(
  p_branch_id      uuid,
  p_customer_id    uuid,
  p_items          jsonb,
  p_payment_method text default 'efectivo',
  p_doc_type       text default 'ticket'
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org_id       uuid;
  v_branch_code  text;
  v_tax_rate     numeric(5,4);
  v_total        numeric(12,2) := 0;
  v_subtotal     numeric(12,2);
  v_tax          numeric(12,2);
  v_order_id     uuid;
  v_order_number text;
  v_method_id    uuid;
  v_invoice_id   uuid;
  v_it           jsonb;
  v_srv          public.services%rowtype;
  v_cant         numeric;
  v_precio       numeric;
  v_linea        numeric(12,2);
  v_desc         text;
  v_orden        int := 0;
begin
  if not public.has_permission('vouchers.sell') then
    raise exception 'No autorizado: el POS administrativo requiere vouchers.sell' using errcode = '42501';
  end if;
  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;
  select organization_id, code into v_org_id, v_branch_code from public.branches where id = p_branch_id;

  if p_customer_id is null
     or not exists (select 1 from public.customers where id = p_customer_id and organization_id = v_org_id and active) then
    raise exception 'Elegí el cliente al que se le factura' using errcode = '22023';
  end if;
  if p_doc_type not in ('ticket', 'ccf') then
    raise exception 'Documento inválido: ticket (FCF) o ccf' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agregá al menos un producto o servicio' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Máximo 50 líneas por factura' using errcode = '22023';
  end if;

  -- Primero se valida todo: una línea mala no deja una orden a medias.
  for v_it in select * from jsonb_array_elements(p_items) loop
    select * into v_srv from public.services
     where id = (v_it->>'service_id')::uuid and organization_id = v_org_id and admin_catalog and active;
    if v_srv.id is null then
      raise exception 'Un producto o servicio no existe o está inactivo' using errcode = '22023';
    end if;
    v_cant   := (v_it->>'cantidad')::numeric;
    v_precio := (v_it->>'precio')::numeric;
    if v_cant is null or v_cant <= 0 or v_cant > 100000 then
      raise exception 'Revisá la cantidad de «%»', v_srv.name using errcode = '22023';
    end if;
    if v_precio is null or v_precio < 0 then
      raise exception 'Revisá el precio de «%»', v_srv.name using errcode = '22023';
    end if;
    v_total := v_total + round(v_cant * v_precio, 2);
  end loop;
  if v_total <= 0 then
    raise exception 'La factura tiene que tener un importe' using errcode = '22023';
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

  v_order_number := public.generate_order_number(v_org_id, v_branch_code, extract(year from now())::int);

  insert into public.work_orders (
    organization_id, branch_id, order_number, customer_id,
    source, status, payment_status, order_kind,
    subtotal, discount_total, tax_total, total,
    checked_in_at, completed_at, delivered_at, notes, created_by
  ) values (
    v_org_id, p_branch_id, v_order_number, p_customer_id,
    'walk_in', 'delivered', 'paid', 'addon_sale',
    v_subtotal, 0, v_tax, v_total,
    now(), now(), now(), 'POS administrativo', auth.uid()
  )
  returning id into v_order_id;

  for v_it in select * from jsonb_array_elements(p_items) loop
    select * into v_srv from public.services where id = (v_it->>'service_id')::uuid;
    v_cant   := (v_it->>'cantidad')::numeric;
    v_precio := (v_it->>'precio')::numeric;
    v_linea  := round(v_cant * v_precio, 2);
    v_desc   := left(coalesce(nullif(trim(v_it->>'descripcion'), ''), v_srv.name), 1000);
    v_orden  := v_orden + 1;
    insert into public.work_order_items (
      work_order_id, service_id, description_snapshot, price_snapshot,
      quantity, unit_price, discount_amount, tax_amount, total, sort_order
    ) values (
      v_order_id, v_srv.id, v_desc, v_precio,
      v_cant, v_precio, 0, round(v_linea - v_linea / (1 + v_tax_rate), 2), v_linea, v_orden
    );
  end loop;

  select id into v_method_id
    from public.payment_methods
   where organization_id = v_org_id
     and code = case p_payment_method
       when 'efectivo' then 'CASH' when 'tarjeta' then 'CARD'
       when 'transferencia' then 'TRANSFER' else 'CASH' end
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

  insert into public.invoices (
    organization_id, branch_id, work_order_id, customer_id, receptor_customer_id,
    invoice_type, invoice_number, subtotal, tax_amount, total,
    status, issued_at, created_by
  ) values (
    v_org_id, p_branch_id, v_order_id, p_customer_id,
    case when p_doc_type = 'ticket' then p_customer_id end,
    case when p_doc_type = 'ccf' then 'credito_fiscal' else 'consumidor_final' end,
    v_order_number, v_subtotal, v_tax, v_total,
    'issued', now(), auth.uid()
  )
  returning id into v_invoice_id;

  return jsonb_build_object(
    'order_id',     v_order_id,
    'order_number', v_order_number,
    'invoice_id',   v_invoice_id,
    'subtotal',     v_subtotal,
    'tax',          v_tax,
    'total',        v_total,
    'doc_type',     p_doc_type
  );
end;
$$;

comment on function public.admin_sell_items(uuid, uuid, jsonb, text, text) is
  'Factura productos y servicios del POS administrativo (0081) a un cliente, con FCF o CCF.';

revoke all on function public.admin_sell_items(uuid, uuid, jsonb, text, text) from public, anon;
grant execute on function public.admin_sell_items(uuid, uuid, jsonb, text, text) to authenticated, service_role;

-- ─────────────────────────────────────────────
-- 3. El DTE: cada línea dice si es bien o servicio
--
-- Igual que en 0068, más tipoItem y uniMedida por línea. El Worker los usa
-- si vienen; uno anterior los ignora y manda todo como servicio.
-- ─────────────────────────────────────────────
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
           'montoDescu',  i.discount_amount,
           -- 0081: un producto del POS administrativo es un bien (tipoItem 1,
           -- unidad 59); todo lo demás, servicio (tipoItem 2, unidad 99).
           'tipoItem',    case when s.item_type = 'producto' then 1 else 2 end,
           'uniMedida',   case when s.item_type = 'producto' then 59 else 99 end
         ) order by i.sort_order, i.created_at), '[]'::jsonb)
    into v_lineas
    from public.work_order_items i
    left join public.services s on s.id = i.service_id
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
