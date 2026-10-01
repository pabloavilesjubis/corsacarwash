-- ============================================================
-- 0047 — El POS emite el DTE de la venta y espera el sello
--
--   1. fiscal_issuer_config.emitir_en_pos: el interruptor por sucursal.
--   2. fiscal_sale_for_emission: lo que el Worker necesita de una venta
--      para construir su DTE —FCF o CCF—, leído de la base, receptor
--      incluido.
--
-- POR QUÉ UN INTERRUPTOR Y NO «SI HAY CONFIGURACIÓN, EMITIR»
--   Cargar la configuración fiscal y sembrar los correlativos es preparar;
--   empezar a emitir con cada cobro es otra decisión, y se toma cuando el
--   circuito ya pasó contra el sandbox. Con el interruptor apagado el POS no
--   espera nada y el ticket sale como hasta ahora, con el DTE pendiente.
--
-- POR QUÉ EL WORKER LEE LA VENTA Y NO LA RECIBE DEL POS
--   La ruta del POS entra con la sesión de un cajero. Si las líneas y los
--   montos vinieran en el cuerpo, quien tenga esa sesión podría emitir ante
--   Hacienda un documento con importes que no son los de la venta. Así, lo
--   único que el POS dice es «esta factura»; qué se vendió y a cuánto lo dice
--   la base, que es donde quedó registrado el cobro.
-- ============================================================


-- ─────────────────────────────────────────────
-- 1. EL INTERRUPTOR
-- ─────────────────────────────────────────────

alter table public.fiscal_issuer_config
  add column if not exists emitir_en_pos boolean not null default false;

comment on column public.fiscal_issuer_config.emitir_en_pos is
  'Si el POS de la sucursal emite el DTE con cada cobro y espera el sello antes de imprimir el ticket.';


-- ─────────────────────────────────────────────
-- 2. LA VENTA, PARA EMITIR
-- ─────────────────────────────────────────────

-- Precios CON IVA: es como los guarda pos_register_sale (unit_price incluye
-- el impuesto y tax_amount lo extrae). La FCF los usa así; para el CCF el
-- Worker saca la base sin IVA del total.
--
-- El receptor va con la forma del CCF y los formatos del MH: NIT y NRC sin
-- guiones, teléfono sólo dígitos. Es la ficha del cliente tal como está; si
-- le falta algo, el Worker lo dice al validar contra el schema.
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

  return jsonb_build_object(
    'invoice_id',   v_inv.id,
    'branch_id',    v_inv.branch_id,
    'customer_id',  v_inv.customer_id,
    'invoice_type', v_inv.invoice_type,
    'total',        v_inv.total,
    'lineas',       v_lineas,
    'receptor',     v_receptor
  );
end;
$$;

comment on function public.fiscal_sale_for_emission(uuid, uuid) is
  'Para el Worker fiscal: sucursal, tipo, líneas (precios con IVA) y receptor de una factura, para construir su DTE.';

-- Sólo el Worker, con el service role. El navegador ya lee sus ventas por
-- v_sales_history; esto existe para que el Worker no tenga que confiar en él.
revoke all on function public.fiscal_sale_for_emission(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fiscal_sale_for_emission(uuid, uuid) to service_role;
