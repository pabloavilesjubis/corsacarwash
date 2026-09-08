-- ============================================================
-- Migration: 0031_fleet_pricing.sql
-- Description: Precios negociados de flotilla en una tabla real.
--
--   Hasta ahora los precios ÉLITE por tamaño vivían serializados como JSON
--   dentro de fleet_contracts.terms — un campo `text` pensado para las
--   condiciones del contrato. El propio código lo marcaba como provisional
--   ("For now, store as fleet metadata"). Eso impedía consultarlos desde SQL,
--   validarlos o agregarles el aspirado sin volver a parsear texto.
--
--   Modelo nuevo, calcado de cómo se negocia en la práctica:
--   - Un precio único para cualquier tamaño (el caso común), o
--   - precio distinto por S/M/L cuando la empresa lo pide.
--   - El aspirado de interiores es opcional y, cuando aplica, va a un precio
--     único sin importar el tamaño.
-- ============================================================

create table if not exists public.fleet_pricing (
  fleet_id          uuid        primary key references public.fleets(id) on delete cascade,

  -- ÉLITE
  elite_per_size    boolean     not null default false,
  elite_price       numeric(10,2),   -- se usa cuando elite_per_size = false
  elite_price_s     numeric(10,2),
  elite_price_m     numeric(10,2),
  elite_price_l     numeric(10,2),

  -- Aspirado de interiores: un solo precio para cualquier tamaño.
  aspirado_enabled  boolean     not null default false,
  aspirado_price    numeric(10,2),

  updated_at        timestamptz not null default now(),
  updated_by        uuid        references public.profiles(id) on delete set null,

  -- Coherencia según el modo elegido: sin esto se podría guardar una flotilla
  -- "por tamaño" sin los tres precios, y el POS cobraría null.
  constraint fleet_pricing_mode_complete check (
    case when elite_per_size
      then elite_price_s is not null and elite_price_m is not null and elite_price_l is not null
      else elite_price is not null
    end
  ),
  constraint fleet_pricing_aspirado_complete check (
    not aspirado_enabled or aspirado_price is not null
  ),
  constraint fleet_pricing_non_negative check (
    coalesce(elite_price, 0) >= 0 and coalesce(elite_price_s, 0) >= 0
    and coalesce(elite_price_m, 0) >= 0 and coalesce(elite_price_l, 0) >= 0
    and coalesce(aspirado_price, 0) >= 0
  )
);

comment on table public.fleet_pricing is
  'Precios negociados por flotilla. Reemplaza el JSON que vivía en fleet_contracts.terms.';
comment on column public.fleet_pricing.elite_per_size is
  'false = un precio para cualquier tamaño (elite_price); true = precio por S/M/L.';

alter table public.fleet_pricing enable row level security;

create policy "fleet_pricing_select"
  on public.fleet_pricing for select
  using (
    fleet_id in (
      select f.id from public.fleets f
      where f.organization_id = public.get_my_organization_id()
    )
  );

create policy "fleet_pricing_manage"
  on public.fleet_pricing for all
  using (
    fleet_id in (
      select f.id from public.fleets f
      where f.organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.manage')
  );


-- ─────────────────────────────────────────────
-- MIGRACIÓN DE DATOS — rescatar lo que haya en terms
-- ─────────────────────────────────────────────
do $$
declare
  r record;
  v_terms jsonb;
begin
  for r in
    select fc.fleet_id, fc.terms
    from public.fleet_contracts fc
    where fc.terms is not null and fc.terms <> ''
  loop
    begin
      v_terms := r.terms::jsonb;
    exception when others then
      -- terms es texto libre: si no es JSON, no hay precios que rescatar.
      continue;
    end;

    if v_terms ? 'elite_price_s' then
      insert into public.fleet_pricing (
        fleet_id, elite_per_size, elite_price_s, elite_price_m, elite_price_l
      ) values (
        r.fleet_id, true,
        (v_terms->>'elite_price_s')::numeric,
        (v_terms->>'elite_price_m')::numeric,
        (v_terms->>'elite_price_l')::numeric
      )
      on conflict (fleet_id) do nothing;
    end if;
  end loop;
end $$;


-- ─────────────────────────────────────────────
-- RESOLUCIÓN DE PRECIO
--   Una sola fuente de verdad para el POS y para los reportes.
-- ─────────────────────────────────────────────
create or replace function public.fleet_elite_price(p_fleet_id uuid, p_size text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when fp.elite_per_size then
      case upper(p_size)
        when 'S' then fp.elite_price_s
        when 'M' then fp.elite_price_m
        when 'L' then fp.elite_price_l
      end
    else fp.elite_price
  end
  from public.fleet_pricing fp
  where fp.fleet_id = p_fleet_id;
$$;

comment on function public.fleet_elite_price(uuid, text) is
  'Precio ÉLITE negociado para una flotilla y tamaño. Null si la flotilla no tiene acuerdo cargado.';

grant execute on function public.fleet_elite_price(uuid, text) to authenticated;


-- ─────────────────────────────────────────────
-- RLS FALTANTE — fleet_vehicles y fleet_contracts
--
-- 0019 les creó sólo la policy de SELECT. Con RLS habilitada y sin policy de
-- escritura, Postgres rechaza todo INSERT/UPDATE: agregar un vehículo a una
-- flotilla devolvía 403 y crear el contrato fallaba en silencio (el código no
-- revisaba ese error, así que la flotilla quedaba sin contrato sin avisar).
--
-- Se sigue el mismo patrón que "fleets_manage": pertenecer a la organización
-- y tener corporate.manage.
-- ─────────────────────────────────────────────
drop policy if exists "fleet_vehicles_manage" on public.fleet_vehicles;
create policy "fleet_vehicles_manage"
  on public.fleet_vehicles for all
  using (
    fleet_id in (
      select id from public.fleets
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.manage')
  )
  with check (
    fleet_id in (
      select id from public.fleets
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.manage')
  );

drop policy if exists "fleet_contracts_manage" on public.fleet_contracts;
create policy "fleet_contracts_manage"
  on public.fleet_contracts for all
  using (
    fleet_id in (
      select id from public.fleets
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.manage')
  )
  with check (
    fleet_id in (
      select id from public.fleets
      where organization_id = public.get_my_organization_id()
    )
    and public.has_permission('corporate.manage')
  );

-- fleet_pricing se creó arriba con "for all", pero sin WITH CHECK explícito
-- el INSERT se evalúa contra USING; se deja explícito por simetría.
drop policy if exists "fleet_pricing_manage" on public.fleet_pricing;
create policy "fleet_pricing_manage"
  on public.fleet_pricing for all
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
