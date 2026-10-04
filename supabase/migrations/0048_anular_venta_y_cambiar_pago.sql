-- ════════════════════════════════════════════════════════════════════
-- 0048 — Anular una venta y cambiar su forma de pago
-- ════════════════════════════════════════════════════════════════════
--
-- QUIÉN
--   Super Admin y Administrador lo hacen directo (permisos sales.void y
--   sales.change_payment). Cualquier otro usuario, sólo si un SUPER ADMIN
--   escribe su contraseña en ese momento: la pantalla abre una sesión
--   aparte con esas credenciales y llama a estas funciones CON ESA SESIÓN.
--   Así auth.uid() es el Super Admin que autorizó —verificado por Supabase
--   Auth, no declarado por el navegador— y p_requested_by es quien lo pidió.
--
-- QUÉ NO SE PUEDE
--   - Anular una venta cuyo DTE está sellado y vigente: primero se invalida
--     ante Hacienda (la pantalla lo hace en el mismo paso, firmando en la
--     estación fiscal). Recién con el DTE INVALIDATED se anula la venta.
--   - Anular con un DTE a medio camino (armado, firmado o pendiente de
--     respuesta): ese número está reservado y tiene que terminar primero.
--   - Cambiar la forma de pago de una venta anulada o de un canje (no tiene
--     pago). El DTE de CORSA no lleva la forma de pago, así que cambiarla no
--     toca nada ante Hacienda.
--
-- Todo cambio queda en sale_adjustments: qué, antes, después, quién lo pidió,
-- quién lo autorizó y por qué. Además siguen los triggers de audit_logs.

-- ─────────────────────────────────────────────
-- 1. PERMISOS
-- ─────────────────────────────────────────────

insert into public.permissions (code, module, description) values
  ('sales.void',           'sales', 'Anular ventas (invalida el DTE ante Hacienda si estaba sellado)'),
  ('sales.change_payment', 'sales', 'Cambiar la forma de pago de una venta')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000001',   -- Super Admin
               '00000000-0000-0000-0002-000000000002')   -- Administrador
  and p.code in ('sales.void', 'sales.change_payment')
on conflict do nothing;


-- ─────────────────────────────────────────────
-- 2. RESPONSABLE FIJO DE LAS INVALIDACIONES
-- ─────────────────────────────────────────────
-- Hacienda pide en cada invalidación quién responde por ella. Es siempre la
-- misma persona de CORSA, así que vive con el emisor y no se escribe cada vez.

alter table public.fiscal_issuer_config
  add column if not exists invalidacion_responsable_nombre   text,
  add column if not exists invalidacion_responsable_tipo_doc text,
  add column if not exists invalidacion_responsable_num_doc  text;

alter table public.fiscal_issuer_config
  drop constraint if exists fiscal_issuer_config_responsable_tipo_doc,
  add  constraint fiscal_issuer_config_responsable_tipo_doc
    check (invalidacion_responsable_tipo_doc is null
           or invalidacion_responsable_tipo_doc in ('36', '13', '02', '03', '37'));


-- ─────────────────────────────────────────────
-- 3. AUDITORÍA DE AJUSTES
-- ─────────────────────────────────────────────

create table if not exists public.sale_adjustments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  work_order_id   uuid not null references public.work_orders(id) on delete restrict,
  kind            text not null check (kind in ('void', 'payment_method')),
  old_value       jsonb,
  new_value       jsonb,
  reason          text,
  requested_by    uuid,
  authorized_by   uuid not null,
  created_at      timestamptz not null default now()
);

create index if not exists sale_adjustments_order_idx on public.sale_adjustments (work_order_id, created_at desc);

alter table public.sale_adjustments enable row level security;

drop policy if exists "sale_adjustments_select" on public.sale_adjustments;
create policy "sale_adjustments_select" on public.sale_adjustments
  for select to authenticated
  using (organization_id = public.get_my_organization_id());

revoke all on public.sale_adjustments from anon;
grant select on public.sale_adjustments to authenticated;


-- ─────────────────────────────────────────────
-- 4. QUIÉN PUEDE
-- ─────────────────────────────────────────────

create or replace function public.sale_adjust_authorize(p_permission text, p_requested_by uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sesión inválida' using errcode = '28000';
  end if;
  -- Autorización de otro usuario: SÓLO un Super Admin puede autorizar.
  if p_requested_by is not null and p_requested_by <> auth.uid() then
    if not exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid() and ur.role_id = '00000000-0000-0000-0002-000000000001'
    ) then
      raise exception 'Sólo un Super Admin puede autorizar esta operación a otro usuario'
        using errcode = '42501';
    end if;
  elsif not public.has_permission(p_permission) then
    raise exception 'No autorizado: se requiere el permiso % o la autorización de un Super Admin', p_permission
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.sale_adjust_authorize(text, uuid) from public, anon;


-- ─────────────────────────────────────────────
-- 5. CAMBIAR LA FORMA DE PAGO
-- ─────────────────────────────────────────────

create or replace function public.sale_change_payment_method(
  p_work_order_id       uuid,
  p_payment_method_code text,
  p_reason              text default null,
  p_requested_by        uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid := public.get_my_organization_id();
  v_wo      public.work_orders;
  v_pay     public.payments;
  v_count   int;
  v_new     public.payment_methods;
  v_old     public.payment_methods;
begin
  perform public.sale_adjust_authorize('sales.change_payment', p_requested_by);

  select * into v_wo from public.work_orders
   where id = p_work_order_id and organization_id = v_org
   for update;
  if v_wo.id is null then raise exception 'No existe esa venta' using errcode = 'P0002'; end if;
  if v_wo.status = 'cancelled' then
    raise exception 'La venta está anulada: no se cambia su forma de pago' using errcode = '22023';
  end if;

  select count(*) into v_count
    from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
   where pa.work_order_id = v_wo.id and p.status = 'approved';
  if v_count = 0 then
    raise exception 'Esta venta no tiene un pago registrado' using errcode = '22023';
  elsif v_count > 1 then
    raise exception 'La venta tiene % pagos; cambiarla requiere revisarlos uno por uno', v_count using errcode = '22023';
  end if;

  select p.* into v_pay
    from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
   where pa.work_order_id = v_wo.id and p.status = 'approved'
   for update of p;

  select * into v_new from public.payment_methods
   where organization_id = v_org and code = upper(p_payment_method_code) and active;
  if v_new.id is null then
    raise exception 'Forma de pago desconocida: %', p_payment_method_code using errcode = '22023';
  end if;
  select * into v_old from public.payment_methods where id = v_pay.payment_method_id;
  if v_old.id = v_new.id then
    raise exception 'La venta ya está pagada con %', v_new.name using errcode = '22023';
  end if;

  update public.payments set payment_method_id = v_new.id where id = v_pay.id;

  insert into public.sale_adjustments
    (organization_id, work_order_id, kind, old_value, new_value, reason, requested_by, authorized_by)
  values (v_org, v_wo.id, 'payment_method',
          jsonb_build_object('payment_id', v_pay.id, 'code', v_old.code, 'name', v_old.name),
          jsonb_build_object('payment_id', v_pay.id, 'code', v_new.code, 'name', v_new.name),
          nullif(trim(p_reason), ''), coalesce(p_requested_by, auth.uid()), auth.uid());

  return jsonb_build_object('order_number', v_wo.order_number, 'anterior', v_old.name, 'nueva', v_new.name);
end;
$$;

revoke all on function public.sale_change_payment_method(uuid, text, text, uuid) from public, anon;
grant execute on function public.sale_change_payment_method(uuid, text, text, uuid) to authenticated;


-- ─────────────────────────────────────────────
-- 6. ANULAR LA VENTA
-- ─────────────────────────────────────────────

create or replace function public.sale_void(
  p_work_order_id uuid,
  p_reason        text default null,
  p_requested_by  uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid := public.get_my_organization_id();
  v_wo       public.work_orders;
  v_inv      public.invoices;
  v_fd       record;
  v_motivo   text := nullif(trim(p_reason), '');
  v_pagos    int;
  v_polizas  int;
  v_cupones  int;
begin
  perform public.sale_adjust_authorize('sales.void', p_requested_by);

  select * into v_wo from public.work_orders
   where id = p_work_order_id and organization_id = v_org
   for update;
  if v_wo.id is null then raise exception 'No existe esa venta' using errcode = 'P0002'; end if;
  if v_wo.status = 'cancelled' then
    raise exception 'La venta ya estaba anulada' using errcode = '22023';
  end if;

  select * into v_inv from public.invoices where work_order_id = v_wo.id for update;

  -- El DTE manda. Uno sellado y vigente se invalida ANTES ante Hacienda; uno
  -- a medio camino tiene un número reservado que tiene que terminar primero.
  if v_inv.id is not null then
    for v_fd in
      select status, numero_control from public.fiscal_documents where invoice_id = v_inv.id
    loop
      if v_fd.status = 'ACCEPTED' then
        raise exception 'DTE_SELLADO: el DTE % está sellado por Hacienda. Invalidarlo primero.', v_fd.numero_control
          using errcode = '22023';
      elsif v_fd.status in ('CREATED', 'VALIDATED', 'SIGNED', 'SUBMITTED', 'RETRY_PENDING', 'CONTINGENCY') then
        raise exception 'DTE_EN_CURSO: el DTE % está %; terminá la emisión (y después invalidalo) antes de anular.',
          coalesce(v_fd.numero_control, '(sin número)'), v_fd.status
          using errcode = '22023';
      end if;
    end loop;
  end if;

  -- Cupones: una venta de cupones sólo se anula si ninguno se usó; un canje
  -- anulado devuelve el cupón a vigente.
  if v_wo.order_kind in ('voucher_sale', 'voucher_gift') then
    if exists (select 1 from public.service_vouchers sv join public.voucher_batches vb on vb.id = sv.batch_id
               where vb.work_order_id = v_wo.id and sv.status = 'redeemed') then
      raise exception 'Hay cupones de esta venta ya canjeados: no se puede anular' using errcode = '22023';
    end if;
    update public.service_vouchers sv set status = 'void', void_reason = coalesce(v_motivo, 'Venta anulada')
      from public.voucher_batches vb
     where vb.id = sv.batch_id and vb.work_order_id = v_wo.id and sv.status = 'active';
    get diagnostics v_cupones = row_count;
  elsif v_wo.order_kind = 'voucher_redemption' then
    update public.service_vouchers
       set status = 'active', redeemed_at = null, redeemed_by = null, redeemed_work_order_id = null
     where redeemed_work_order_id = v_wo.id and status = 'redeemed';
    get diagnostics v_cupones = row_count;
  end if;

  -- Seguro de lluvia: la póliza vendida en esta venta se anula; una canjeada
  -- con esta venta vuelve a estar vigente.
  update public.rain_policies set status = 'cancelled', updated_at = now()
   where work_order_id = v_wo.id and status = 'active';
  if exists (select 1 from public.rain_policies where work_order_id = v_wo.id and status = 'redeemed') then
    raise exception 'La póliza de lluvia de esta venta ya se canjeó: no se puede anular' using errcode = '22023';
  end if;
  update public.rain_policies
     set status = 'active', redeemed_at = null, redeemed_by = null, redeemed_work_order_id = null, updated_at = now()
   where redeemed_work_order_id = v_wo.id and status = 'redeemed';
  get diagnostics v_polizas = row_count;

  update public.payments p
     set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = coalesce(v_motivo, 'Venta anulada')
    from public.payment_allocations pa
   where pa.payment_id = p.id and pa.work_order_id = v_wo.id and p.status = 'approved';
  get diagnostics v_pagos = row_count;

  if v_inv.id is not null then
    update public.invoices
       set status = 'voided', voided_at = now(), voided_reason = coalesce(v_motivo, 'Venta anulada')
     where id = v_inv.id;
  end if;

  update public.work_orders
     set status = 'cancelled', cancelled_at = now(),
         payment_status = case when v_pagos > 0 then 'refunded' else payment_status end,
         updated_by = auth.uid(), updated_at = now()
   where id = v_wo.id;

  insert into public.sale_adjustments
    (organization_id, work_order_id, kind, old_value, new_value, reason, requested_by, authorized_by)
  values (v_org, v_wo.id, 'void',
          jsonb_build_object('status', v_wo.status, 'payment_status', v_wo.payment_status,
                             'invoice_status', v_inv.status, 'total', v_wo.total),
          jsonb_build_object('status', 'cancelled', 'pagos_anulados', v_pagos,
                             'cupones', coalesce(v_cupones, 0), 'polizas', v_polizas),
          v_motivo, coalesce(p_requested_by, auth.uid()), auth.uid());

  return jsonb_build_object('order_number', v_wo.order_number, 'pagos_anulados', v_pagos);
end;
$$;

revoke all on function public.sale_void(uuid, text, uuid) from public, anon;
grant execute on function public.sale_void(uuid, text, uuid) to authenticated;
