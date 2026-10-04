-- ═══════════════════════════════════════════════════════════════════════
-- 0056 — Registro por QR: teléfono con código de país
--
-- Hay clientes extranjeros, sin DUI y con teléfono de otro país. El DUI ya
-- era opcional; ahora el teléfono trae su código de país (el formulario pone
-- +503 por defecto y se puede cambiar):
--
--   · +503: 8 dígitos y se guarda como siempre, los 8 dígitos solos;
--   · otro país: hasta 15 dígitos en total (E.164) y se guarda «+<código> <número>».
--
-- Misma firma que en 0055: create or replace no cambia permisos.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.public_customer_signup(
  p_branch_code text,
  p_datos       jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org        uuid;
  v_tipo       text := p_datos->>'tipo';
  v_nombre     text := nullif(trim(p_datos->>'nombre'), '');
  v_apellido   text := nullif(trim(p_datos->>'apellido'), '');
  v_razon      text := nullif(trim(p_datos->>'razon_social'), '');
  v_comercial  text := nullif(trim(p_datos->>'nombre_comercial'), '');
  v_dui        text := nullif(regexp_replace(coalesce(p_datos->>'dui', ''), '[^0-9]', '', 'g'), '');
  v_nit        text := nullif(regexp_replace(coalesce(p_datos->>'nit', ''), '[^0-9]', '', 'g'), '');
  v_nrc        text := nullif(regexp_replace(coalesce(p_datos->>'nrc', ''), '[^0-9]', '', 'g'), '');
  v_tel        text := nullif(regexp_replace(coalesce(p_datos->>'telefono', ''), '[^0-9]', '', 'g'), '');
  -- Código de país sin el «+». Sin él, El Salvador (el formulario lo trae puesto).
  v_pais       text := coalesce(nullif(regexp_replace(coalesce(p_datos->>'codigo_pais', ''), '[^0-9]', '', 'g'), ''), '503');
  v_telefono   text;
  v_correo     text := nullif(lower(trim(p_datos->>'correo')), '');
  v_vehiculos  jsonb := coalesce(p_datos->'vehiculos', '[]'::jsonb);
  v_customer   uuid;
  v_v          jsonb;
  v_placa      text;
  v_tamano     text;
  v_tipo_veh   uuid;
  v_creados    text[] := '{}';
  v_omitidos   text[] := '{}';
begin
  -- ── Sucursal del QR ──
  select organization_id into v_org
    from public.branches
   where upper(code) = upper(trim(coalesce(p_branch_code, ''))) and active
   limit 1;
  if v_org is null then
    raise exception 'Este código QR no es válido. Pedí uno nuevo en la sucursal.' using errcode = '22023';
  end if;

  -- ── Freno contra abuso ──
  if (select count(*) from public.customers
       where organization_id = v_org and source = 'web'
         and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'Hay muchos registros en este momento. Intentá de nuevo en unos minutos.' using errcode = '54000';
  end if;

  -- ── Validaciones ──
  if coalesce((p_datos->>'acepta')::boolean, false) is not true then
    raise exception 'Tenés que aceptar el uso de tus datos para registrarte.' using errcode = '22023';
  end if;
  if v_tipo not in ('individual', 'company') then
    raise exception 'Elegí si te registrás como persona o como empresa.' using errcode = '22023';
  end if;
  if v_tipo = 'individual' and (v_nombre is null or v_apellido is null) then
    raise exception 'Escribí tu nombre y tu apellido.' using errcode = '22023';
  end if;
  if v_tipo = 'company' and v_razon is null then
    raise exception 'Escribí la razón social de la empresa.' using errcode = '22023';
  end if;
  if greatest(char_length(coalesce(v_nombre, '')), char_length(coalesce(v_apellido, '')),
              char_length(coalesce(v_razon, '')), char_length(coalesce(v_comercial, ''))) > 120 then
    raise exception 'Uno de los nombres es demasiado largo.' using errcode = '22023';
  end if;
  if v_pais !~ '^[0-9]{1,4}$' then
    raise exception 'Revisá el código de país del teléfono.' using errcode = '22023';
  end if;
  if v_pais = '503' then
    if v_tel is null or v_tel !~ '^[0-9]{8}$' then
      raise exception 'El teléfono tiene que tener 8 dígitos.' using errcode = '22023';
    end if;
    -- Como el resto de la base: los números salvadoreños, 8 dígitos solos.
    v_telefono := v_tel;
  else
    -- E.164: hasta 15 dígitos contando el código de país.
    if v_tel is null or char_length(v_tel) < 4 or char_length(v_pais || v_tel) > 15 then
      raise exception 'Revisá el número de teléfono.' using errcode = '22023';
    end if;
    v_telefono := '+' || v_pais || ' ' || v_tel;
  end if;
  if v_correo is not null and (v_correo !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_correo) > 100) then
    raise exception 'El correo no es válido.' using errcode = '22023';
  end if;
  if v_dui is not null and v_dui !~ '^[0-9]{9}$' then
    raise exception 'El DUI tiene que tener 9 dígitos.' using errcode = '22023';
  end if;
  if v_nit is not null and v_nit !~ '^([0-9]{14}|[0-9]{9})$' then
    raise exception 'El NIT tiene que tener 14 dígitos (o 9 si es tu DUI).' using errcode = '22023';
  end if;
  if v_nrc is not null and v_nrc !~ '^[0-9]{1,8}$' then
    raise exception 'El NRC tiene hasta 8 dígitos.' using errcode = '22023';
  end if;
  if v_tipo = 'company' and v_nit is null then
    raise exception 'Escribí el NIT de la empresa.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_vehiculos) <> 'array' or jsonb_array_length(v_vehiculos) = 0 then
    raise exception 'Agregá al menos un vehículo.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_vehiculos) > 10 then
    raise exception 'Podés registrar hasta 10 vehículos; el resto, en caja.' using errcode = '22023';
  end if;
  for v_v in select * from jsonb_array_elements(v_vehiculos) loop
    v_placa := upper(regexp_replace(coalesce(v_v->>'placa', ''), '[^A-Za-z0-9]', '', 'g'));
    if v_placa !~ '^[A-Z0-9]{3,10}$' then
      raise exception 'Revisá la placa «%»: tiene que tener entre 3 y 10 letras o números.', coalesce(v_v->>'placa', '')
        using errcode = '22023';
    end if;
    if coalesce(v_v->>'tamano', '') not in ('S', 'M', 'L') then
      raise exception 'Elegí el tamaño del vehículo %.', v_placa using errcode = '22023';
    end if;
  end loop;

  -- ── ¿Ya existe? No se revela ni se toca nada ──
  if exists (
    select 1 from public.customers
     where organization_id = v_org and active
       and ((v_dui is not null and normalized_dui = v_dui)
         or (v_nit is not null and normalized_nit = v_nit))
  ) then
    return jsonb_build_object('ok', true, 'existente', true);
  end if;

  insert into public.customers (
    organization_id, customer_type, first_name, last_name, legal_name, trade_name,
    dui, nit, nrc, phone, email, billing_email, fiscal_document_type, fiscal_doc_type,
    source, notes, active
  ) values (
    v_org, v_tipo,
    case when v_tipo = 'individual' then v_nombre end,
    case when v_tipo = 'individual' then v_apellido end,
    case when v_tipo = 'company' then v_razon end,
    case when v_tipo = 'company' then v_comercial end,
    case when v_dui is not null then substr(v_dui, 1, 8) || '-' || substr(v_dui, 9, 1) end,
    v_nit, v_nrc, v_telefono, v_correo,
    case when v_tipo = 'company' then v_correo end,
    -- Siempre FCF: un CCF exige actividad y dirección fiscal, que se completan
    -- en caja. Registrarse no puede fallar por eso.
    'fcf',
    case when v_tipo = 'company' and v_nit is not null then '36'
         when v_dui is not null then '13' end,
    'web', 'Registro por QR', true
  )
  returning id into v_customer;

  for v_v in select * from jsonb_array_elements(v_vehiculos) loop
    v_placa := upper(regexp_replace(v_v->>'placa', '[^A-Za-z0-9]', '', 'g'));
    v_tamano := v_v->>'tamano';

    -- La placa ya está registrada (de este cliente o de otro): no se duplica.
    if exists (select 1 from public.vehicles
                where organization_id = v_org and active and normalized_plate = v_placa)
       or v_placa = any(v_creados) then
      v_omitidos := v_omitidos || v_placa;
      continue;
    end if;

    select id into v_tipo_veh from public.vehicle_types
     where organization_id = v_org and active
       and size_category = case v_tamano when 'S' then 'small' when 'M' then 'medium' else 'large' end
     order by sort_order limit 1;
    if v_tipo_veh is null then
      raise exception 'Falta configurar los tipos de vehículo de la sucursal.' using errcode = '22023';
    end if;

    insert into public.vehicles (organization_id, customer_id, vehicle_type_id, plate, brand, model, color, active)
    values (v_org, v_customer, v_tipo_veh, v_placa,
            nullif(left(trim(coalesce(v_v->>'marca', '')), 40), ''),
            nullif(left(trim(coalesce(v_v->>'modelo', '')), 40), ''),
            nullif(left(trim(coalesce(v_v->>'color', '')), 30), ''),
            true);
    v_creados := v_creados || v_placa;
  end loop;

  return jsonb_build_object('ok', true, 'existente', false,
                            'vehiculos', to_jsonb(v_creados), 'omitidos', to_jsonb(v_omitidos));
end;
$$;

comment on function public.public_customer_signup(text, jsonb) is
  'Registro público por QR (0055): crea cliente y vehículos. No modifica clientes existentes ni duplica placas.';

revoke all on function public.public_customer_signup(text, jsonb) from public;
grant execute on function public.public_customer_signup(text, jsonb) to anon, authenticated;
