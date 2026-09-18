-- Datos de prueba. Se corren DESPUÉS de la migración: siembran la secuencia y
-- crean la configuración fiscal del emisor, que 0043 es quien define.
insert into public.organizations (id, legal_name, code)
  values ('11111111-1111-1111-1111-111111111111', 'CORSA CARWASH S.A. DE C.V.', 'CORSA');
insert into public.branches (id, organization_id, code, name)
  values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'ESC', 'Escalón');
insert into public.fiscal_issuer_config (
  organization_id, branch_id, nit, nrc, nombre, cod_actividad, desc_actividad,
  tipo_establecimiento, departamento, municipio, complemento, correo,
  cod_estable, cod_punto_venta)
values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
  '06140101010000', '123456', 'CORSA CARWASH S.A. DE C.V.', '45200', 'Lavado de vehículos',
  '01', '06', '14', 'Colonia Escalón', 'facturacion@corsacarwash.com', 'M001', 'P001');

-- Arranca en 100: NO se asume que la numeración empieza en 1.
select public.fiscal_seed_correlative(
  '11111111-1111-1111-1111-111111111111', '01', 'M001', 'P001', 100, 'prueba');
