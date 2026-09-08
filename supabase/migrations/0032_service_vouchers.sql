-- ============================================================
-- Migration: 0032_service_vouchers.sql
-- Description: Cupones de servicio (prepago / regalía).
--
--   DOS NÚMEROS, cada uno con su función:
--     `sequence_number`  correlativo interno, consecutivo y sin huecos. Sirve
--                        para control y auditoría del talonario.
--     `code`             el número de cupón: 6 dígitos AL AZAR. Es lo que se
--                        imprime, se teclea y se valida. No se usa el
--                        correlativo para esto porque sería adivinable —
--                        quien tuviera un cupón podría deducir los vecinos.
--
--   NO se reusa public.coupons (0016): esa tabla modela cupones de DESCUENTO
--   promocional — exige promotion_id, guarda max_uses y no tiene dónde poner
--   el servicio comprado ni su precio. Un cupón de acá es otra cosa: un vale
--   prepagado por un servicio concreto, con correlativo, de un solo uso.
--
--   CONTABILIDAD — el punto delicado:
--   La plata entra el día de la VENTA; el servicio se presta el día del CANJE.
--   Contarlos como una venta normal inflaría los servicios del día de la venta
--   y volvería a sumar plata el día del canje. Por eso work_orders gana
--   order_kind:
--     'service'             venta normal: suma plata y suma servicio
--     'voucher_sale'        suma plata, NO suma servicio (total real)
--     'voucher_gift'        regalía: NO suma plata ni servicio, pero queda el
--                           registro de quién la emitió y cuándo
--     'voucher_redemption'  suma servicio, NO suma plata (total 0)
--   El ticket promedio se calcula sólo sobre 'service' y 'voucher_redemption',
--   que son los servicios efectivamente prestados.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. NATURALEZA DE LA ORDEN
-- ─────────────────────────────────────────────
alter table public.work_orders
  add column if not exists order_kind text not null default 'service';

alter table public.work_orders
  drop constraint if exists work_orders_order_kind_valid,
  add  constraint work_orders_order_kind_valid
    check (order_kind in ('service', 'voucher_sale', 'voucher_gift', 'voucher_redemption'));

comment on column public.work_orders.order_kind is
  'service = venta normal; voucher_sale = venta de cupones (plata sin servicio); voucher_gift = regalía (ni plata ni servicio, sólo trazabilidad); voucher_redemption = canje (servicio sin plata).';

create index if not exists idx_work_orders_order_kind
  on public.work_orders(branch_id, order_kind, created_at desc);


-- ─────────────────────────────────────────────
-- 2. CORRELATIVO DE CUPONES
--    Mismo patrón que generate_order_number: fila bloqueada e incrementada
--    dentro de la transacción, para que dos cajas simultáneas no repitan.
-- ─────────────────────────────────────────────
create table if not exists public.voucher_number_sequences (
  organization_id uuid    primary key references public.organizations(id) on delete cascade,
  last_sequence   int     not null default 0
);

alter table public.voucher_number_sequences enable row level security;

create or replace function public.next_voucher_numbers(
  p_organization_id uuid,
  p_quantity        int
)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_last int;
begin
  if p_quantity < 1 then
    raise exception 'La cantidad debe ser al menos 1' using errcode = '22023';
  end if;

  insert into public.voucher_number_sequences (organization_id, last_sequence)
  values (p_organization_id, 0)
  on conflict (organization_id) do nothing;

  -- Se reserva el bloque completo de una vez: pedir número por número dejaría
  -- huecos si otra venta se intercala.
  update public.voucher_number_sequences
  set last_sequence = last_sequence + p_quantity
  where organization_id = p_organization_id
  returning last_sequence - p_quantity into v_last;

  return v_last;  -- primer número del bloque = v_last + 1
end;
$$;

comment on function public.next_voucher_numbers(uuid, int) is
  'Reserva un bloque de correlativos de cupón y devuelve el último número usado antes del bloque.';


-- ─────────────────────────────────────────────
-- 2b. NÚMERO DE CUPÓN — 6 dígitos al azar
--
--     Rango 100000–999999 a propósito: sin ceros a la izquierda, para que lo
--     que se teclea sea exactamente lo que está impreso.
--
--     El espacio es de 900.000 combinaciones. Con el volumen de un carwash el
--     riesgo de colisión es bajo, y de todos modos se reintenta hasta dar con
--     uno libre; el índice único es la garantía final. Si algún día el
--     talonario creciera a decenas de miles de cupones vivos, conviene subir a
--     8 dígitos.
-- ─────────────────────────────────────────────
create or replace function public.generate_voucher_code(p_organization_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_code    text;
  v_intento int := 0;
begin
  loop
    v_code := (100000 + floor(random() * 900000))::int::text;
    exit when not exists (
      select 1 from public.service_vouchers
      where organization_id = p_organization_id and code = v_code
    );
    v_intento := v_intento + 1;
    if v_intento > 100 then
      raise exception 'No se pudo generar un número de cupón libre tras % intentos', v_intento
        using errcode = 'P0001';
    end if;
  end loop;
  return v_code;
end;
$$;

comment on function public.generate_voucher_code(uuid) is
  'Número de cupón: 6 dígitos al azar, sin ceros a la izquierda y libre en la organización.';


-- ─────────────────────────────────────────────
-- 3. LOTE DE VENTA
-- ─────────────────────────────────────────────
create table if not exists public.voucher_batches (
  id                   uuid          primary key default gen_random_uuid(),
  organization_id      uuid          not null references public.organizations(id) on delete restrict,
  branch_id            uuid          not null references public.branches(id) on delete restrict,
  -- Nulo en una regalía: el cupón se emite a nombre de «Cliente General»
  -- porque todavía no se sabe quién lo va a usar.
  customer_id          uuid          references public.customers(id) on delete restrict,
  -- La orden 'voucher_sale' que registró el cobro; de ahí cuelga la factura.
  work_order_id        uuid          references public.work_orders(id) on delete set null,

  -- Una regalía no se cobra ni se factura: no genera ingreso ni DTE.
  is_gift              boolean       not null default false,
  quantity             int           not null check (quantity between 1 and 500),
  service_code         text          not null,
  service_name         text          not null,
  size                 text,
  includes_aspirado    boolean       not null default false,
  unit_price_service   numeric(10,2) not null check (unit_price_service >= 0),
  unit_price_aspirado  numeric(10,2) not null default 0 check (unit_price_aspirado >= 0),
  unit_total           numeric(10,2) not null check (unit_total >= 0),
  total                numeric(10,2) not null check (total >= 0),

  sold_by              uuid          references public.profiles(id) on delete set null,
  created_at           timestamptz   not null default now(),

  -- Una venta tiene siempre cliente y precio; una regalía, ninguno de los dos.
  constraint voucher_batches_sale_has_customer check (
    is_gift or customer_id is not null
  ),
  constraint voucher_batches_gift_is_free check (
    not is_gift or (total = 0 and unit_total = 0)
  )
);

comment on table public.voucher_batches is
  'Una venta de cupones: a quién, cuántos, de qué servicio y a qué precio unitario.';

alter table public.voucher_batches enable row level security;
create index if not exists idx_voucher_batches_customer on public.voucher_batches(customer_id, created_at desc);
create index if not exists idx_voucher_batches_org on public.voucher_batches(organization_id, created_at desc);


-- ─────────────────────────────────────────────
-- 4. CUPÓN
-- ─────────────────────────────────────────────
create table if not exists public.service_vouchers (
  id                  uuid          primary key default gen_random_uuid(),
  organization_id     uuid          not null references public.organizations(id) on delete restrict,
  batch_id            uuid          not null references public.voucher_batches(id) on delete restrict,

  -- Lo que el cajero teclea: 6 dígitos al azar. Inmutable.
  code                text          not null,
  -- Correlativo interno del talonario: consecutivo, sin huecos, para control.
  -- El NOT NULL se aplica más abajo, tras rescatar los cupones ya emitidos.
  sequence_number     int,
  -- Lo que viaja en el QR. Un uuid no se adivina; el correlativo sí, y no
  -- queremos que escanear un cupón ajeno sea cuestión de probar números.
  validation_token    uuid          not null default gen_random_uuid(),

  service_code        text          not null,
  service_name        text          not null,
  size                text,
  includes_aspirado   boolean       not null default false,
  -- En una regalía vale 0 y el cupón impreso dice «Regalía» en vez de importe.
  is_gift             boolean       not null default false,
  unit_value          numeric(10,2) not null check (unit_value >= 0),

  status              text          not null default 'active'
                                    check (status in ('active','redeemed','void')),
  redeemed_at         timestamptz,
  redeemed_by         uuid          references public.profiles(id) on delete set null,
  redeemed_work_order_id uuid       references public.work_orders(id) on delete set null,
  void_reason         text,
  created_at          timestamptz   not null default now(),

  constraint service_vouchers_code_unique unique (organization_id, code),
  -- Un cupón canjeado sin fecha de canje sería un registro imposible de auditar.
  constraint service_vouchers_redeemed_complete check (
    status <> 'redeemed' or redeemed_at is not null
  )
);

comment on table public.service_vouchers is
  'Cupón prepagado de un solo uso. `code` (6 dígitos al azar) es lo que se teclea; `sequence_number` es el correlativo interno; `validation_token` es lo que valida el QR.';

-- ─────────────────────────────────────────────
-- 4b. RE-EJECUCIÓN SOBRE UNA BASE QUE YA TENÍA CUPONES
--
--     `create table if not exists` no toca una tabla existente, así que las
--     columnas agregadas después de la primera corrida no aparecerían. Esto
--     las incorpora y normaliza lo que ya estuviera emitido.
-- ─────────────────────────────────────────────
alter table public.voucher_batches
  add column if not exists is_gift boolean not null default false;
alter table public.voucher_batches
  alter column customer_id drop not null;

alter table public.service_vouchers
  add column if not exists is_gift boolean not null default false,
  add column if not exists sequence_number int;

-- Los cupones de la primera versión usaban el correlativo como número de
-- cupón. Se rescata como correlativo y se les sortea un número nuevo, porque
-- el formato viejo ('000001') ya no cumple el check.
do $$
declare r record;
begin
  update public.service_vouchers
  set sequence_number = code::int
  where sequence_number is null and code ~ '^[0-9]+$';

  for r in
    select id, organization_id from public.service_vouchers
    where code !~ '^[1-9][0-9]{5}$'
  loop
    update public.service_vouchers
    set code = public.generate_voucher_code(r.organization_id)
    where id = r.id;
  end loop;
end $$;

-- Cualquiera que quedara sin correlativo (no debería) toma uno por orden de
-- creación, para poder aplicar el NOT NULL.
with numerados as (
  select id, row_number() over (partition by organization_id order by created_at) as n
  from public.service_vouchers where sequence_number is null
)
update public.service_vouchers sv
set sequence_number = (select coalesce(max(sequence_number), 0)
                       from public.service_vouchers x
                       where x.organization_id = sv.organization_id) + numerados.n
from numerados where numerados.id = sv.id;

alter table public.service_vouchers
  alter column sequence_number set not null;

-- Las restricciones se agregan después del rescate: aplicarlas antes
-- rechazaría las filas viejas.
alter table public.service_vouchers
  drop constraint if exists service_vouchers_code_format,
  add  constraint service_vouchers_code_format check (code ~ '^[1-9][0-9]{5}$');

alter table public.service_vouchers
  drop constraint if exists service_vouchers_sequence_unique,
  add  constraint service_vouchers_sequence_unique unique (organization_id, sequence_number);

-- El correlativo de la organización continúa desde el mayor ya emitido.
insert into public.voucher_number_sequences (organization_id, last_sequence)
select organization_id, max(sequence_number)
from public.service_vouchers group by organization_id
on conflict (organization_id) do update
  set last_sequence = greatest(
        public.voucher_number_sequences.last_sequence, excluded.last_sequence);


alter table public.service_vouchers enable row level security;
create index if not exists idx_service_vouchers_status on public.service_vouchers(organization_id, status, created_at desc);
create index if not exists idx_service_vouchers_batch on public.service_vouchers(batch_id);
create unique index if not exists idx_service_vouchers_token on public.service_vouchers(validation_token);


-- ─────────────────────────────────────────────
-- 5. RLS
-- ─────────────────────────────────────────────
drop policy if exists "voucher_seq_select" on public.voucher_number_sequences;
create policy "voucher_seq_select"
  on public.voucher_number_sequences for select
  using (organization_id = public.get_my_organization_id());

drop policy if exists "voucher_batches_select" on public.voucher_batches;
create policy "voucher_batches_select"
  on public.voucher_batches for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('vouchers.read')
  );

drop policy if exists "service_vouchers_select" on public.service_vouchers;
create policy "service_vouchers_select"
  on public.service_vouchers for select
  using (
    organization_id = public.get_my_organization_id()
    and public.has_permission('vouchers.read')
  );

-- La escritura pasa exclusivamente por los RPC de abajo: no hay policy de
-- insert/update. Así nadie puede marcar un cupón como canjeado por fuera de
-- la validación, ni editar un correlativo.


-- ─────────────────────────────────────────────
-- 6. RPC — vender cupones (POS Administrativo)
--
--    Registra la venta igual que pos_register_sale (orden + pago + factura,
--    con su documento fiscal FCF o CCF) pero marcando order_kind =
--    'voucher_sale', y emite los cupones del bloque correlativo.
-- ─────────────────────────────────────────────
create or replace function public.sell_service_vouchers(
  p_branch_id        uuid,
  p_customer_id      uuid,   -- null cuando es regalía
  p_service_code     text,
  p_size             text,
  p_quantity         int,
  p_unit_price_service  numeric,
  p_includes_aspirado   boolean default false,
  p_unit_price_aspirado numeric default 0,
  p_payment_method   text    default 'efectivo',
  p_doc_type         text    default 'ticket',  -- 'ticket' | 'ccf'
  p_is_gift          boolean default false      -- regalía: sin cobro ni DTE
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
  v_service_name text;
  v_unit_total   numeric(10,2);
  v_total        numeric(10,2);
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

  select name into v_service_name
  from public.services
  where organization_id = v_org_id and code = p_service_code and active = true;

  if v_service_name is null then
    raise exception 'Servicio % no existe en el catálogo', p_service_code using errcode = '22023';
  end if;

  -- En una regalía el cupón no se emite a nombre de nadie en particular:
  -- se entrega y lo usa quien lo tenga.
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
    -- Sin valor: no hubo cobro y no debe sumar a los ingresos del día.
    v_unit_total := 0;
    v_total      := 0;
  else
    v_unit_total := coalesce(p_unit_price_service, 0)
                  + case when p_includes_aspirado then coalesce(p_unit_price_aspirado, 0) else 0 end;
    v_total      := v_unit_total * p_quantity;
  end if;

  select rate into v_tax_rate
  from public.tax_rates
  where organization_id = v_org_id and active = true
    and applicable_from <= current_date
    and (applicable_to is null or applicable_to >= current_date)
  order by applicable_from desc limit 1;
  v_tax_rate := coalesce(v_tax_rate, 0.13);

  -- El precio del cupón lleva IVA incluido, igual que en caja.
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

  -- Pago y factura sólo cuando hubo cobro. Una regalía no genera ninguno de
  -- los dos: no entró dinero y no hay hecho generador que documentar.
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

  -- Documento fiscal: la venta de cupones tributa el día que se cobra.
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

  -- El correlativo es una sola serie para venta y regalía; el número de cupón
  -- se sortea uno por uno. generate_voucher_code() ya descarta los ocupados,
  -- y el índice único cubre la carrera entre dos ventas simultáneas.
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

comment on function public.sell_service_vouchers is
  'Vende un lote de cupones: registra el cobro (order_kind=voucher_sale) y emite los correlativos. Requiere vouchers.sell.';


-- ─────────────────────────────────────────────
-- 7. RPC — consultar un cupón sin consumirlo
--    El cajero teclea el número y ve qué incluye ANTES de canjear.
-- ─────────────────────────────────────────────
create or replace function public.lookup_service_voucher(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.has_permission('vouchers.redeem') then
    raise exception 'No autorizado: se requiere vouchers.redeem' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', sv.id, 'code', sv.code, 'sequence_number', sv.sequence_number,
    'status', sv.status,
    'service_code', sv.service_code, 'service_name', sv.service_name,
    'size', sv.size, 'includes_aspirado', sv.includes_aspirado,
    'unit_value', sv.unit_value,
    'redeemed_at', sv.redeemed_at,
    'customer_name', coalesce(
      case when c.customer_type = 'company' then coalesce(c.legal_name, c.trade_name)
           else nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), '') end,
      'Consumidor Final')
  )
  into v
  from public.service_vouchers sv
  join public.voucher_batches vb on vb.id = sv.batch_id
  left join public.customers c on c.id = vb.customer_id
  where sv.organization_id = public.get_my_organization_id()
    -- Se acepta con o sin ceros a la izquierda: nadie teclea "000042".
    -- Se limpian espacios o guiones que el cajero pueda teclear; el número
    -- son 6 dígitos exactos, sin ceros a la izquierda que rellenar.
    and sv.code = regexp_replace(p_code, '[^0-9]', '', 'g');

  return v;  -- null si no existe
end;
$$;

comment on function public.lookup_service_voucher(text) is
  'Consulta un cupón por número sin consumirlo. Devuelve null si no existe.';


-- ─────────────────────────────────────────────
-- 8. RPC — canjear
--    Crea la orden del servicio prestado con total 0: la plata ya entró el
--    día de la venta y volver a sumarla duplicaría el ingreso.
-- ─────────────────────────────────────────────
create or replace function public.redeem_service_voucher(
  p_code       text,
  p_branch_id  uuid,
  p_vehicle_id uuid default null,
  p_plate      text default null
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
  v_voucher      public.service_vouchers%rowtype;
  v_customer_id  uuid;
  v_service_id   uuid;
  v_program      smallint;
  v_order_id     uuid;
  v_order_number text;
  v_normalized   text;
begin
  if not public.has_permission('vouchers.redeem') then
    raise exception 'No autorizado: se requiere vouchers.redeem' using errcode = '42501';
  end if;

  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;

  select organization_id, code into v_org_id, v_branch_code
  from public.branches where id = p_branch_id;

  v_normalized := regexp_replace(p_code, '[^0-9]', '', 'g');

  -- FOR UPDATE: dos cajas tecleando el mismo número a la vez no pueden
  -- canjearlo dos veces. La segunda espera y encuentra status='redeemed'.
  select * into v_voucher
  from public.service_vouchers
  where organization_id = v_org_id and code = v_normalized
  for update;

  if v_voucher.id is null then
    raise exception 'El cupón % no existe', v_normalized using errcode = 'P0002';
  end if;
  if v_voucher.status = 'redeemed' then
    raise exception 'El cupón % ya fue canjeado el %', v_normalized,
      to_char(v_voucher.redeemed_at at time zone 'America/El_Salvador', 'DD/MM/YYYY HH24:MI')
      using errcode = 'P0001';
  end if;
  if v_voucher.status = 'void' then
    raise exception 'El cupón % está anulado', v_normalized using errcode = 'P0001';
  end if;

  select vb.customer_id into v_customer_id
  from public.voucher_batches vb where vb.id = v_voucher.batch_id;

  select id, machine_program into v_service_id, v_program
  from public.services
  where organization_id = v_org_id and code = v_voucher.service_code and active = true;

  v_order_number := public.generate_order_number(
    v_org_id, v_branch_code, extract(year from now())::int
  );

  -- Total 0 a propósito: el servicio se prestó, pero el ingreso ya se
  -- registró el día de la venta del cupón.
  insert into public.work_orders (
    organization_id, branch_id, order_number, customer_id, vehicle_id,
    source, status, payment_status, order_kind,
    subtotal, discount_total, tax_total, total,
    checked_in_at, completed_at, delivered_at, notes, created_by
  ) values (
    v_org_id, p_branch_id, v_order_number, v_customer_id, p_vehicle_id,
    'walk_in', 'delivered', 'paid', 'voucher_redemption',
    0, 0, 0, 0,
    now(), now(), now(),
    format('Canje de cupón %s · %s%s', v_voucher.code, v_voucher.service_name,
           case when p_plate is not null then ' · ' || p_plate else '' end),
    auth.uid()
  )
  returning id into v_order_id;

  if v_service_id is not null then
    insert into public.work_order_items (
      work_order_id, service_id, description_snapshot, price_snapshot,
      quantity, unit_price, discount_amount, tax_amount, total, sort_order
    ) values (
      v_order_id, v_service_id,
      format('%s %s (cupón %s)', v_voucher.service_name, coalesce(v_voucher.size,''), v_voucher.code),
      0, 1, 0, 0, 0, 0, 1
    );
  end if;

  update public.service_vouchers
  set status = 'redeemed',
      redeemed_at = now(),
      redeemed_by = auth.uid(),
      redeemed_work_order_id = v_order_id
  where id = v_voucher.id;

  return jsonb_build_object(
    'voucher_id',     v_voucher.id,
    'code',           v_voucher.code,
    'sequence_number', v_voucher.sequence_number,
    'order_id',       v_order_id,
    'order_number',   v_order_number,
    'service_code',   v_voucher.service_code,
    'service_name',   v_voucher.service_name,
    'machine_program', v_program,
    'size',           v_voucher.size,
    'includes_aspirado', v_voucher.includes_aspirado,
    'unit_value',     v_voucher.unit_value,
    'redeemed_at',    now()
  );
end;
$$;

comment on function public.redeem_service_voucher is
  'Canjea un cupón (un solo uso) y registra el servicio prestado con total 0. Requiere vouchers.redeem.';

grant execute on function public.sell_service_vouchers(uuid, uuid, text, text, int, numeric, boolean, numeric, text, text, boolean) to authenticated;
grant execute on function public.lookup_service_voucher(text) to authenticated;
grant execute on function public.redeem_service_voucher(text, uuid, uuid, text) to authenticated;
grant execute on function public.next_voucher_numbers(uuid, int) to authenticated;
grant execute on function public.generate_voucher_code(uuid) to authenticated;


-- ─────────────────────────────────────────────
-- 9. VISTAS
-- ─────────────────────────────────────────────

-- El historial de ventas gana la naturaleza de la orden para poder distinguir
-- en pantalla una venta de cupones de un servicio prestado.
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
  'Una fila por venta, con la naturaleza de la orden (service / voucher_sale / voucher_redemption).';


-- Cupones con su cliente y su estado, para la pantalla de Cupones.
-- Se recrea en vez de reemplazarse: `create or replace view` no admite
-- agregar columnas en medio ni renombrarlas, y esta vista ganó
-- sequence_number e is_gift después de su primera versión.
drop view if exists public.v_vouchers;

create view public.v_vouchers as
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
  -- Una regalía no tiene titular: el cupón se imprime a nombre de
  -- «Cliente General» y así se muestra también en pantalla.
  coalesce(
    case when c.customer_type = 'company'
         then coalesce(c.legal_name, c.trade_name)
         else nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), '')
    end, 'Cliente General')  as customer_name,
  wo.order_number            as redeemed_order_number
from public.service_vouchers sv
join public.voucher_batches vb on vb.id = sv.batch_id
left join public.customers c on c.id = vb.customer_id
left join public.work_orders wo on wo.id = sv.redeemed_work_order_id;

comment on view public.v_vouchers is
  'Cupones con cliente, estado y la orden donde se canjearon. Alimenta la pantalla de Cupones.';


-- Resumen del día separando lo que es plata de lo que es servicio.
-- Mismo motivo que arriba: ganó voucher_gifts entre columnas existentes.
drop view if exists public.v_daily_totals;

create view public.v_daily_totals as
select
  wo.branch_id,
  (wo.created_at at time zone 'America/El_Salvador')::date as sale_date,
  -- Plata que entró: ventas normales + venta de cupones. El canje no suma
  -- (su ingreso se contabilizó el día de la venta) y la regalía tampoco,
  -- porque nunca hubo cobro.
  coalesce(sum(wo.total) filter (
    where wo.status <> 'cancelled' and wo.order_kind in ('service','voucher_sale')), 0)
    as gross_revenue,
  coalesce(sum(wo.total) filter (
    where wo.status <> 'cancelled' and wo.order_kind = 'voucher_sale'), 0)
    as voucher_revenue,
  -- Servicios prestados: ventas normales + canjes. La venta de cupones no
  -- presta ningún servicio ese día.
  count(*) filter (
    where wo.status <> 'cancelled' and wo.order_kind in ('service','voucher_redemption'))
    as services_delivered,
  count(*) filter (
    where wo.status <> 'cancelled' and wo.order_kind = 'voucher_redemption')
    as vouchers_redeemed,
  count(*) filter (
    where wo.status <> 'cancelled' and wo.order_kind = 'voucher_sale')
    as voucher_sales,
  count(*) filter (
    where wo.status <> 'cancelled' and wo.order_kind = 'voucher_gift')
    as voucher_gifts,
  -- Ticket promedio: sólo servicios cobrados en el momento. Incluir los canjes
  -- (que valen 0) lo hundiría, e incluir la venta de cupones lo inflaría.
  case
    when count(*) filter (where wo.status <> 'cancelled' and wo.order_kind = 'service') > 0
    then round(
      sum(wo.total) filter (where wo.status <> 'cancelled' and wo.order_kind = 'service')
      / count(*) filter (where wo.status <> 'cancelled' and wo.order_kind = 'service'), 2)
    else 0
  end as avg_ticket
from public.work_orders wo
group by wo.branch_id, (wo.created_at at time zone 'America/El_Salvador')::date;

comment on view public.v_daily_totals is
  'Totales del día separando plata (ventas + cupones vendidos) de servicio (ventas + canjes). El ticket promedio excluye ambos casos de cupón.';


-- ─────────────────────────────────────────────
-- 10. PERMISOS Y PANTALLAS
-- ─────────────────────────────────────────────
insert into public.permissions (code, module, description) values
  ('vouchers.read',   'vouchers', 'Ver cupones emitidos'),
  ('vouchers.sell',   'vouchers', 'Vender cupones (POS Administrativo)'),
  ('vouchers.redeem', 'vouchers', 'Canjear cupones en caja'),
  ('screens.pos_admin', 'screens', 'Pantalla: POS Administrativo'),
  ('screens.coupons',   'screens', 'Pantalla: Cupones')
on conflict (code) do nothing;

-- Super Admin y Administrador: todo.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000001',
               '00000000-0000-0000-0002-000000000002')
  and p.code in ('vouchers.read','vouchers.sell','vouchers.redeem',
                 'screens.pos_admin','screens.coupons')
on conflict do nothing;

-- Gerente: vende, canjea y consulta.
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000003', p.id
from public.permissions p
where p.code in ('vouchers.read','vouchers.sell','vouchers.redeem',
                 'screens.pos_admin','screens.coupons')
on conflict do nothing;

-- Caja, Recepción y Supervisor: canjean, pero NO venden ni entran al POS
-- Administrativo. Es la separación que pidió el negocio.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000004',   -- Supervisor
               '00000000-0000-0000-0002-000000000005',   -- Caja
               '00000000-0000-0000-0002-000000000006')   -- Recepción
  and p.code in ('vouchers.redeem','vouchers.read','screens.coupons')
on conflict do nothing;
