-- ============================================================
-- Migration: 0028_fix_audit_entity_id.sql
-- Description: Arregla write_audit_log() para tablas con PK compuesta.
--
--   BUG: 0023 asume que toda tabla auditada tiene una columna `id` uuid:
--
--     v_entity_id := (row_to_json(new)::jsonb->>'id')::uuid;
--
--   `public.user_roles` no la tiene — su PK es compuesta (user_id, role_id).
--   Entonces v_entity_id queda null y el insert viola el NOT NULL de
--   audit_logs.entity_id. Como el trigger es AFTER INSERT OR DELETE sobre
--   user_roles, la excepción aborta la transacción entera:
--
--     ERROR: null value in column "entity_id" of relation "audit_logs"
--
--   Impacto: NINGUNA asignación de rol funcionaba. Ni el bootstrap de
--   Super Admin de 0026, ni admin_set_user_roles(), ni la Edge Function
--   admin-create-user (que inserta en user_roles después de crear la cuenta,
--   y ante el fallo revierte el alta). El sistema de roles estaba muerto.
--
--   FIX:
--   1. entity_id cae a `user_id` cuando no hay `id`. Para user_roles el
--      sujeto auditado es el usuario; qué rol se le otorgó ya queda en
--      new_data/old_data.
--   2. organization_id se resuelve desde el profile cuando la fila auditada
--      no la trae. Sin esto las filas quedaban con org null y la policy
--      "audit_logs_select" (organization_id = get_my_organization_id())
--      las ocultaba: se auditaba en un agujero negro.
--
--   Nota: sólo user_roles tiene este problema; las otras 9 tablas con
--   trigger de auditoría sí tienen columna `id`. Si en el futuro auditás
--   otra tabla con PK compuesta, extendé el coalesce de abajo.
-- ============================================================

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row           jsonb;
  v_entity_id     uuid;
  v_org_id        uuid;
  v_branch_id     uuid;
  v_user_id       uuid;
  v_old           jsonb;
  v_new           jsonb;
begin
  -- Una sola serialización de la fila relevante (antes se hacía hasta 5 veces).
  v_row := case tg_op
    when 'DELETE' then row_to_json(old)::jsonb
    else row_to_json(new)::jsonb
  end;

  v_user_id := (v_row->>'user_id')::uuid;

  -- `id` cuando existe; si no, el sujeto de la fila (tablas con PK compuesta).
  v_entity_id := coalesce((v_row->>'id')::uuid, v_user_id);

  if v_entity_id is null then
    raise exception
      'write_audit_log: no se pudo derivar entity_id para la tabla %. '
      'Agregá su clave al coalesce en 0028_fix_audit_entity_id.sql.',
      tg_table_name;
  end if;

  v_org_id    := (v_row->>'organization_id')::uuid;
  v_branch_id := (v_row->>'branch_id')::uuid;

  -- La fila puede no llevar organización (user_roles). Se resuelve desde el
  -- profile del sujeto, y si no, desde el del propio autor del cambio.
  if v_org_id is null then
    select p.organization_id into v_org_id
    from public.profiles p
    where p.id = coalesce(v_user_id, auth.uid())
    limit 1;
  end if;

  v_old := case when tg_op in ('UPDATE','DELETE') then row_to_json(old)::jsonb else null end;
  v_new := case when tg_op in ('INSERT','UPDATE') then row_to_json(new)::jsonb else null end;

  insert into public.audit_logs (
    organization_id, branch_id, user_id,
    action, entity_type, entity_id,
    old_data, new_data
  ) values (
    v_org_id,
    v_branch_id,
    auth.uid(),
    tg_op,
    tg_table_name,
    v_entity_id,
    v_old,
    v_new
  );

  return null;  -- after trigger, return value ignored
end;
$$;

comment on function public.write_audit_log() is
  'Trigger de auditoría. entity_id cae a user_id en tablas con PK compuesta (user_roles); organization_id se resuelve desde el profile cuando la fila no la trae.';
