-- ============================================================
-- Pruebas de 0046_contabilidad_fiscal.sql
--
-- Contra un Postgres descartable, nunca contra producción:
--
--   docker run -d --rm --name corsa-fiscal-test -e POSTGRES_PASSWORD=test \
--     -e POSTGRES_DB=corsa_test -p 55433:5432 postgres:16-alpine
--   psql … -f supabase/tests/0043_prereq.sql
--   psql … -f supabase/tests/0046_prereq.sql
--   psql … -f supabase/migrations/0043_motor_fiscal_dte.sql
--   psql … -f supabase/migrations/0046_contabilidad_fiscal.sql
--   psql … -f supabase/tests/0046_contabilidad_fiscal.test.sql
--
-- Cada bloque falla ruidosamente con `assert`.
-- ============================================================

-- ── Datos ────────────────────────────────────────────────────
insert into public.organizations (id, legal_name, code) values
  ('11111111-1111-1111-1111-111111111111', 'CORSA CARWASH S.A. DE C.V.', 'CORSA'),
  ('99999999-9999-9999-9999-999999999999', 'OTRA S.A. DE C.V.', 'OTRA');
insert into public.branches (id, organization_id, code, name) values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'ESC', 'Escalón'),
  ('88888888-8888-8888-8888-888888888888', '99999999-9999-9999-9999-999999999999', 'OTR', 'Otra');
insert into public.fiscal_issuer_config (
  organization_id, branch_id, nit, nrc, nombre, cod_actividad, desc_actividad,
  tipo_establecimiento, departamento, municipio, complemento, correo,
  cod_estable, cod_punto_venta)
values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
  '06140101010000', '123456', 'CORSA CARWASH S.A. DE C.V.', '45200', 'Lavado de vehículos',
  '01', '06', '14', 'Colonia Escalón', 'facturacion@corsacarwash.com', 'M001', 'P001');

-- Un administrador de CORSA, un cajero de CORSA y un administrador de otra
-- organización.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@corsa.test'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'caja@corsa.test'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'admin@otra.test');
insert into public.profiles (id, organization_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '99999999-9999-9999-9999-999999999999');
insert into public.user_roles (user_id, role_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0002-000000000002'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '00000000-0000-0000-0002-000000000005'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '00000000-0000-0000-0002-000000000002');


-- ── Los permisos quedaron asignados como se dijo ─────────────
do $$
begin
  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
  assert public.has_permission('fiscal.seed'), 'El administrador debería poder sembrar';
  assert public.has_permission('fiscal.issue'), 'El administrador debería poder emitir';
  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000002', false);
  assert not public.has_permission('fiscal.seed'), 'Caja NO debería poder sembrar';
  assert not public.has_permission('screens.accounting'), 'Caja NO debería ver Contabilidad';
end $$;


-- ── Sembrar desde la app ─────────────────────────────────────
do $$
declare f public.fiscal_correlatives;
begin
  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
  f := public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '01', 155);
  assert f.last_minted = 155 and f.seeded, 'La siembra no quedó en 155';
  assert f.establishment_code = 'M001' and f.pos_code = 'P001',
    'Los códigos tienen que salir de la configuración fiscal, no del navegador';
  assert f.seeded_by = 'admin@corsa.test', format('seeded_by = %s', f.seeded_by);

  -- Igual al actual: se acepta (no cambia nada).
  f := public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '01', 155);
  assert f.last_minted = 155;
  -- Hacia arriba: se acepta.
  f := public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '01', 160);
  assert f.last_minted = 160;
end $$;

-- Hacia abajo: se RECHAZA con error, no se ignora en silencio.
do $$
begin
  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
  begin
    perform public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '01', 10);
    assert false, 'Bajar la secuencia debió fallar';
  exception when check_violation then
    assert sqlerrm like '%retroceder%', sqlerrm;
  end;
end $$;

-- Sin permiso: Caja no siembra.
do $$
begin
  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '01', 500);
    assert false, 'Caja no debería poder sembrar';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Otra organización no siembra la sucursal de CORSA: la sucursal no es suya.
do $$
begin
  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000003', false);
  begin
    perform public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '01', 500);
    assert false, 'Otra organización sembró una sucursal ajena';
  exception when foreign_key_violation then null;
  end;
end $$;

-- Tipos nuevos: 05 y 14 se pueden sembrar; un tipo inventado no.
do $$
begin
  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
  perform public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '05', 95);
  perform public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '14', 116);
  begin
    perform public.fiscal_seed_correlative_app('22222222-2222-2222-2222-222222222222', '01', '99', 1);
    assert false, 'Un tipo 99 no debió sembrarse';
  exception when check_violation then null;
  end;
end $$;


-- ── Sandbox y producción NO comparten numeración ─────────────
do $$
declare prueba public.fiscal_documents; real public.fiscal_documents;
begin
  -- Sandbox empieza en 0; producción quedó en 160.
  perform public.fiscal_seed_correlative('11111111-1111-1111-1111-111111111111',
    '00', '01', 'M001', 'P001', 0, 'prueba');

  prueba := public.fiscal_open_document('T:sandbox-1', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '00');
  real := public.fiscal_open_document('T:prod-1', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '01');

  assert prueba.correlative = 1, format('sandbox: %s', prueba.correlative);
  assert real.correlative = 161, format('producción: %s', real.correlative);
  assert prueba.ambiente = '00' and real.ambiente = '01';

  -- Gastar números en sandbox no mueve producción.
  perform public.fiscal_open_document('T:sandbox-2', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '00');
  real := public.fiscal_open_document('T:prod-2', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '01');
  assert real.correlative = 162, format('producción avanzó por las pruebas: %s', real.correlative);
end $$;

-- El mismo numeroControl puede existir en los dos ambientes.
do $$
declare a public.fiscal_documents; b public.fiscal_documents;
begin
  perform public.fiscal_seed_correlative('11111111-1111-1111-1111-111111111111',
    '00', '14', 'M001', 'P001', 116, 'prueba');
  a := public.fiscal_open_document('T:fse-00', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '14', '00');
  b := public.fiscal_open_document('T:fse-01', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '14', '01');
  assert a.numero_control = b.numero_control,
    format('Se esperaba el mismo numeroControl: %s / %s', a.numero_control, b.numero_control);
  assert a.numero_control = 'DTE-14-M001P001-000000000000117', a.numero_control;
end $$;

-- Sin sembrar, el mensaje dice dónde se siembra.
do $$
begin
  begin
    perform public.fiscal_open_document('T:sin-sembrar', '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222', '03', '01');
    assert false, 'Abrió un documento en una secuencia sin sembrar';
  exception when check_violation then
    assert sqlerrm like '%Contabilidad%', sqlerrm;
  end;
end $$;

-- Ambiente inválido.
do $$
begin
  begin
    perform public.fiscal_open_document('T:amb', '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222', '01', '02');
    assert false, 'Aceptó el ambiente 02';
  exception when check_violation then null;
  end;
end $$;


-- ── Invalidación ─────────────────────────────────────────────
do $$
declare doc public.fiscal_documents; inv public.fiscal_invalidations;
begin
  doc := public.fiscal_open_document('T:inv-doc', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '01');

  -- Sin sello no se invalida.
  begin
    perform public.fiscal_open_invalidation('T:inv-0', '11111111-1111-1111-1111-111111111111',
      doc.id, 2::smallint, 'prueba', null, 'prueba');
    assert false, 'Invalidó un documento sin sello';
  exception when check_violation then null;
  end;

  perform public.fiscal_mark_accepted(doc.id, 'SELLO-DOC', '{}'::jsonb);

  -- Otra organización no puede invalidarlo.
  begin
    perform public.fiscal_open_invalidation('T:inv-ajena', '99999999-9999-9999-9999-999999999999',
      doc.id, 2::smallint, 'prueba', null, 'prueba');
    assert false, 'Otra organización abrió una invalidación ajena';
  exception when no_data_found then null;
  end;

  inv := public.fiscal_open_invalidation('T:inv-1', '11111111-1111-1111-1111-111111111111',
    doc.id, 2::smallint, 'Se rescinde la venta', null, 'admin@corsa.test');
  assert inv.status = 'CREATED' and inv.codigo_generacion ~ '^[A-F0-9-]{36}$';
  assert inv.ambiente = '01', 'La invalidación hereda el ambiente del documento';

  -- Idempotente: la misma llave devuelve la misma.
  assert (public.fiscal_open_invalidation('T:inv-1', '11111111-1111-1111-1111-111111111111',
    doc.id, 2::smallint, 'otro', null, 'x')).id = inv.id, 'La misma llave creó otra invalidación';

  -- Una sola viva por documento: otra llave choca.
  begin
    perform public.fiscal_open_invalidation('T:inv-2', '11111111-1111-1111-1111-111111111111',
      doc.id, 2::smallint, 'otra', null, 'x');
    assert false, 'Abrió dos invalidaciones vivas del mismo documento';
  exception when unique_violation then
    assert sqlerrm like '%en curso%', sqlerrm;
  end;

  -- Rechazada: se puede volver a intentar con otra.
  perform public.fiscal_invalidation_mark_rejected(inv.id, '{"estado":"RECHAZADO"}'::jsonb, 'fuera de plazo');
  inv := public.fiscal_open_invalidation('T:inv-3', '11111111-1111-1111-1111-111111111111',
    doc.id, 2::smallint, 'segundo intento', null, 'x');
  assert inv.status = 'CREATED';

  -- Aceptada: el documento pasa a INVALIDATED en la misma operación.
  perform public.fiscal_invalidation_mark_signed(inv.id, 'jws', '{}'::jsonb);
  perform public.fiscal_invalidation_mark_accepted(inv.id, 'SELLO-INV', '{}'::jsonb);
  select * into doc from public.fiscal_documents where id = doc.id;
  assert doc.status = 'INVALIDATED' and doc.invalidated_at is not null,
    format('El documento quedó en %s', doc.status);

  -- Y ya no se invalida otra vez.
  begin
    perform public.fiscal_open_invalidation('T:inv-4', '11111111-1111-1111-1111-111111111111',
      doc.id, 2::smallint, 'de nuevo', null, 'x');
    assert false, 'Invalidó dos veces el mismo documento';
  exception when check_violation then
    assert sqlerrm like '%ya está invalidado%', sqlerrm;
  end;
end $$;

-- Tipos 1 y 3 exigen reemplazo aceptado, del mismo tipo y ambiente.
do $$
declare orig public.fiscal_documents; reemp public.fiscal_documents; otro public.fiscal_documents;
        inv public.fiscal_invalidations;
begin
  orig := public.fiscal_open_document('T:r-orig', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '01');
  perform public.fiscal_mark_accepted(orig.id, 'S1', '{}'::jsonb);
  reemp := public.fiscal_open_document('T:r-nuevo', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '01');

  -- Tipo 1 sin reemplazo: lo frena el CHECK.
  begin
    perform public.fiscal_open_invalidation('T:r-1', '11111111-1111-1111-1111-111111111111',
      orig.id, 1::smallint, 'error', null, 'x');
    assert false, 'Tipo 1 sin reemplazo';
  exception when check_violation then null;
  end;

  -- Reemplazo todavía no aceptado.
  begin
    perform public.fiscal_open_invalidation('T:r-2', '11111111-1111-1111-1111-111111111111',
      orig.id, 1::smallint, 'error', reemp.id, 'x');
    assert false, 'Aceptó un reemplazo sin sello';
  exception when check_violation then
    assert sqlerrm like '%Emitirlo primero%', sqlerrm;
  end;

  -- Reemplazo de otro tipo.
  otro := public.fiscal_open_document('T:r-fse', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '14', '01');
  perform public.fiscal_mark_accepted(otro.id, 'S2', '{}'::jsonb);
  begin
    perform public.fiscal_open_invalidation('T:r-3', '11111111-1111-1111-1111-111111111111',
      orig.id, 1::smallint, 'error', otro.id, 'x');
    assert false, 'Aceptó un reemplazo de otro tipo';
  exception when check_violation then null;
  end;

  -- Tipo 2 con reemplazo: el schema del MH lo prohíbe.
  perform public.fiscal_mark_accepted(reemp.id, 'S3', '{}'::jsonb);
  begin
    perform public.fiscal_open_invalidation('T:r-4', '11111111-1111-1111-1111-111111111111',
      orig.id, 2::smallint, 'rescisión', reemp.id, 'x');
    assert false, 'Tipo 2 con reemplazo';
  exception when check_violation then null;
  end;

  inv := public.fiscal_open_invalidation('T:r-5', '11111111-1111-1111-1111-111111111111',
    orig.id, 1::smallint, 'precio equivocado', reemp.id, 'x');
  assert inv.replacement_document_id = reemp.id;
end $$;


-- ── fiscal_app_context ───────────────────────────────────────
do $$
declare c jsonb;
begin
  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
  c := public.fiscal_app_context('fiscal.issue');
  assert c ->> 'organization_id' = '11111111-1111-1111-1111-111111111111', c::text;
  assert c ->> 'email' = 'admin@corsa.test', c::text;

  perform set_config('prueba.uid', 'aaaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform public.fiscal_app_context('fiscal.issue');
    assert false, 'Caja no tiene fiscal.issue';
  exception when insufficient_privilege then null;
  end;

  perform set_config('prueba.uid', '', false);
  begin
    perform public.fiscal_app_context('fiscal.issue');
    assert false, 'Sin sesión debería fallar';
  exception when invalid_authorization_specification then null;
  end;
end $$;


-- ── El historial lee el JSON firmado ─────────────────────────
do $$
declare d public.fiscal_documents; v record;
begin
  d := public.fiscal_open_document('T:hist', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '14', '01');
  perform public.fiscal_mark_signed(d.id, 'jws', '{
    "identificacion": {"fecEmi": "2026-09-30"},
    "sujetoExcluido": {"nombre": "JUAN PEREZ", "numDocumento": "012345678"},
    "resumen": {"totalPagar": 75.00}
  }'::jsonb);
  select * into v from public.v_fiscal_documents where id = d.id;
  assert v.contraparte_nombre = 'JUAN PEREZ', v.contraparte_nombre;
  assert v.contraparte_documento = '012345678', v.contraparte_documento;
  assert v.monto_total = 75.00, v.monto_total::text;
  assert v.fecha_emision = '2026-09-30';
  assert v.firmado;
end $$;

-- Las vistas leen con los permisos de quien consulta.
do $$
declare n int;
begin
  select count(*) into n from pg_class c
   where c.relname in ('v_fiscal_documents', 'v_fiscal_correlative_ledger')
     and 'security_invoker=true' = any(c.reloptions);
  assert n = 2, format('Sólo %s de 2 vistas tienen security_invoker', n);
end $$;


-- ── Hallazgos de la revisión ─────────────────────────────────

-- anon no ejecuta NINGUNA función fiscal, ni las de 0043 ni las de 0046.
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'fiscal\_%'
  loop
    assert not has_function_privilege('anon', f, 'execute'), format('anon puede ejecutar %s', f);
  end loop;
  assert not has_function_privilege('authenticated', 'public.fiscal_seed_correlative(uuid,text,text,text,text,bigint,text)', 'execute'),
    'authenticated puede sembrar sin pasar por la RPC con permiso';
  assert has_function_privilege('authenticated', 'public.fiscal_seed_correlative_app(uuid,text,text,bigint)', 'execute');
end $$;

-- Una llave repetida con otra organización, otro tipo u otro ambiente NO
-- devuelve el documento existente.
do $$
begin
  perform public.fiscal_open_document('T:replay', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '00');
  begin
    perform public.fiscal_open_document('T:replay', '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222', '01', '01');
    assert false, 'Una prueba del sandbox se devolvió para producción';
  exception when unique_violation then null;
  end;
  begin
    perform public.fiscal_open_document('T:replay', '99999999-9999-9999-9999-999999999999',
      '88888888-8888-8888-8888-888888888888', '01', '00');
    assert false, 'Otra organización recibió un documento ajeno';
  exception when unique_violation then null;
  end;
  begin
    perform public.fiscal_open_document('T:replay', '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222', '14', '00');
    assert false, 'La llave de un 01 devolvió un documento para un 14';
  exception when unique_violation then null;
  end;
end $$;

-- La sucursal de otra organización no sirve para numerar.
do $$
begin
  perform public.fiscal_seed_correlative('99999999-9999-9999-9999-999999999999',
    '00', '01', 'M001', 'P001', 0, 'prueba');
  begin
    perform public.fiscal_open_document('T:sucursal-ajena', '99999999-9999-9999-9999-999999999999',
      '22222222-2222-2222-2222-222222222222', '01', '00');
    assert false, 'Numeró con la configuración fiscal de otra organización';
  exception when foreign_key_violation then null;
  end;
end $$;

-- Ni un cliente de otra organización.
do $$
begin
  insert into public.customers (id, name, organization_id)
    values ('cccccccc-0000-0000-0000-000000000001', 'Cliente ajeno', '99999999-9999-9999-9999-999999999999');
  begin
    perform public.fiscal_open_document('T:cliente-ajeno', '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222', '01', '00', null, 'cccccccc-0000-0000-0000-000000000001');
    assert false, 'Aceptó un cliente de otra organización';
  exception when foreign_key_violation then null;
  end;
end $$;

-- Dos organizaciones con los mismos códigos tienen numeraciones independientes.
do $$
declare d public.fiscal_documents;
begin
  insert into public.fiscal_issuer_config (
    organization_id, branch_id, nit, nrc, nombre, cod_actividad, desc_actividad,
    tipo_establecimiento, departamento, municipio, complemento, correo, cod_estable, cod_punto_venta)
  values ('99999999-9999-9999-9999-999999999999', '88888888-8888-8888-8888-888888888888',
    '06140101019999', '999999', 'OTRA S.A. DE C.V.', '45200', 'Lavado', '01', '06', '14',
    'San Salvador', 'otra@test.sv', 'M001', 'P001');
  d := public.fiscal_open_document('T:otra-org-1', '99999999-9999-9999-9999-999999999999',
    '88888888-8888-8888-8888-888888888888', '01', '00');
  assert d.numero_control = 'DTE-01-M001P001-000000000000001', d.numero_control;
end $$;

-- La primera firma gana; un aceptado no se vuelve rechazado ni pendiente.
do $$
declare d public.fiscal_documents;
begin
  d := public.fiscal_open_document('T:carrera', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '00');
  perform public.fiscal_mark_signed(d.id, 'JWS-PRIMERO', '{"n":1}'::jsonb);
  d := public.fiscal_mark_signed(d.id, 'JWS-SEGUNDO', '{"n":2}'::jsonb);
  assert d.signed_jws = 'JWS-PRIMERO', format('La segunda firma pisó la primera: %s', d.signed_jws);

  perform public.fiscal_mark_accepted(d.id, 'SELLO', '{}'::jsonb);
  d := public.fiscal_mark_rejected(d.id, '{"estado":"RECHAZADO"}'::jsonb, 'ya existe');
  assert d.status = 'ACCEPTED', format('Un aceptado quedó en %s', d.status);
  d := public.fiscal_mark_retry(d.id, 'otro');
  assert d.status = 'ACCEPTED', format('Un aceptado quedó en %s', d.status);
end $$;

-- Una invalidación: la llave repetida con otro documento no se reutiliza, y
-- una aceptada no se vuelve rechazada.
do $$
declare a public.fiscal_documents; b public.fiscal_documents; inv public.fiscal_invalidations;
begin
  a := public.fiscal_open_document('T:inv-carrera-a', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '00');
  b := public.fiscal_open_document('T:inv-carrera-b', '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222', '01', '00');
  perform public.fiscal_mark_accepted(a.id, 'SA', '{}'::jsonb);
  perform public.fiscal_mark_accepted(b.id, 'SB', '{}'::jsonb);

  inv := public.fiscal_open_invalidation('T:inv-llave', '11111111-1111-1111-1111-111111111111',
    a.id, 2::smallint, 'rescisión', null, 'x');
  begin
    perform public.fiscal_open_invalidation('T:inv-llave', '11111111-1111-1111-1111-111111111111',
      b.id, 2::smallint, 'rescisión', null, 'x');
    assert false, 'La misma llave abrió la invalidación de otro documento';
  exception when unique_violation then null;
  end;

  perform public.fiscal_invalidation_mark_signed(inv.id, 'EV-1', '{}'::jsonb);
  inv := public.fiscal_invalidation_mark_signed(inv.id, 'EV-2', '{}'::jsonb);
  assert inv.signed_jws = 'EV-1', 'La segunda firma del evento pisó la primera';
  perform public.fiscal_invalidation_mark_accepted(inv.id, 'SELLO-EV', '{}'::jsonb);
  inv := public.fiscal_invalidation_mark_rejected(inv.id, '{}'::jsonb, 'ya existe');
  assert inv.status = 'ACCEPTED', format('Una invalidación aceptada quedó en %s', inv.status);
end $$;

-- Sembrar con null es un error, no un éxito vacío.
do $$
begin
  begin
    perform public.fiscal_seed_correlative('11111111-1111-1111-1111-111111111111',
      '01', '01', 'M001', 'P001', null, 'prueba');
    assert false, 'Sembrar con null no falló';
  exception when check_violation then null;
  end;
end $$;

-- El libro de correlativos distingue el ambiente.
do $$
begin
  assert exists (select 1 from information_schema.columns
                  where table_name = 'v_fiscal_correlative_ledger' and column_name = 'ambiente'),
    'v_fiscal_correlative_ledger no tiene ambiente';
end $$;

\echo '0046: todas las pruebas pasaron'
