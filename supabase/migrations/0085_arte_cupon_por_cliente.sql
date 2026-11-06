-- ============================================================
-- Migration: 0085_arte_cupon_por_cliente.sql
-- Description: Arte de fondo del cupón según el titular.
--
--   El arte que estaba cargado (0083, fondo-cupon.png) lleva el logo de
--   Teleperformance y se estaba usando en TODOS los cupones. Ahora:
--   · /cupones/fondo-cupon.png                  genérico, sin logo de cliente
--   · /cupones/fondo-cupon-teleperformance.png  sólo para Teleperformance
--
--   Se decide por el TITULAR del lote (voucher_batches.customer_id), que con
--   0084 es el beneficiario: un lote que Airbox compra para Teleperformance
--   sale con el arte de TP; un lote que Airbox compra para sí, con el
--   genérico. Una regalía (sin titular) usa el genérico.
--
--   Si falla, falla hacia lo seguro: sin valor, el cliente lleva el genérico.
--   Ningún cliente puede quedar con el logo de otro por omisión.
-- ============================================================

alter table public.customers
  add column if not exists fondo_cupon text;

alter table public.customers drop constraint if exists customers_fondo_cupon_ruta;
-- Sólo un archivo de public/cupones/: el valor se mete en el CSS del cupón.
alter table public.customers
  add constraint customers_fondo_cupon_ruta
  check (fondo_cupon is null or fondo_cupon ~ '^/cupones/[a-z0-9-]+\.png$');

comment on column public.customers.fondo_cupon is
  'Arte propio de los cupones de este cliente cuando es el titular (0085). Null = arte genérico /cupones/fondo-cupon.png.';


-- ─────────────────────────────────────────────
-- 1. TELEPERFORMANCE
--    Se busca por nombre y sólo se asigna si hay exactamente un cliente que
--    coincide. Si no, se avisa y TP queda con el genérico hasta asignarlo a
--    mano:  update public.customers set fondo_cupon =
--             '/cupones/fondo-cupon-teleperformance.png' where id = '<id de TP>';
-- ─────────────────────────────────────────────
do $$
declare
  v_ids uuid[];
begin
  select array_agg(id) into v_ids
    from public.customers
   where coalesce(legal_name, '') ilike '%teleperformance%'
      or coalesce(trade_name, '') ilike '%teleperformance%';

  if coalesce(array_length(v_ids, 1), 0) = 1 then
    update public.customers
       set fondo_cupon = '/cupones/fondo-cupon-teleperformance.png'
     where id = v_ids[1];
    raise notice 'Arte de Teleperformance asignado al cliente %', v_ids[1];
  else
    raise warning 'Arte de Teleperformance NO asignado: % clientes coinciden con «teleperformance» (%). Asignalo a mano.',
      coalesce(array_length(v_ids, 1), 0), v_ids;
  end if;
end $$;


-- ─────────────────────────────────────────────
-- 2. CUPONES (pantalla interna, POS y correo de la cuponera)
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
  end                        as facturado_a,
  -- Arte del cupón del titular (0085); null = arte genérico.
  c.fondo_cupon
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
-- 3. PORTAL DE LA CUPONERA
--    Cambia lo que devuelve: hay que borrarla y crearla de nuevo. Las que la
--    llaman (totales, resumen, cupones, entregar) la resuelven al correr.
-- ─────────────────────────────────────────────
drop function if exists public.cuponera_cupones_de(uuid, uuid);

create or replace function public.cuponera_cupones_de(p_customer_id uuid, p_org_id uuid)
returns table (
  id                uuid,
  code              text,
  sequence_number   int,
  validation_token  uuid,
  status            text,
  estado            text,
  service_code      text,
  service_name      text,
  size              text,
  includes_aspirado boolean,
  is_gift           boolean,
  unit_value        numeric,
  created_at        timestamptz,
  redeemed_at       timestamptz,
  batch_id          uuid,
  batch_quantity    int,
  customer_name     text,
  entrega_id        uuid,
  entregado_a       text,
  entregado_correo  text,
  entregado_at      timestamptz,
  fondo_cupon       text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sv.id, sv.code, sv.sequence_number, sv.validation_token, sv.status,
    case
      when sv.status = 'void'     then 'anulado'
      when sv.status = 'redeemed' then 'redimido'
      when e.id is not null       then 'entregado'
      else 'pendiente'
    end,
    sv.service_code, sv.service_name, sv.size, sv.includes_aspirado, sv.is_gift, sv.unit_value,
    sv.created_at, sv.redeemed_at,
    vb.id, vb.quantity,
    public.cuponera_nombre_cliente(vb.customer_id),
    e.id, e.destinatario_nombre, e.destinatario_correo, e.created_at,
    c.fondo_cupon
  from public.service_vouchers sv
  join public.voucher_batches vb on vb.id = sv.batch_id
  left join public.cuponera_entrega_cupones ec on ec.voucher_id = sv.id
  left join public.cuponera_entregas e on e.id = ec.entrega_id
  left join public.customers c on c.id = vb.customer_id
  where vb.customer_id = p_customer_id
    and vb.organization_id = p_org_id
    and vb.cuponera
    and not vb.is_gift;
$$;

revoke all on function public.cuponera_cupones_de(uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
