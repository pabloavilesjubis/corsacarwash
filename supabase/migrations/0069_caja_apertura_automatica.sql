-- ═══════════════════════════════════════════════════════════════════════
-- 0069 — La caja abre con lo que quedó en el último cierre
--
-- El efectivo inicial no se escribe: es el efectivo final del cierre
-- anterior, que el sistema ya tiene. caja_abrir sin monto lo toma de ahí (y
-- el POS abre la caja solo al entrar). Sólo la primera apertura de una
-- sucursal, sin cierre anterior, necesita el monto.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.caja_abrir(p_branch_id uuid, p_monto numeric default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_reg   uuid;
  v_id    uuid;
  v_monto numeric(12,2);
begin
  if not public.has_permission('cash.open') then
    raise exception 'No autorizado: se requiere cash.open' using errcode = '42501';
  end if;
  if p_branch_id not in (select public.get_accessible_branch_ids()) then
    raise exception 'Sin acceso a esa sucursal' using errcode = '42501';
  end if;

  select id into v_reg from public.cash_registers
   where branch_id = p_branch_id and active = true order by code limit 1
   for update;
  if v_reg is null then raise exception 'Esta sucursal no tiene caja configurada' using errcode = 'P0002'; end if;
  if exists (select 1 from public.cash_sessions where cash_register_id = v_reg and status = 'open') then
    raise exception 'La caja ya está abierta' using errcode = '22023';
  end if;

  -- Sin monto: lo que quedó en el último cierre.
  if p_monto is null then
    select coalesce((resumen->>'efectivo_final')::numeric, expected_cash) into v_monto
      from public.cash_sessions
     where cash_register_id = v_reg and status <> 'open'
     order by closed_at desc nulls last limit 1;
    if v_monto is null then
      raise exception 'Es la primera apertura de esta caja: indicá el efectivo inicial' using errcode = '22023';
    end if;
  else
    v_monto := round(p_monto, 2);
  end if;
  if v_monto < 0 then
    raise exception 'El efectivo inicial no puede ser negativo' using errcode = '22023';
  end if;

  insert into public.cash_sessions (cash_register_id, opened_by, opening_amount, status)
  values (v_reg, auth.uid(), v_monto, 'open')
  returning id into v_id;

  insert into public.cash_movements (cash_session_id, type, amount, reference_type, description, created_by)
  values (v_id, 'cash_in', v_monto, 'apertura', 'Apertura de caja', auth.uid());

  return v_id;
end;
$$;
revoke all on function public.caja_abrir(uuid, numeric) from public, anon;
grant execute on function public.caja_abrir(uuid, numeric) to authenticated;
