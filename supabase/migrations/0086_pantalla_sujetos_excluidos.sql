-- ═════════════════════════════════════════════
-- 0086 — Pantalla propia para Sujetos excluidos
-- ═════════════════════════════════════════════
--
-- El firmador de Hacienda está sólo en la PC de caja, así que el Sujeto
-- Excluido (DTE 14) tiene que poder emitirse con la sesión de Caja. Dar a Caja
-- screens.accounting le abriría también Notas de crédito, Invalidaciones y
-- Correlativos; con un permiso aparte ve sólo esta pantalla.
--
-- Emitir sigue pidiendo fiscal.issue, que el servicio fiscal verifica.
--
--   · Quien ya veía Contabilidad sigue viendo Sujetos excluidos.
--   · Caja la ve y, como necesita fiscal.issue para emitir, se le asegura.

insert into public.permissions (code, module, description) values
  ('screens.fsee', 'screens', 'Pantalla: Sujetos excluidos')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select rp.role_id, p.id
from public.role_permissions rp
join public.permissions acc on acc.id = rp.permission_id and acc.code = 'screens.accounting'
cross join public.permissions p
where p.code = 'screens.fsee'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000005', p.id
from public.permissions p
where p.code in ('screens.fsee', 'fiscal.issue')
  and exists (select 1 from public.roles where id = '00000000-0000-0000-0002-000000000005')
on conflict do nothing;
