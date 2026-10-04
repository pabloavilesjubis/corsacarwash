-- Caja emite el DTE de sus ventas desde Ventas («Emitir DTE», /venta/preparar-manual),
-- que exige fiscal.issue. Aplicado en producción el 2026-10-04.
-- Nota: fiscal.issue también habilita NC, FSEE e invalidaciones.

insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000005', p.id   -- Caja
from public.permissions p
where p.code = 'fiscal.issue'
on conflict do nothing;
