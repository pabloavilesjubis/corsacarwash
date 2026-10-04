-- ════════════════════════════════════════════════════════════════════
-- arranque-correlativos-produccion.sql — YA APLICADO, es un registro
-- ════════════════════════════════════════════════════════════════════
--
-- Aplicado en producción (zvbpkfuehnmqlqimyxcs) el 2026-10-03, autorizado
-- por el dueño, primero en una transacción con ROLLBACK (dry-run) y después
-- con COMMIT. NO volver a correr: las guardas del principio lo abortarían
-- igual, porque el emisor y los correlativos ya existen.
--
-- Qué hace:
--   1. Carga el emisor (GRUPO JUBIS / CORSA CARWASH) en fiscal_issuer_config,
--      con emitir_en_pos = false: NO habilita la emisión desde el POS.
--   2. Siembra los correlativos de PRODUCCIÓN (ambiente 01, M001/P001) con el
--      ÚLTIMO número usado en el sistema anterior: FCF 1502 y CCF 92.
--      fiscal_correlatives guarda el último usado; la próxima emisión es +1.
--   3. Pone en 0 el contador de ventas internas ESC/2026, que quedó en 16
--      por las ventas de prueba ya purgadas (purge-test-sales.sql).
--
-- Resultado verificado después del COMMIT:
--   Próxima venta interna  ESC-2026-000001  (#01)
--   Próximo FCF            DTE-01-M001P001-000000000001503
--   Próximo CCF            DTE-03-M001P001-000000000000093
--   fiscal_audit_events: dos CORRELATIVE_SEEDED (anterior = null).
--
-- Pendiente antes del primer DTE real: confirmar que el municipio 14 es el
-- que el sistema anterior manda en sus DTE sellados (catálogo previo a la
-- reforma territorial de 2024).

begin;

-- Guardas: si algo no coincide con el diagnóstico, se aborta todo.
do $$
begin
  if (select count(*) from public.work_orders) > 0 then raise exception 'Hay work_orders: no se reinicia la venta interna'; end if;
  if (select count(*) from public.invoices) > 0 then raise exception 'Hay invoices'; end if;
  if (select count(*) from public.fiscal_documents) > 0 then raise exception 'Hay fiscal_documents'; end if;
  if (select count(*) from public.fiscal_correlatives) > 0 then raise exception 'Ya hay correlativos sembrados'; end if;
  if (select count(*) from public.fiscal_issuer_config) > 0 then raise exception 'Ya hay emisor configurado'; end if;
  if (select last_sequence from public.order_number_sequences
       where organization_id = '00000000-0000-0000-0000-000000000001' and branch_code = 'ESC' and year = 2026) <> 16
    then raise exception 'El contador de ventas no está en 16'; end if;
end $$;

-- 1. Emisor (emitir_en_pos queda en false: esto NO habilita emisión)
insert into public.fiscal_issuer_config (
  organization_id, branch_id, nit, nrc, nombre, nombre_comercial,
  cod_actividad, desc_actividad, tipo_establecimiento, departamento, municipio, complemento,
  telefono, correo, cod_estable, cod_punto_venta, cod_estable_mh, cod_punto_venta_mh, activo, emitir_en_pos
) values (
  '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001',
  '06231909241018', '3491162', 'GRUPO JUBIS S.A. DE C.V.', 'CORSA CARWASH',
  '45208', 'Lavado y pasteado de vehículos (carwash)', '01', '06', '14',
  '3a Avenida Norte No. 322, Colonia Escalón',
  '74893277', 'corsacarwash@gmail.com', 'M001', 'P001', null, null, true, false
);

-- 2. Correlativos de producción: se guarda el ÚLTIMO utilizado; la próxima emisión es +1.
select dte_type, establishment_code, pos_code, last_minted
  from public.fiscal_seed_correlative('00000000-0000-0000-0000-000000000001', '01', '01', 'M001', 'P001', 1502,
                                      'arranque: último FCF del sistema anterior = 1502');
select dte_type, establishment_code, pos_code, last_minted
  from public.fiscal_seed_correlative('00000000-0000-0000-0000-000000000001', '01', '03', 'M001', 'P001', 92,
                                      'arranque: último CCF del sistema anterior = 92');

-- 3. Venta interna: la próxima es ESC-2026-000001
update public.order_number_sequences set last_sequence = 0
 where organization_id = '00000000-0000-0000-0000-000000000001' and branch_code = 'ESC' and year = 2026
   and last_sequence = 16;

commit;
