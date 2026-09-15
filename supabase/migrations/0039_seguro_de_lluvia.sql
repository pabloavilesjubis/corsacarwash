-- ============================================================
-- Migration: 0039_seguro_de_lluvia.sql
-- Description: Seguro de lluvia — $2.00, 48 horas, un PRO gratis.
--
--   El cliente que paga el seguro tiene derecho a volver, dentro de las 48
--   horas siguientes, a que le laven el mismo carro sin costo si llovió.
--
--   POR QUÉ ES UNA TABLA Y NO UNA LÍNEA MÁS DE LA VENTA: lo que se vende no es
--   un servicio prestado, es una OBLIGACIÓN que queda abierta contra el
--   negocio. Tiene vencimiento, tiene un titular, tiene un vehículo y tiene un
--   estado que cambia solo con el paso del tiempo. Eso no se puede reconstruir
--   mirando work_order_items: hay que poder preguntar «¿qué seguros están
--   vivos ahora mismo?» y que la respuesta sea una fila, no una interpretación.
--
--   DOS REQUISITOS QUE EL SERVIDOR HACE CUMPLIR, no la pantalla:
--     · cliente identificado — no se le puede vender a «Consumidor Final»,
--       porque a la hora de reclamar no habría a quién reconocerle el derecho;
--     · vehículo con placa — el seguro es de UN carro, y sin placa no hay forma
--       de saber cuál.
--   Van validados adentro del RPC: una pantalla se puede saltar, un check del
--   servidor no.
--
--   EL VENCIMIENTO NO SE ESCRIBE, SE CALCULA. `status` guarda sólo lo que
--   alguien hizo (se canjeó, se anuló); que esté vencido sale de comparar
--   valid_until con el reloj. Un estado 'expired' guardado obligaría a un
--   proceso que lo actualice, y el día que ese proceso no corra el sistema
--   estaría diciendo que una póliza vencida sigue viva.
-- ============================================================


-- ─────────────────────────────────────────────
-- 1. EL SERVICIO EN EL CATÁLOGO
--
--    Para que aparezca como línea en la factura y en el detalle de la venta,
--    igual que el aspirado. Sin programa de máquina: no es un lavado.
-- ─────────────────────────────────────────────
insert into public.services
  (id, organization_id, category_id, code, name, description,
   estimated_minutes, taxable, active, sort_order, machine_program)
values
  ('00000000-0000-0000-0004-000000000105', '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0003-000000000001', 'SEGURO-LLUVIA', 'Seguro de lluvia',
   'Cobertura de 48 horas: si llueve, el mismo vehículo vuelve por un lavado PRO sin costo',
   1, true, true, 5, null)
on conflict (id) do update set
  name        = excluded.name,
  description = excluded.description,
  active      = true;


-- ─────────────────────────────────────────────
-- 2. LAS PÓLIZAS
-- ─────────────────────────────────────────────
create table if not exists public.rain_policies (
  id                     uuid        primary key default gen_random_uuid(),
  organization_id        uuid        not null references public.organizations(id) on delete cascade,
  branch_id              uuid        not null references public.branches(id) on delete restrict,

  -- La venta que la originó. Si se anula esa venta, la póliza queda igual como
  -- evidencia de lo que se emitió; por eso no hay on delete cascade.
  work_order_id          uuid        references public.work_orders(id) on delete set null,

  customer_id            uuid        not null references public.customers(id) on delete restrict,
  vehicle_id             uuid        not null references public.vehicles(id) on delete restrict,

  -- La placa se congela acá a propósito. Si mañana se corrige la placa del
  -- vehículo en su ficha, el ticket impreso ese día seguiría diciendo la
  -- anterior, y la póliza tiene que coincidir con el papel que tiene el
  -- cliente en la mano.
  plate                  text        not null,

  price                  numeric(10,2) not null default 0,
  issued_at              timestamptz not null default now(),
  valid_until            timestamptz not null,

  -- Sólo lo que una persona hizo: 'active', 'redeemed', 'cancelled'.
  -- El vencimiento se deduce del reloj, no se guarda.
  status                 text        not null default 'active'
                         check (status in ('active', 'redeemed', 'cancelled')),

  redeemed_at            timestamptz,
  redeemed_work_order_id uuid        references public.work_orders(id) on delete set null,
  redeemed_by            uuid,
  notes                  text,

  created_by             uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.rain_policies is
  'Seguros de lluvia vendidos. Cada fila es una obligación abierta: 48 horas para volver por un PRO sin costo con el mismo vehículo.';

-- Para «¿este carro tiene seguro vivo?», que es la pregunta del POS.
create index if not exists idx_rain_policies_vehiculo
  on public.rain_policies(organization_id, vehicle_id, valid_until desc)
  where status = 'active';

-- Para la pantalla de administración, que ordena por vencimiento.
create index if not exists idx_rain_policies_vigencia
  on public.rain_policies(organization_id, valid_until desc);

create index if not exists idx_rain_policies_placa
  on public.rain_policies(organization_id, plate);

alter table public.rain_policies enable row level security;


-- ─────────────────────────────────────────────
-- 3. EL ESTADO, DERIVADO
--
--    Un solo lugar traduce «lo que pasó + el reloj» a las cuatro palabras que
--    usa el negocio. Si esto viviera en el frontend, la pantalla web y la del
--    teléfono podrían discrepar sobre si una póliza está vencida.
-- ─────────────────────────────────────────────
create or replace function public.corsa_estado_poliza(
  p_status      text,
  p_valid_until timestamptz
) returns text
language sql
stable
as $$
  select case
    when p_status = 'redeemed'   then 'canjeada'
    when p_status = 'cancelled'  then 'anulada'
    when p_valid_until <= now()  then 'vencida'
    -- Últimas 12 horas: es lo que la administración mira para avisarle al
    -- cliente antes de que pierda el derecho que ya pagó.
    when p_valid_until <= now() + interval '12 hours' then 'por_vencer'
    else 'activa'
  end
$$;

grant execute on function public.corsa_estado_poliza(text, timestamptz) to anon, authenticated, service_role;


-- ─────────────────────────────────────────────
-- 4. VISTA PARA LA ADMINISTRACIÓN
-- ─────────────────────────────────────────────
drop view if exists public.v_rain_policies cascade;
create view public.v_rain_policies as
select
  p.id,
  p.organization_id,
  p.branch_id,
  b.name                                   as branch_name,
  p.work_order_id,
  wo.order_number,
  p.customer_id,
  coalesce(nullif(trim(c.trade_name), ''),
           nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
           c.legal_name,
           'Cliente')                      as customer_name,
  c.phone                                  as customer_phone,
  p.vehicle_id,
  p.plate,
  nullif(trim(concat_ws(' ', v.brand, v.model, v.color)), '') as vehicle_label,
  p.price,
  p.issued_at,
  p.valid_until,
  p.status,
  public.corsa_estado_poliza(p.status, p.valid_until) as estado,
  -- Cuánto le queda, en horas. Negativo si ya venció: sirve para ordenar por
  -- «la que está más cerca de perderse» sin tener que hacer la cuenta afuera.
  round(extract(epoch from (p.valid_until - now())) / 3600.0, 1) as horas_restantes,
  p.redeemed_at,
  p.redeemed_work_order_id,
  p.notes,
  (p.issued_at at time zone 'America/El_Salvador')::date  as issued_day
from public.rain_policies p
left join public.branches   b  on b.id = p.branch_id
left join public.customers  c  on c.id = p.customer_id
left join public.vehicles   v  on v.id = p.vehicle_id
left join public.work_orders wo on wo.id = p.work_order_id;

comment on view public.v_rain_policies is
  'Pólizas con su estado ya resuelto (activa, por_vencer, vencida, canjeada, anulada) y las horas que le quedan.';


-- ─────────────────────────────────────────────
-- 5. PERMISOS
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description) values
  ('rain.read',   'rain', 'Ver los seguros de lluvia vendidos'),
  ('rain.sell',   'rain', 'Vender seguro de lluvia en caja'),
  ('rain.redeem', 'rain', 'Registrar el canje de un seguro de lluvia'),
  ('screens.rain', 'screens', 'Pantalla: Seguros de lluvia')
on conflict (code) do nothing;

-- Super Admin y Administrador: todo.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000001',
               '00000000-0000-0000-0002-000000000002')
  and p.code in ('rain.read','rain.sell','rain.redeem','screens.rain')
on conflict do nothing;

-- Gerente: igual que administración.
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000003', p.id
from public.permissions p
where p.code in ('rain.read','rain.sell','rain.redeem','screens.rain')
on conflict do nothing;

-- Supervisor, Caja y Recepción: venden y canjean —es una operación de caja— y
-- pueden consultar la pantalla para responderle a un cliente que pregunta
-- hasta cuándo le vale el seguro.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000004',
               '00000000-0000-0000-0002-000000000005',
               '00000000-0000-0000-0002-000000000006')
  and p.code in ('rain.read','rain.sell','rain.redeem','screens.rain')
on conflict do nothing;

drop policy if exists "rain_policies_select" on public.rain_policies;
create policy "rain_policies_select"
  on public.rain_policies for select
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('rain.read'));

-- Se emiten y se canjean por RPC (security definer), nunca por escritura
-- directa desde la app: así las reglas —48 horas, cliente con placa, una sola
-- vez— no dependen de que la pantalla las respete.
drop policy if exists "rain_policies_manage" on public.rain_policies;
create policy "rain_policies_manage"
  on public.rain_policies for update
  using (organization_id = public.get_my_organization_id()
         and public.has_permission('rain.redeem'))
  with check (organization_id = public.get_my_organization_id()
              and public.has_permission('rain.redeem'));

grant select on public.rain_policies  to authenticated, service_role;
grant select on public.v_rain_policies to authenticated, service_role;


-- ═════════════════════════════════════════════════════════════
-- 6. EMISIÓN Y CANJE, DENTRO DE LA VENTA
--
--   pos_register_sale se reemplaza para que la póliza nazca —o se consuma— en
--   la MISMA transacción que la venta. Si se emitiera después, con una segunda
--   llamada, existiría el instante en que el cliente pagó el seguro y el
--   seguro no existe; y si la segunda llamada falla, alguien pagó por nada.
--
--   Se hace DROP y no CREATE OR REPLACE: agregar parámetros cambia la firma, y
--   dejar las dos versiones haría ambigua cada llamada con nombres.
-- ═════════════════════════════════════════════════════════════
drop function if exists public.pos_register_sale(
  uuid, text, text, numeric, text, boolean, numeric, uuid, uuid, text, text, uuid, text);

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
  p_order_type       text    default 'normal',-- 'normal' | 'flotilla' | 'membresia'
  -- Nuevos: el seguro de lluvia se vende, o se cobra un lavado con él.
  p_rain_insurance   boolean default false,
  p_rain_price       numeric default 0,
  p_rain_policy_id   uuid    default null
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
  v_seguro       numeric(10,2) := 0;
  v_subtotal     numeric(10,2);
  v_tax          numeric(10,2);
  v_method_id    uuid;
  v_method_code  text;
  v_invoice_type text;
  v_invoice_id   uuid;
  v_plate        text;
  v_policy       record;
  v_policy_id    uuid;
  v_policy_json  jsonb := null;
  v_redeem_json  jsonb := null;
begin
  if not public.has_permission('orders.create') then
    raise exception 'No autorizado: se requiere orders.create' using errcode = '42501';
  end if;

  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;

  select organization_id, code into v_org_id, v_branch_code
  from public.branches where id = p_branch_id;

  -- ── Reglas del seguro, antes de tocar nada ──
  --
  -- Se validan acá y no en la pantalla porque son las que sostienen el
  -- derecho: sin titular no hay a quién reconocerle el lavado, y sin placa no
  -- se sabe de qué carro estamos hablando. Que fallen ANTES de crear la orden
  -- evita el peor caso: una venta cobrada y una póliza que no existe.
  if p_rain_insurance then
    if not public.has_permission('rain.sell') then
      raise exception 'No autorizado: se requiere rain.sell' using errcode = '42501';
    end if;
    if p_customer_id is null then
      raise exception 'El seguro de lluvia necesita un cliente identificado: no se puede vender a Consumidor Final'
        using errcode = '22023';
    end if;
    if p_vehicle_id is null then
      raise exception 'El seguro de lluvia necesita un vehículo registrado' using errcode = '22023';
    end if;

    select plate into v_plate from public.vehicles
     where id = p_vehicle_id and organization_id = v_org_id;

    if v_plate is null or trim(v_plate) = '' then
      raise exception 'El vehículo no tiene placa registrada: sin placa el seguro no se puede reclamar'
        using errcode = '22023';
    end if;
  end if;

  -- ── Canje: la póliza se toma antes de cobrar, y bloqueada ──
  --
  -- `for update` evita el caso de dos cajas canjeando la misma póliza a la vez:
  -- la segunda espera, y cuando entra ya la ve canjeada.
  if p_rain_policy_id is not null then
    if not public.has_permission('rain.redeem') then
      raise exception 'No autorizado: se requiere rain.redeem' using errcode = '42501';
    end if;

    select * into v_policy
      from public.rain_policies
     where id = p_rain_policy_id and organization_id = v_org_id
       for update;

    if not found then
      raise exception 'El seguro de lluvia no existe' using errcode = '22023';
    end if;
    if v_policy.status = 'redeemed' then
      raise exception 'Ese seguro ya fue canjeado el %',
        to_char(v_policy.redeemed_at at time zone 'America/El_Salvador', 'DD/MM/YYYY HH24:MI')
        using errcode = '22023';
    end if;
    if v_policy.status = 'cancelled' then
      raise exception 'Ese seguro está anulado' using errcode = '22023';
    end if;
    if v_policy.valid_until <= now() then
      raise exception 'Ese seguro venció el %',
        to_char(v_policy.valid_until at time zone 'America/El_Salvador', 'DD/MM/YYYY HH24:MI')
        using errcode = '22023';
    end if;
    -- El seguro es del carro, no del cliente: se emitió sobre una placa y sólo
    -- se puede usar en esa.
    if p_vehicle_id is not null and v_policy.vehicle_id <> p_vehicle_id then
      raise exception 'Ese seguro es del vehículo %, no del que está en la orden', v_policy.plate
        using errcode = '22023';
    end if;
  end if;

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
    and applicable_from <= public.corsa_hoy()
    and (applicable_to is null or applicable_to >= public.corsa_hoy())
  order by applicable_from desc limit 1;
  v_tax_rate := coalesce(v_tax_rate, 0.13);

  -- Los precios del POS ya llevan IVA incluido: se desglosa hacia atrás.
  v_aspirado := case when p_with_aspirado then coalesce(p_aspirado_price, 0) else 0 end;
  v_seguro   := case when p_rain_insurance then coalesce(p_rain_price, 0) else 0 end;
  v_base     := p_total - v_aspirado - v_seguro;
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
    format('Tamaño %s · %s%s', p_size, p_order_type,
           case when p_rain_policy_id is not null then ' · canje seguro de lluvia' else '' end),
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

  -- ── La póliza, en la misma transacción que el cobro ──
  if p_rain_insurance then
    insert into public.work_order_items (
      work_order_id, service_id, description_snapshot, price_snapshot,
      quantity, unit_price, discount_amount, tax_amount, total, sort_order
    )
    select v_order_id, s.id, s.name, v_seguro,
           1, v_seguro, 0, round(v_seguro - (v_seguro / (1 + v_tax_rate)), 2), v_seguro, 3
    from public.services s
    where s.organization_id = v_org_id and s.code = 'SEGURO-LLUVIA';

    insert into public.rain_policies (
      organization_id, branch_id, work_order_id, customer_id, vehicle_id,
      plate, price, issued_at, valid_until, status, created_by
    ) values (
      v_org_id, p_branch_id, v_order_id, p_customer_id, p_vehicle_id,
      upper(trim(v_plate)), v_seguro, now(),
      -- 48 horas exactas desde el cobro. No «dos días»: si se vendiera a las
      -- 11 de la noche, «dos días» dejaría afuera casi una jornada entera.
      now() + interval '48 hours',
      'active', auth.uid()
    )
    returning id into v_policy_id;

    v_policy_json := jsonb_build_object(
      'id',          v_policy_id,
      'plate',       upper(trim(v_plate)),
      'price',       v_seguro,
      'issued_at',   now(),
      'valid_until', now() + interval '48 hours'
    );
  end if;

  -- ── El canje se consuma ──
  if p_rain_policy_id is not null then
    update public.rain_policies
       set status = 'redeemed',
           redeemed_at = now(),
           redeemed_work_order_id = v_order_id,
           redeemed_by = auth.uid(),
           updated_at = now()
     where id = p_rain_policy_id;

    v_redeem_json := jsonb_build_object(
      'id',    v_policy.id,
      'plate', v_policy.plate,
      'issued_at',   v_policy.issued_at,
      'valid_until', v_policy.valid_until
    );
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

  -- Un canje se cobra en cero: registrar un pago de $0 ensuciaría el arqueo de
  -- caja con movimientos que no movieron plata.
  if v_method_id is not null and p_total > 0 then
    with p as (
      insert into public.payments (
        organization_id, branch_id, payment_method_id, amount, status, received_by
      ) values (
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
    'issued_at',      now(),
    -- Lo que el ticket necesita para imprimir la vigencia.
    'rain_policy',    v_policy_json,
    'rain_redeemed',  v_redeem_json
  );
end;
$$;

revoke all on function public.pos_register_sale(
  uuid, text, text, numeric, text, boolean, numeric, uuid, uuid, text, text, uuid, text,
  boolean, numeric, uuid) from public, anon;
grant execute on function public.pos_register_sale(
  uuid, text, text, numeric, text, boolean, numeric, uuid, uuid, text, text, uuid, text,
  boolean, numeric, uuid) to authenticated, service_role;


-- ─────────────────────────────────────────────
-- 7. CANJE DESDE ADMINISTRACIÓN
--
--    Para el caso en que el lavado ya se hizo y hay que dejar constancia, sin
--    pasar por una venta. Las mismas validaciones: lo que no se puede hacer
--    desde la caja tampoco se puede hacer desde acá.
-- ─────────────────────────────────────────────
create or replace function public.rain_policy_redeem(
  p_policy_id uuid,
  p_notes     text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_policy record;
begin
  if not public.has_permission('rain.redeem') then
    raise exception 'No autorizado: se requiere rain.redeem' using errcode = '42501';
  end if;

  select * into v_policy
    from public.rain_policies
   where id = p_policy_id
     and organization_id = public.get_my_organization_id()
     for update;

  if not found then
    raise exception 'El seguro no existe' using errcode = '22023';
  end if;
  if v_policy.status = 'redeemed' then
    raise exception 'Ese seguro ya fue canjeado' using errcode = '22023';
  end if;
  if v_policy.status = 'cancelled' then
    raise exception 'Ese seguro está anulado' using errcode = '22023';
  end if;
  if v_policy.valid_until <= now() then
    raise exception 'Ese seguro venció el %',
      to_char(v_policy.valid_until at time zone 'America/El_Salvador', 'DD/MM/YYYY HH24:MI')
      using errcode = '22023';
  end if;

  update public.rain_policies
     set status = 'redeemed',
         redeemed_at = now(),
         redeemed_by = auth.uid(),
         notes = coalesce(p_notes, notes),
         updated_at = now()
   where id = p_policy_id;

  return jsonb_build_object('id', p_policy_id, 'plate', v_policy.plate, 'redeemed_at', now());
end $$;

revoke all on function public.rain_policy_redeem(uuid, text) from public, anon;
grant execute on function public.rain_policy_redeem(uuid, text) to authenticated, service_role;
