-- ═══════════════════════════════════════════════════════════════════════
-- 0082 — Exportar ventas para los contadores
--
-- Desde Ventas se baja un Excel con los DTE de un rango de fechas: una
-- pestaña de contribuyentes (CCF) y otra de consumidores finales (FCF), con
-- todo lo del documento —identificación, receptor, resumen, sello— más lo
-- que no va en el DTE pero el contador pregunta: orden, forma de pago, DUI y
-- NIT de la ficha, invalidación.
--
-- La fuente es el DTE, no la orden: lo que vale ante Hacienda es lo que se
-- selló, y un CCF consolidado de CxC agrupa varias órdenes en un documento.
-- Entran los sellados (ACCEPTED) y los invalidados (rotulados como tales); la
-- fecha es la de emisión del DTE (identificacion.fecEmi).
--
-- Security definer porque reúne facturas, pagos y clientes, que tienen cada
-- uno su permiso: quien ve Ventas tiene que poder bajar el resumen completo.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.sales_export_for_accounting(
  p_from date,
  p_to   date
) returns table (
  fiscal_document_id   uuid,
  branch_name          text,
  dte_type             text,
  estado               text,
  numero_control       text,
  codigo_generacion    text,
  sello_recepcion      text,
  fh_procesamiento     text,
  identificacion       jsonb,
  receptor             jsonb,
  resumen              jsonb,
  cuerpo               jsonb,
  invalidada_at        timestamptz,
  invalidacion_motivo  text,
  invalidacion_sello   text,
  order_number         text,
  order_kind           text,
  consolidado          boolean,
  ordenes_consolidadas text,
  forma_pago           text,
  placa                text,
  cliente_tipo         text,
  cliente_nombre       text,
  cliente_nombre_comercial text,
  cliente_dui          text,
  cliente_nit          text,
  cliente_nrc          text,
  cliente_telefono     text,
  cliente_correo       text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.get_my_organization_id();
begin
  if v_org is null or not (public.has_permission('screens.sales') or public.has_permission('reports.sales')) then
    raise exception 'No tenés permiso para exportar ventas.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Revisá el rango de fechas.' using errcode = '22023';
  end if;
  if p_to - p_from > 366 then
    raise exception 'El rango no puede pasar de un año.' using errcode = '22023';
  end if;

  return query
  select
    f.id,
    b.name,
    f.dte_type,
    f.status,
    f.numero_control,
    f.codigo_generacion,
    f.sello_recepcion,
    f.mh_response->>'fhProcesamiento',
    f.json_original->'identificacion',
    f.json_original->'receptor',
    f.json_original->'resumen',
    f.json_original->'cuerpoDocumento',
    coalesce(inv_mh.accepted_at, f.invalidated_at),
    inv_mh.motivo,
    inv_mh.sello_recepcion,
    wo.order_number,
    wo.order_kind,
    coalesce(i.consolidado, false),
    cons.ordenes,
    pagos.formas,
    v.plate,
    c.customer_type,
    case when c.id is null then null
         when c.customer_type = 'company' then coalesce(c.legal_name, c.trade_name)
         else nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') end,
    c.trade_name,
    c.dui,
    c.nit,
    c.nrc,
    c.phone,
    coalesce(nullif(c.billing_email, ''), c.email)
  from public.fiscal_documents f
  join public.invoices i on i.id = f.invoice_id
  left join public.branches b on b.id = f.branch_id
  left join public.work_orders wo on wo.id = i.work_order_id
  left join public.vehicles v on v.id = wo.vehicle_id
  left join public.customers c on c.id = coalesce(i.receptor_customer_id, i.customer_id)
  left join lateral (
    select fi.accepted_at, fi.motivo, fi.sello_recepcion
      from public.fiscal_invalidations fi
     where fi.fiscal_document_id = f.id and fi.status = 'ACCEPTED'
     order by fi.accepted_at desc
     limit 1
  ) inv_mh on true
  left join lateral (
    select string_agg(o.order_number, ', ' order by o.order_number) as ordenes
      from public.work_orders o
     where o.consolidated_invoice_id = i.id
  ) cons on true
  left join lateral (
    select string_agg(distinct pm.name, ' + ') as formas
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id and p.status is distinct from 'voided'
      join public.payment_methods pm on pm.id = p.payment_method_id
     where pa.invoice_id = i.id or (i.work_order_id is not null and pa.work_order_id = i.work_order_id)
  ) pagos on true
  where f.organization_id = v_org
    and f.branch_id in (select public.get_accessible_branch_ids())
    and f.status in ('ACCEPTED', 'INVALIDATED')
    and f.numero_control is not null
    and (f.json_original->'identificacion'->>'fecEmi')::date between p_from and p_to
  order by f.dte_type, f.json_original->'identificacion'->>'fecEmi',
           f.json_original->'identificacion'->>'horEmi', f.numero_control;
end;
$$;

comment on function public.sales_export_for_accounting(date, date) is
  'DTE sellados e invalidados de un rango (por fecEmi), con venta, pago y cliente, para el Excel de contadores (0082).';

revoke all on function public.sales_export_for_accounting(date, date) from public, anon;
grant execute on function public.sales_export_for_accounting(date, date) to authenticated, service_role;
