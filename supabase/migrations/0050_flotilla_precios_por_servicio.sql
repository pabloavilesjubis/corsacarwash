-- ═══════════════════════════════════════════════════════════════════════
-- 0050 — Flotillas con precio negociado para PRO, ÉLITE y SIGNATURE
--
-- 0031 modeló el acuerdo de una flotilla como «un precio ÉLITE» (único o por
-- tamaño) más el aspirado. En la práctica hay flotillas que negocian también
-- PRO o SIGNATURE, cada uno a su precio. En vez de sumar doce columnas a
-- fleet_pricing, cada servicio negociado es una fila:
--
--   fleet_service_prices (fleet_id, service_code)
--     per_size = false → price            (cualquier tamaño)
--     per_size = true  → price_s/m/l      (por tamaño)
--
-- Una flotilla tiene de una a tres filas: sólo los servicios que negoció. El
-- POS ofrece en modo flotilla exactamente ésos.
--
-- fleet_pricing se queda con el aspirado. Sus columnas elite_* siguen
-- existiendo (el POS anterior a este cambio las lee) y se siguen escribiendo
-- cuando la flotilla negocia ÉLITE, pero ya no son obligatorias: una
-- flotilla que sólo negoció PRO no tiene precio ÉLITE que guardar.
--
-- Datos: el ÉLITE de cada flotilla existente se copia como su fila ELITE.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.fleet_service_prices (
  fleet_id      uuid          not null references public.fleets(id) on delete cascade,
  service_code  text          not null check (service_code in ('PRO', 'ELITE', 'SIGNATURE')),
  per_size      boolean       not null default false,
  price         numeric(10,2),
  price_s       numeric(10,2),
  price_m       numeric(10,2),
  price_l       numeric(10,2),
  updated_at    timestamptz   not null default now(),
  updated_by    uuid          references public.profiles(id) on delete set null,
  primary key (fleet_id, service_code),

  -- Sin esto se podría guardar una línea «por tamaño» sin los tres precios,
  -- y el POS cobraría null.
  constraint fleet_service_prices_complete check (
    case when per_size
      then price_s is not null and price_m is not null and price_l is not null
      else price is not null
    end
  ),
  constraint fleet_service_prices_non_negative check (
    coalesce(price, 0) >= 0 and coalesce(price_s, 0) >= 0
    and coalesce(price_m, 0) >= 0 and coalesce(price_l, 0) >= 0
  )
);

comment on table public.fleet_service_prices is
  'Precio negociado por flotilla y servicio (PRO/ELITE/SIGNATURE). Una fila por servicio que la flotilla negoció (0050).';

alter table public.fleet_service_prices enable row level security;

drop policy if exists "fleet_service_prices_select" on public.fleet_service_prices;
create policy "fleet_service_prices_select"
  on public.fleet_service_prices for select
  using (
    fleet_id in (
      select f.id from public.fleets f
      where f.organization_id = public.get_my_organization_id()
    )
  );

drop policy if exists "fleet_service_prices_manage" on public.fleet_service_prices;
create policy "fleet_service_prices_manage"
  on public.fleet_service_prices for all
  using (
    fleet_id in (
      select f.id from public.fleets f
      where f.organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.manage')
  )
  with check (
    fleet_id in (
      select f.id from public.fleets f
      where f.organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.manage')
  );

-- El ÉLITE que ya estaba negociado pasa a su fila.
insert into public.fleet_service_prices (fleet_id, service_code, per_size, price, price_s, price_m, price_l)
select fleet_id, 'ELITE', elite_per_size,
       case when elite_per_size then null else elite_price end,
       case when elite_per_size then elite_price_s end,
       case when elite_per_size then elite_price_m end,
       case when elite_per_size then elite_price_l end
  from public.fleet_pricing
 where (elite_per_size and elite_price_s is not null and elite_price_m is not null and elite_price_l is not null)
    or (not elite_per_size and elite_price is not null)
on conflict (fleet_id, service_code) do nothing;

-- ÉLITE deja de ser obligatorio en fleet_pricing: ahora es una línea más.
alter table public.fleet_pricing drop constraint if exists fleet_pricing_mode_complete;

comment on column public.fleet_pricing.elite_per_size is
  'Obsoleto desde 0050: el precio ÉLITE vive en fleet_service_prices. Se mantiene sincronizado para el POS anterior.';

-- Precio negociado de una flotilla para un servicio y tamaño. Null si la
-- flotilla no negoció ese servicio.
create or replace function public.fleet_service_price(p_fleet_id uuid, p_service_code text, p_size text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when sp.per_size then
      case upper(p_size)
        when 'S' then sp.price_s
        when 'M' then sp.price_m
        when 'L' then sp.price_l
      end
    else sp.price
  end
  from public.fleet_service_prices sp
  join public.fleets f on f.id = sp.fleet_id
  where sp.fleet_id = p_fleet_id
    and sp.service_code = upper(p_service_code)
    and f.organization_id = public.get_my_organization_id();
$$;

grant execute on function public.fleet_service_price(uuid, text, text) to authenticated;

-- La de 0031 queda como atajo de la nueva, para no romper a quien la llame.
create or replace function public.fleet_elite_price(p_fleet_id uuid, p_size text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select public.fleet_service_price(p_fleet_id, 'ELITE', p_size);
$$;
