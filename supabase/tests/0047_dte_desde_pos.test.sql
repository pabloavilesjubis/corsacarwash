-- ============================================================
-- Pruebas de 0047_dte_desde_pos.sql
--
-- Contra un Postgres descartable, nunca contra producción. El orden de los
-- archivos está en supabase/tests/0047_prereq.sql. Cada bloque falla
-- ruidosamente con `assert`.
-- ============================================================

insert into public.organizations (id, legal_name, code) values
  ('11111111-1111-1111-1111-111111111111', 'CORSA', 'CORSA'),
  ('99999999-9999-9999-9999-999999999999', 'OTRA', 'OTRA');
insert into public.branches (id, organization_id, code, name) values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'ESC', 'Escalón');
insert into public.fiscal_issuer_config (
  organization_id, branch_id, nit, nrc, nombre, cod_actividad, desc_actividad,
  tipo_establecimiento, departamento, municipio, complemento, correo,
  cod_estable, cod_punto_venta)
values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
  '06231909241018', '3491162', 'GRUPO JUBIS S.A. DE C.V.', '45208', 'Lavado y pasteado de vehículos (carwash)',
  '01', '06', '14', 'Redondel Olímpico', 'corsacarwash@gmail.com', 'M001', 'P001');

insert into public.work_orders (id) values
  ('cccccccc-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000002');
-- Insertadas al revés a propósito: el orden lo da sort_order.
insert into public.work_order_items (work_order_id, description_snapshot, quantity, unit_price, sort_order) values
  ('cccccccc-0000-0000-0000-000000000001', 'Aspirado de interiores', 1, 3.00, 2),
  ('cccccccc-0000-0000-0000-000000000001', 'ELITE M', 1, 15.00, 1);
insert into public.invoices (id, organization_id, branch_id, invoice_type, total, work_order_id, status) values
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222', 'consumidor_final', 18.00, 'cccccccc-0000-0000-0000-000000000001', 'issued'),
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222', 'consumidor_final', 10.00, 'cccccccc-0000-0000-0000-000000000002', 'voided');


-- ── 1. El interruptor nace apagado ──────────────────────────
do $$ begin
  assert (select emitir_en_pos from public.fiscal_issuer_config) = false,
    'emitir_en_pos tiene que nacer en false: emitir con cada cobro es una decisión, no un efecto de cargar la configuración';
end $$;


-- ── 2. La venta, con sus líneas en orden y precios con IVA ──
do $$
declare v jsonb;
begin
  v := public.fiscal_sale_for_emission('dddddddd-0000-0000-0000-000000000001',
                                       '11111111-1111-1111-1111-111111111111');
  assert v->>'branch_id' = '22222222-2222-2222-2222-222222222222', 'sucursal';
  assert v->>'invoice_type' = 'consumidor_final', 'tipo';
  assert (v->>'total')::numeric = 18, 'total';
  assert jsonb_array_length(v->'lineas') = 2, 'dos líneas';
  assert v->'lineas'->0->>'descripcion' = 'ELITE M', 'el orden lo da sort_order';
  assert (v->'lineas'->0->>'precioUni')::numeric = 15, 'precio con IVA, como se cobró';
  assert (v->'lineas'->1->>'montoDescu')::numeric = 0, 'descuento';
end $$;


-- ── 3. La factura de otra organización no existe ────────────
do $$ begin
  begin
    perform public.fiscal_sale_for_emission('dddddddd-0000-0000-0000-000000000001',
                                            '99999999-9999-9999-9999-999999999999');
    assert false, 'tendría que haber fallado: la factura es de otra organización';
  exception when sqlstate 'P0002' then null;
  end;
end $$;


-- ── 4. Una factura anulada no se emite ──────────────────────
do $$ begin
  begin
    perform public.fiscal_sale_for_emission('dddddddd-0000-0000-0000-000000000002',
                                            '11111111-1111-1111-1111-111111111111');
    assert false, 'tendría que haber fallado: la factura está anulada';
  exception when sqlstate '22023' then null;
  end;
end $$;


-- ── 5. Sólo el service role la ejecuta ──────────────────────
do $$ begin
  assert not has_function_privilege('anon', 'public.fiscal_sale_for_emission(uuid, uuid)', 'execute'), 'anon';
  assert not has_function_privilege('authenticated', 'public.fiscal_sale_for_emission(uuid, uuid)', 'execute'), 'authenticated';
  assert has_function_privilege('service_role', 'public.fiscal_sale_for_emission(uuid, uuid)', 'execute'), 'service_role';
end $$;

\echo '0047: todas las pruebas pasaron'
