-- ═══════════════════════════════════════════════════════════════════════
-- 0061 — Correos de CORSA: DTE, lavados al crédito y estados de cuenta
--
-- Los envía la función de servidor /api/correo (Vercel, SMTP de Gmail): el
-- DTE en PDF y su JSON, el agradecimiento por cada lavado al crédito con el
-- historial de CxC, y el estado de cuenta. Cada intento queda acá, salió o
-- no: de esta tabla sale la tarjeta verde/roja de cada venta y el reintento.
--
-- La escribe sólo el servidor (service role). La app la lee.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.envios_correo (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null references public.organizations(id) on delete cascade,
  tipo               text        not null check (tipo in ('dte', 'lavado_credito', 'ccf_consolidado', 'estado_cuenta')),
  work_order_id      uuid        references public.work_orders(id) on delete set null,
  invoice_id         uuid        references public.invoices(id) on delete set null,
  fiscal_document_id uuid        references public.fiscal_documents(id) on delete set null,
  customer_id        uuid        references public.customers(id) on delete set null,
  destinatarios      text[]      not null default '{}',
  bcc                text[]      not null default '{}',
  asunto             text,
  status             text        not null check (status in ('sent', 'failed')),
  error              text,
  message_id         text,
  created_by         uuid,
  created_at         timestamptz not null default now()
);

comment on table public.envios_correo is
  'Cada correo que CORSA intentó enviar (DTE, lavado al crédito, CCF consolidado, estado de cuenta) y si salió (0061).';

create index if not exists idx_envios_correo_orden on public.envios_correo (work_order_id, created_at desc);
create index if not exists idx_envios_correo_factura on public.envios_correo (invoice_id, created_at desc);
create index if not exists idx_envios_correo_cliente on public.envios_correo (customer_id, created_at desc);

alter table public.envios_correo enable row level security;
drop policy if exists "envios_correo_select" on public.envios_correo;
create policy "envios_correo_select" on public.envios_correo for select
  using (organization_id = public.get_my_organization_id());
grant select on public.envios_correo to authenticated;

-- Ventas: el estado del último correo de cada venta, al final de la vista.
create or replace view public.v_sales_history as
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
  vb.quantity                                    as voucher_quantity,
  -- Al final: `create or replace view` sólo admite columnas nuevas al final.
  fd.numero_control                              as dte_numero_control,
  fd.last_error                                  as dte_error,
  -- El último correo de la venta (0061): verde si salió, rojo si falló.
  ce.status                                      as correo_estado,
  ce.created_at                                  as correo_at,
  ce.error                                       as correo_error,
  wo.facturacion_diferida
from public.work_orders wo
join public.branches b            on b.id = wo.branch_id
left join public.customers c      on c.id = wo.customer_id
left join public.vehicles v       on v.id = wo.vehicle_id
left join public.invoices inv     on inv.work_order_id = wo.id
-- El documento vigente de la venta. Una venta puede tener varios: uno
-- rechazado y el que se regeneró después. Manda el sellado; si no hay, el más
-- reciente. Un join directo duplicaba la fila de la venta.
left join lateral (
  select d.id, d.status, d.payload, d.numero_control, d.last_error
    from public.fiscal_documents d
   where d.invoice_id = inv.id
   order by (d.status in ('ACCEPTED', 'INVALIDATED')) desc, d.created_at desc
   limit 1
) fd on true
left join lateral (
  select e.status, e.created_at, e.error
    from public.envios_correo e
   where e.work_order_id = wo.id
   order by e.created_at desc
   limit 1
) ce on true
left join public.payment_allocations pa on pa.work_order_id = wo.id
left join public.payments pay     on pay.id = pa.payment_id
left join public.payment_methods pm on pm.id = pay.payment_method_id
left join public.voucher_batches vb on vb.work_order_id = wo.id;


