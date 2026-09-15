-- ============================================================
-- Migration: 0040_tamanos_de_vehiculo.sql
-- Description: El tipo de vehículo pasa a ser el tamaño: S, M o L.
--
--   El catálogo tenía seis tipos —Sedán, Hatchback, SUV, Pickup, Van,
--   Microbús— pero CORSA no cobra por carrocería: cobra por tamaño, y sus tres
--   tarifas son S, M y L. Pedirle al cajero que elija entre seis carrocerías
--   para después elegir aparte la tarifa es pedirle que traduzca, y traducir a
--   mano es donde se equivoca: una SUV cobrada como M es plata que no entró.
--
--   Con tres tipos que SON las tres tarifas, elegir el vehículo ya deja
--   elegida la tarifa. Ese es todo el punto de esta migración.
--
--   QUÉ PASA CON LOS VEHÍCULOS YA REGISTRADOS: se reapuntan al tamaño que les
--   corresponde por su categoría (small→S, medium→M, large y xl→L). Ninguno
--   queda sin tipo, y ningún historial cambia de precio: los precios cobrados
--   viven congelados en work_order_items, no se recalculan desde acá.
--
--   Los tipos viejos NO se borran, se desactivan: hay filas —precios,
--   membresías— que los referencian, y borrarlos rompería esas referencias
--   para no ganar nada. Desactivados dejan de aparecer en los selectores, que
--   es lo único que hacía falta.
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. LOS TRES TAMAÑOS
--
--    Con id fijo para que la migración se pueda volver a correr sin duplicar,
--    y para poder referenciarlos desde otra migración sin buscarlos por nombre.
-- ─────────────────────────────────────────────
insert into public.vehicle_types
  (id, organization_id, code, name, size_category, active, sort_order)
values
  ('00000000-0000-0000-0005-000000000001', '00000000-0000-0000-0000-000000000001',
   'S', 'S · Pequeño',  'small',  true, 1),
  ('00000000-0000-0000-0005-000000000002', '00000000-0000-0000-0000-000000000001',
   'M', 'M · Mediano',  'medium', true, 2),
  ('00000000-0000-0000-0005-000000000003', '00000000-0000-0000-0000-000000000001',
   'L', 'L · Grande',   'large',  true, 3)
on conflict (id) do update set
  name          = excluded.name,
  size_category = excluded.size_category,
  sort_order    = excluded.sort_order,
  active        = true;


-- ─────────────────────────────────────────────
-- 2. LOS VEHÍCULOS YA REGISTRADOS
--
--    Cada uno al tamaño que implica su tipo actual. `xl` cae en L: es el más
--    grande que existe en la tarifa, y cobrar de menos es preferible a cobrar
--    un tamaño que el sistema no tiene.
-- ─────────────────────────────────────────────
update public.vehicles v
   set vehicle_type_id = case t.size_category
         when 'small'  then '00000000-0000-0000-0005-000000000001'::uuid
         when 'medium' then '00000000-0000-0000-0005-000000000002'::uuid
         else               '00000000-0000-0000-0005-000000000003'::uuid
       end,
       updated_at = now()
  from public.vehicle_types t
 where t.id = v.vehicle_type_id
   and t.id not in ('00000000-0000-0000-0005-000000000001',
                    '00000000-0000-0000-0005-000000000002',
                    '00000000-0000-0000-0005-000000000003');


-- ─────────────────────────────────────────────
-- 3. LOS PRECIOS DEL CATÁLOGO
--
--    service_prices está por tipo de vehículo. Los tres tamaños nuevos nacen
--    sin precios, así que heredan los del tipo viejo de su misma categoría —el
--    de menor sort_order, que es el más representativo. Sin esto,
--    get_service_price() devolvería nulo para todo vehículo migrado.
--
--    El POS no lee esta tabla (sus precios son de su propio catálogo), pero
--    dejarla coherente es lo que evita que el día que alguien la use se
--    encuentre con un catálogo a medio llenar.
-- ─────────────────────────────────────────────
insert into public.service_prices
  (organization_id, branch_id, service_id, vehicle_type_id, price, effective_from, active)
select p.organization_id, p.branch_id, p.service_id, nuevo.id, p.price,
       public.corsa_hoy(), true
from public.vehicle_types nuevo
join lateral (
  select sp.*
    from public.service_prices sp
    join public.vehicle_types viejo on viejo.id = sp.vehicle_type_id
   where sp.organization_id = nuevo.organization_id
     and sp.active
     and viejo.size_category = nuevo.size_category
     and viejo.id <> nuevo.id
   order by viejo.sort_order, sp.effective_from desc
) p on true
where nuevo.id in ('00000000-0000-0000-0005-000000000001',
                   '00000000-0000-0000-0005-000000000002',
                   '00000000-0000-0000-0005-000000000003')
  and not exists (
    select 1 from public.service_prices x
     where x.service_id = p.service_id
       and x.vehicle_type_id = nuevo.id
       and x.active
       and x.branch_id is not distinct from p.branch_id
  );


-- ─────────────────────────────────────────────
-- 4. FUERA DE LOS SELECTORES
--
--    Desactivar y no borrar: las referencias que quedan siguen siendo válidas,
--    y si mañana el negocio vuelve a querer distinguir carrocerías, están.
-- ─────────────────────────────────────────────
update public.vehicle_types
   set active = false
 where organization_id = '00000000-0000-0000-0000-000000000001'
   and id not in ('00000000-0000-0000-0005-000000000001',
                  '00000000-0000-0000-0005-000000000002',
                  '00000000-0000-0000-0005-000000000003');

comment on column public.vehicle_types.size_category is
  'small/medium/large/xl. Desde la 0040 los tipos activos son exactamente tres —S, M, L— y son las tarifas del POS: elegir el vehículo elige el precio.';
