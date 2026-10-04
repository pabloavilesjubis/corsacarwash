-- ════════════════════════════════════════════════════════════════════
-- purge-test-sales.sql — Limpieza DEFINITIVA de las ventas de prueba
-- ════════════════════════════════════════════════════════════════════
--
-- Autorizada por el dueño el 2026-10-03, después del ensayo
-- (purge-test-sales.dryrun.sql), con las MISMAS validaciones más:
--   - candado: las órdenes tienen que ser exactamente las del ensayo
--     (16, huella md5 6eec7b75910ad8000b06a9b564f930f9) y cada tabla tiene
--     que borrar exactamente lo que borró el ensayo. Si entró una venta
--     nueva desde entonces, se aborta;
--   - audit_logs: se borran SÓLO las filas cuyo (entity_type, entity_id) es
--     una fila del conjunto —las que ya estaban y las que agregan los
--     triggers al borrar—. Nada por fechas. El resto de audit_logs se
--     comprueba con su propia huella.
--
-- Cualquier falla lanza PURGE_ABORT: la transacción queda abortada y el
-- COMMIT del final se convierte en ROLLBACK. Sólo se confirma si pasó todo.
--
-- Qué es «una venta»: una fila de work_orders (es la raíz de
-- v_sales_history). Se toman TODAS: la sucursal Escalón es la única y todas
-- sus ventas son de prueba (confirmado por el dueño, 2026-10-03).
--
-- Las dependencias NO se asumen. Se arma el conjunto a borrar siguiendo las
-- FK reales (relevadas de pg_constraint) y, antes de borrar, se recorren
-- TODAS las FK que apuntan a una tabla del conjunto: si alguna fila fuera
-- del conjunto apunta a una fila que se va a borrar —sea RESTRICT, CASCADE o
-- SET NULL—, se aborta y se dice cuál. Así una FK nueva o desconocida no
-- termina en un borrado o un NULL silencioso.
--
-- No se tocan: cierres y movimientos de caja, usuarios, clientes, vehículos,
-- catálogo, configuración, sucursales, PLC/gateway, fiscal_issuer_config,
-- correlativos ni ninguna otra tabla. Se comprueba con una huella (md5 de
-- todas las filas) de cada tabla de public fuera del conjunto, y de
-- auth.users, antes y después de los DELETE. audit_logs es la excepción: los
-- triggers de auditoría le AGREGAN una fila por cada orden y pago borrados.
--
-- REPEATABLE READ: los heartbeats del gateway entran todo el tiempo; con
-- una foto fija de la base, la huella de antes y la de después comparan lo
-- mismo y sólo cambia lo que hace este script.
-- ════════════════════════════════════════════════════════════════════

begin isolation level repeatable read;

do $purge$
declare
  -- Orden de borrado: hijos antes que padres.
  orden text[] := array[
    'fiscal_audit_events', 'fiscal_invalidations', 'fiscal_documents',
    'accounts_receivable', 'tip_distributions', 'tips',
    'payment_allocations', 'payments', 'invoices',
    'corporate_credit_events', 'coupon_redemptions', 'membership_usage',
    'rain_policies', 'service_vouchers', 'voucher_batches',
    'work_order_assignments', 'work_order_reworks', 'work_order_quality_checks',
    'work_order_status_history', 'work_order_discounts', 'resource_assignments',
    'vehicle_checkins', 'work_order_items', 'work_orders'
  ];
  t text;
  r record;
  n bigint;
  esperado bigint;
  h text;
  problemas text[] := '{}';
  borrados jsonb := '{}';
  antes_total jsonb := '{}';
  quedan jsonb := '{}';
  huellas jsonb := '{}';
  cambiadas text[] := '{}';
  revisadas int := 0;
  audit_antes bigint;
  audit_despues bigint;
  por_tipo jsonb;
  contables text[];
  huella_ordenes text;
  audit_previas bigint;
  audit_borradas bigint;
  huella_audit_ajena text;
  esperados constant jsonb := '{"work_orders":16,"work_order_items":28,"payments":8,
    "payment_allocations":8,"invoices":9,"voucher_batches":6,"service_vouchers":60,
    "rain_policies":2}';
begin
  -- ── 0. El conjunto a borrar, siguiendo las FK reales ──────────────
  create temp table _del (tabla text not null, id uuid not null, primary key (tabla, id)) on commit drop;

  insert into _del select 'work_orders', id from public.work_orders;

  insert into _del select 'work_order_items', id from public.work_order_items
   where work_order_id in (select id from _del where tabla = 'work_orders');

  insert into _del select 'work_order_assignments', id from public.work_order_assignments
   where work_order_id in (select id from _del where tabla = 'work_orders')
      or work_order_item_id in (select id from _del where tabla = 'work_order_items');
  insert into _del select 'work_order_reworks', id from public.work_order_reworks
   where work_order_id in (select id from _del where tabla = 'work_orders')
      or work_order_item_id in (select id from _del where tabla = 'work_order_items');

  insert into _del select 'work_order_quality_checks', id from public.work_order_quality_checks
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'work_order_status_history', id from public.work_order_status_history
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'work_order_discounts', id from public.work_order_discounts
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'resource_assignments', id from public.resource_assignments
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'vehicle_checkins', id from public.vehicle_checkins
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'coupon_redemptions', id from public.coupon_redemptions
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'membership_usage', id from public.membership_usage
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'corporate_credit_events', id from public.corporate_credit_events
   where work_order_id in (select id from _del where tabla = 'work_orders');

  insert into _del select 'invoices', id from public.invoices
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'fiscal_documents', id from public.fiscal_documents
   where invoice_id in (select id from _del where tabla = 'invoices');
  insert into _del select 'fiscal_invalidations', id from public.fiscal_invalidations
   where fiscal_document_id in (select id from _del where tabla = 'fiscal_documents')
      or replacement_document_id in (select id from _del where tabla = 'fiscal_documents');
  insert into _del select 'fiscal_audit_events', id from public.fiscal_audit_events
   where fiscal_document_id in (select id from _del where tabla = 'fiscal_documents');
  insert into _del select 'accounts_receivable', id from public.accounts_receivable
   where work_order_id in (select id from _del where tabla = 'work_orders')
      or invoice_id in (select id from _del where tabla = 'invoices');

  insert into _del select 'payment_allocations', id from public.payment_allocations
   where work_order_id in (select id from _del where tabla = 'work_orders');
  -- Un pago se borra sólo si TODAS sus asignaciones son de estas ventas.
  insert into _del select 'payments', p.id from public.payments p
   where exists (select 1 from public.payment_allocations pa
                  where pa.payment_id = p.id
                    and pa.id in (select id from _del where tabla = 'payment_allocations'))
     and not exists (select 1 from public.payment_allocations pa
                      where pa.payment_id = p.id
                        and pa.id not in (select id from _del where tabla = 'payment_allocations'));
  insert into _del select 'tips', id from public.tips
   where work_order_id in (select id from _del where tabla = 'work_orders')
      or payment_id in (select id from _del where tabla = 'payments');
  insert into _del select 'tip_distributions', id from public.tip_distributions
   where tip_id in (select id from _del where tabla = 'tips');

  -- Cupones vendidos o regalados en estas ventas, y los cupones de esos lotes.
  insert into _del select 'voucher_batches', id from public.voucher_batches
   where work_order_id in (select id from _del where tabla = 'work_orders');
  insert into _del select 'service_vouchers', id from public.service_vouchers
   where batch_id in (select id from _del where tabla = 'voucher_batches');

  -- Seguros de lluvia vendidos o canjeados en estas ventas.
  insert into _del select 'rain_policies', id from public.rain_policies
   where work_order_id in (select id from _del where tabla = 'work_orders')
      or redeemed_work_order_id in (select id from _del where tabla = 'work_orders');

  -- ── 1. Validaciones ─────────────────────────────────────────────
  -- 1a. Ningún documento fiscal llegó (ni pudo llegar) a Hacienda.
  select count(*) into n from public.fiscal_documents
   where id in (select id from _del where tabla = 'fiscal_documents')
     and (sello_recepcion is not null or signed_jws is not null
          or status in ('ACCEPTED', 'INVALIDATED'));
  if n > 0 then
    problemas := problemas || format('%s documento(s) fiscal(es) firmados o sellados por Hacienda', n);
  end if;
  select count(*) into n from public.fiscal_invalidations
   where id in (select id from _del where tabla = 'fiscal_invalidations')
     and (sello_recepcion is not null or signed_jws is not null);
  if n > 0 then
    problemas := problemas || format('%s invalidación(es) firmadas o selladas', n);
  end if;

  -- 1b. Toda FK que apunta a una tabla del conjunto: ninguna fila FUERA del
  -- conjunto puede apuntar a una fila que se va a borrar.
  for r in
    select c.conname, c.conrelid::regclass::text hijo, c.confrelid::regclass::text padre,
           a.attname col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid::regclass::text = any(orden)
  loop
    revisadas := revisadas + 1;
    if r.hijo = any(orden) then
      execute format(
        'select count(*) from %s x where x.%I in (select id from _del where tabla = %L) ' ||
        'and x.id not in (select id from _del where tabla = %L)', r.hijo, r.col, r.padre, r.hijo)
        into n;
    else
      execute format(
        'select count(*) from %s x where x.%I in (select id from _del where tabla = %L)',
        r.hijo, r.col, r.padre)
        into n;
    end if;
    if n > 0 then
      problemas := problemas || format('%s fila(s) de %s.%s apuntan a %s que se borraría (FK %s)',
                                       n, r.hijo, r.col, r.padre, r.conname);
    end if;
  end loop;

  -- 1c. Referencias polimórficas (sin FK) que este script NO va a tocar.
  select count(*) into n from public.cash_movements where reference_id in (select id from _del);
  if n > 0 then problemas := problemas || format('%s movimiento(s) de caja apuntan a estas ventas', n); end if;
  select count(*) into n from public.inventory_movements where reference_id in (select id from _del);
  if n > 0 then problemas := problemas || format('%s movimiento(s) de inventario apuntan a estas ventas', n); end if;

  -- 1d. ¿Hay tablas de asientos contables? (no se asume que no existan)
  select coalesce(array_agg(table_schema || '.' || table_name order by 1), '{}') into contables
    from information_schema.tables
   where table_schema not in ('pg_catalog', 'information_schema')
     and table_type = 'BASE TABLE'
     and table_name ~ '(journal|ledger|asiento|contab|gl_entr|entry_line|accounting)';

  -- 1e. Candado: el conjunto es exactamente el del ensayo.
  select md5(string_agg(x::text, E'\n' order by x::text)) into huella_ordenes from public.work_orders x;
  if huella_ordenes is distinct from '6eec7b75910ad8000b06a9b564f930f9' then
    problemas := problemas || format('work_orders cambió desde el ensayo (huella %s)', huella_ordenes);
  end if;
  foreach t in array orden loop
    select count(*) into n from _del where tabla = t;
    if n <> coalesce((esperados ->> t)::bigint, 0) then
      problemas := problemas || format('%s: %s filas en el conjunto; el ensayo tuvo %s',
                                       t, n, coalesce((esperados ->> t)::bigint, 0));
    end if;
  end loop;

  if array_length(problemas, 1) > 0 then
    raise exception 'PURGE_ABORT: %', array_to_string(problemas, ' | ');
  end if;

  -- ── 2. Foto de antes ────────────────────────────────────────────
  select coalesce(jsonb_object_agg(k, c), '{}') into por_tipo
    from (select order_kind k, count(*) c from public.work_orders
           where id in (select id from _del where tabla = 'work_orders') group by 1) s;

  foreach t in array orden loop
    execute format('select count(*) from public.%I', t) into n;
    antes_total := antes_total || jsonb_build_object(t, n);
  end loop;

  for r in
    select schemaname s, tablename tb from pg_tables
     where (schemaname = 'public' and tablename::text <> all(orden) and tablename <> 'audit_logs')
        or (schemaname = 'auth' and tablename = 'users')
  loop
    execute format('select md5(coalesce(string_agg(x::text, E''\n'' order by x::text), '''')) from %I.%I x', r.s, r.tb)
      into h;
    huellas := huellas || jsonb_build_object(r.s || '.' || r.tb, h);
  end loop;

  select count(*) into audit_antes from public.audit_logs;
  select count(*) into audit_previas from public.audit_logs a
   where exists (select 1 from _del d where d.tabla = a.entity_type and d.id = a.entity_id);
  select md5(coalesce(string_agg(a::text, E'\n' order by a::text), '')) into huella_audit_ajena
    from public.audit_logs a
   where not exists (select 1 from _del d where d.tabla = a.entity_type and d.id = a.entity_id);

  -- ── 3. DELETEs ──────────────────────────────────────────────────
  foreach t in array orden loop
    execute format('delete from public.%I x where x.id in (select id from _del where tabla = %L)', t, t);
    get diagnostics n = row_count;
    select count(*) into esperado from _del where tabla = t;
    if n <> esperado then
      raise exception 'PURGE_ABORT: en % se borraron % filas y se esperaban %', t, n, esperado;
    end if;
    borrados := borrados || jsonb_build_object(t, n);
  end loop;

  -- ── 4. Comprobaciones ───────────────────────────────────────────
  foreach t in array orden loop
    execute format('select count(*) from public.%I', t) into n;
    quedan := quedan || jsonb_build_object(t, n);
    if n <> (antes_total ->> t)::bigint - (borrados ->> t)::bigint then
      raise exception 'PURGE_ABORT: % quedó con % filas; se esperaban %',
        t, n, (antes_total ->> t)::bigint - (borrados ->> t)::bigint;
    end if;
  end loop;

  for r in select key, value #>> '{}' v from jsonb_each(huellas) loop
    execute format('select md5(coalesce(string_agg(x::text, E''\n'' order by x::text), '''')) from %s x',
                   (select format('%I.%I', split_part(r.key, '.', 1), split_part(r.key, '.', 2))))
      into h;
    if h is distinct from r.v then cambiadas := cambiadas || r.key; end if;
  end loop;
  if array_length(cambiadas, 1) > 0 then
    raise exception 'PURGE_ABORT: cambiaron tablas que no se debían tocar: %', array_to_string(cambiadas, ', ');
  end if;

  select count(*) into audit_despues from public.audit_logs;

  -- audit_logs: sólo lo del conjunto, por entidad e id.
  delete from public.audit_logs a
   where exists (select 1 from _del d where d.tabla = a.entity_type and d.id = a.entity_id);
  get diagnostics audit_borradas = row_count;
  if audit_borradas <> audit_previas + (audit_despues - audit_antes) then
    raise exception 'PURGE_ABORT: audit_logs borró % filas; se esperaban % previas + % del borrado',
      audit_borradas, audit_previas, audit_despues - audit_antes;
  end if;
  select count(*) into n from public.audit_logs a
   where exists (select 1 from _del d where d.tabla = a.entity_type and d.id = a.entity_id);
  if n > 0 then raise exception 'PURGE_ABORT: quedan % filas de audit_logs del conjunto', n; end if;
  select md5(coalesce(string_agg(a::text, E'\n' order by a::text), '')) into h from public.audit_logs a;
  if h is distinct from huella_audit_ajena then
    raise exception 'PURGE_ABORT: cambiaron filas de audit_logs ajenas al conjunto';
  end if;

  -- ── 5. Reporte (se lee antes del COMMIT) ────────────────────────
  create temp table _reporte on commit drop as select jsonb_build_object(
    'ventas_por_tipo', por_tipo,
    'borrados', borrados,
    'quedan', quedan,
    'fk_revisadas', revisadas,
    'tablas_comparadas_sin_cambios', (select count(*) from jsonb_object_keys(huellas)),
    'tablas_cambiadas', to_jsonb(cambiadas),
    'tablas_contables_encontradas', to_jsonb(contables),
    'audit_logs_agregados_por_triggers', audit_despues - audit_antes,
    'audit_logs_previas_del_conjunto', audit_previas,
    'audit_logs_borradas', audit_borradas
  ) as reporte;
end
$purge$;

select reporte from _reporte;

commit;
