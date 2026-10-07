-- ============================================================
-- Migration: 0073_vistas_solo_lectura.sql
-- Description: Las vistas de public no se leen sin sesión ni se escriben.
--
--   Supabase da ALL sobre todo objeto nuevo a anon y authenticated. En las
--   vistas eso dejó tres problemas:
--
--   1. anon (la llave pública, sin iniciar sesión) podía leer ventas, vales,
--      pólizas y producción de las máquinas: las vistas que no son
--      security_invoker corren como su dueño y no pasan por el RLS.
--   2. v_plc_faults y v_plc_gateway_status son vistas simples, actualizables:
--      con INSERT/UPDATE sobre ellas se escribía en plc_machine_events y
--      plc_gateways saltándose el RLS.
--   3. Nadie de la app lee una vista sin sesión (el correo usa service_role;
--      corsa-cloud-api lee con el JWT del usuario; el registro por QR es una
--      RPC), así que no se le quita nada a nadie.
--
--   Se hace para TODAS las vistas de public, no para una lista: una vista
--   nueva que se olvide de esto no debería volver a abrir el agujero. Las
--   vistas que se creen después de 0073 tienen que repetir el revoke (o ser
--   security_invoker).
--
--   v_vouchers pasa a security_invoker: su lector (Cupones) ya tiene
--   vouchers.read. v_rain_policies NO: lee rain_policies.code para decir si la
--   póliza pide código, y esa columna está cerrada a authenticated a propósito
--   (0071); como invoker, Seguros y el canje del POS fallarían. Las vistas de
--   ventas y del PLC siguen corriendo como su dueño para no cambiar qué ve cada
--   rol (Contabilidad tiene Ventas y el Resumen sin orders.read ni plc.read);
--   con una sola organización no hay datos ajenos que filtrar.
-- ============================================================

do $$
declare
  v record;
begin
  for v in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('v', 'm')
  loop
    execute format('revoke all on public.%I from anon', v.relname);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', v.relname);
    execute format('grant select on public.%I to authenticated', v.relname);
  end loop;
end $$;

alter view public.v_vouchers      set (security_invoker = true);
