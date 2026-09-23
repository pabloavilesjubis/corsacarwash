-- Datos de prueba. Se corren DESPUÉS de la migración.
insert into public.organizations (id, legal_name) values
  ('11111111-1111-1111-1111-111111111111','CORSA') on conflict do nothing;
insert into public.profiles (id, organization_id) values
  ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111') on conflict do nothing;
insert into public.customers (id, organization_id, name) values
  ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','FLOTILLA ACME')
  on conflict do nothing;
update public.corsa_test_estado
   set org='11111111-1111-1111-1111-111111111111',
       uid='99999999-9999-9999-9999-999999999999',
       permisos = array['corporate.manage','payments.create'];
