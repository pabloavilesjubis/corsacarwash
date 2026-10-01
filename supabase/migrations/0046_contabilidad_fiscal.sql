-- ============================================================
-- Migration: 0046_contabilidad_fiscal.sql
-- Description: Contabilidad fiscal — invalidaciones, Notas de Crédito,
--              Sujetos Excluidos y el sembrado de correlativos desde la app.
--
-- QUÉ AGREGA
--   1. Secuencias por AMBIENTE. Sandbox y producción ya no comparten números.
--   2. Los tipos 05 (Nota de Crédito) y 14 (Sujeto Excluido) pueden numerarse.
--   3. fiscal_invalidations: el evento de invalidación ante Hacienda.
--   4. RPC para la app: sembrar correlativos y autorizar al Worker.
--   5. v_fiscal_documents: el historial que muestra Contabilidad.
--   6. Permisos: screens.accounting, fiscal.issue, fiscal.seed.
--
-- POR QUÉ LAS SECUENCIAS VAN POR AMBIENTE
--   Hasta acá había una sola secuencia por tipo/establecimiento/punto de
--   venta. Las pruebas contra el sandbox del MH gastaban números de esa misma
--   secuencia, y como `last_minted` sólo sube, al pasar a producción no había
--   forma de arrancar en el número correcto: si las pruebas llegaron al 10, el
--   primer documento real salía con el 11. Peor: el numeroControl de una
--   prueba y el de un documento real con el mismo número chocaban en el
--   UNIQUE. El ambiente ('00' pruebas, '01' producción) entra ahora en la
--   llave de la secuencia y en la unicidad del numeroControl.
--
-- POR QUÉ LA INVALIDACIÓN ES UNA TABLA APARTE
--   Una invalidación no es un DTE: no tiene numeroControl ni consume
--   correlativo. Es un evento firmado que apunta a un documento ya sellado,
--   tiene su propio codigoGeneracion y recibe su propio sello. Meterla en
--   fiscal_documents obligaría a que media tabla sea nullable y a filtrar
--   «no es un documento» en cada consulta.
--
--   Que Hacienda rechace una invalidación no quema nada: no hay correlativo
--   que perder. Por eso un rechazo deja abrir otra invalidación del mismo
--   documento, y sólo una ACEPTADA lo cierra para siempre.
-- ============================================================


-- ─────────────────────────────────────────────
-- 1. SECUENCIAS POR AMBIENTE
-- ─────────────────────────────────────────────

alter table public.fiscal_correlatives
  add column if not exists ambiente text not null default '00';

alter table public.fiscal_correlatives
  drop constraint if exists fiscal_correlatives_ambiente_valido,
  add  constraint fiscal_correlatives_ambiente_valido
    check (ambiente in ('00', '01'));

-- El UNIQUE de 0043 se creó sin nombre explícito; Postgres le puso uno largo
-- que puede venir truncado. Se busca por sus columnas en vez de adivinarlo.
do $$
declare v_nombre text;
begin
  select c.conname into v_nombre
    from pg_constraint c
   where c.conrelid = 'public.fiscal_correlatives'::regclass
     and c.contype = 'u'
     and (select array_agg(a.attname::text order by a.attname)
            from unnest(c.conkey) k
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)
         = array['dte_type', 'establishment_code', 'organization_id', 'pos_code'];
  if v_nombre is not null then
    execute format('alter table public.fiscal_correlatives drop constraint %I', v_nombre);
  end if;
end $$;

alter table public.fiscal_correlatives
  drop constraint if exists fiscal_correlatives_secuencia_uq,
  add  constraint fiscal_correlatives_secuencia_uq
    unique (organization_id, ambiente, dte_type, establishment_code, pos_code);

-- 05 Nota de Crédito y 14 Sujeto Excluido se suman a 01 y 03.
alter table public.fiscal_correlatives
  drop constraint if exists fiscal_correlatives_tipo_valido,
  add  constraint fiscal_correlatives_tipo_valido
    check (dte_type in ('01', '03', '05', '14'));

alter table public.fiscal_documents
  add column if not exists ambiente       text not null default '00',
  add column if not exists invalidated_at timestamptz;

alter table public.fiscal_documents
  drop constraint if exists fiscal_documents_ambiente_valido,
  add  constraint fiscal_documents_ambiente_valido
    check (ambiente in ('00', '01'));

-- Un numeroControl es único dentro de una organización y un ambiente. La
-- prueba 1 y el documento real 1 son dos cosas distintas ante Hacienda, y dos
-- organizaciones son dos contribuyentes con numeraciones independientes
-- aunque usen los mismos códigos de establecimiento.
drop index if exists public.fiscal_documents_numero_control_uidx;
create unique index if not exists fiscal_documents_numero_control_amb_uidx
  on public.fiscal_documents (organization_id, ambiente, numero_control)
  where numero_control is not null;

create index if not exists fiscal_documents_org_tipo_idx
  on public.fiscal_documents (organization_id, ambiente, dte_type, created_at desc);


-- ─────────────────────────────────────────────
-- 2. AUDITORÍA: los eventos de invalidación
-- ─────────────────────────────────────────────

alter table public.fiscal_audit_events
  add column if not exists fiscal_invalidation_id uuid;

alter table public.fiscal_audit_events
  drop constraint if exists fiscal_audit_events_tipo_valido,
  add  constraint fiscal_audit_events_tipo_valido
    check (event_type in (
      'DTE_CREATED', 'DTE_VALIDATED', 'DTE_SIGNED', 'MH_AUTHENTICATED',
      'DTE_SUBMITTED', 'DTE_ACCEPTED', 'DTE_REJECTED', 'DTE_RETRY',
      'CORRELATIVE_RESERVED', 'CORRELATIVE_CONSUMED',
      'CORRELATIVE_SEEDED', 'DTE_INVALIDATED',
      'INVALIDATION_CREATED', 'INVALIDATION_SIGNED', 'INVALIDATION_ACCEPTED',
      'INVALIDATION_REJECTED', 'INVALIDATION_RETRY'
    ));


-- ─────────────────────────────────────────────
-- 3. SEMBRADO Y APERTURA, AHORA CON AMBIENTE
-- ─────────────────────────────────────────────
-- Cambia la firma, así que se borran las de 0043. PostgREST llama por nombre
-- de parámetro: el Worker tiene que mandar p_ambiente desde ahora, y si no lo
-- manda falla fuerte en vez de numerar en el ambiente equivocado.

drop function if exists public.fiscal_seed_correlative(uuid, text, text, text, bigint, text);
drop function if exists public.fiscal_open_document(text, uuid, uuid, text, uuid, uuid, text);

create or replace function public.fiscal_seed_correlative(
  p_organization_id    uuid,
  p_ambiente           text,
  p_dte_type           text,
  p_establishment_code text,
  p_pos_code           text,
  p_last_issued        bigint,
  p_actor              text default null
) returns public.fiscal_correlatives
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fila   public.fiscal_correlatives;
  v_previo bigint;
begin
  if p_last_issued is null or p_last_issued < 0 then
    raise exception 'El último correlativo emitido tiene que ser un número de 0 en adelante: %', p_last_issued
      using errcode = 'check_violation';
  end if;

  -- Con la fila bloqueada: dos siembras simultáneas se serializan, y la
  -- segunda ve el valor de la primera en vez de quedar absorbida por el
  -- greatest() de abajo sin que nadie se entere.
  select last_minted into v_previo
    from public.fiscal_correlatives
   where organization_id = p_organization_id and ambiente = p_ambiente
     and dte_type = p_dte_type and establishment_code = p_establishment_code
     and pos_code = p_pos_code
   for update;

  -- Sube, nunca baja. Bajar entregaría otra vez números que ya salieron, y
  -- eso es un numeroControl duplicado ante Hacienda. Se rechaza con un error
  -- en vez de ignorarlo en silencio: quien siembra tiene que enterarse de que
  -- su número no se aplicó.
  if v_previo is not null and p_last_issued < v_previo then
    raise exception
      'La secuencia ya va en %. Sembrar % la haría retroceder y duplicaría numeración ante Hacienda.',
      v_previo, p_last_issued
      using errcode = 'check_violation';
  end if;

  insert into public.fiscal_correlatives (
    organization_id, ambiente, dte_type, establishment_code, pos_code,
    seeded, seeded_at, seeded_by, last_minted
  ) values (
    p_organization_id, p_ambiente, p_dte_type, p_establishment_code, p_pos_code,
    true, now(), p_actor, p_last_issued
  )
  on conflict (organization_id, ambiente, dte_type, establishment_code, pos_code) do update
    set seeded      = true,
        last_minted = greatest(public.fiscal_correlatives.last_minted, excluded.last_minted),
        seeded_at   = now(),
        seeded_by   = excluded.seeded_by,
        updated_at  = now()
  returning * into v_fila;

  insert into public.fiscal_audit_events (organization_id, event_type, payload, actor)
  values (p_organization_id, 'CORRELATIVE_SEEDED',
          jsonb_build_object('ambiente', p_ambiente, 'dte_type', p_dte_type,
                             'establishment_code', p_establishment_code,
                             'pos_code', p_pos_code,
                             'anterior', v_previo, 'last_minted', v_fila.last_minted),
          p_actor);

  return v_fila;
end;
$$;

comment on function public.fiscal_seed_correlative(uuid, text, text, text, text, bigint, text) is
  'Fija el último número emitido de una secuencia, por ambiente. Sube, nunca baja: intentar bajarla es un error. Cada llamada queda en fiscal_audit_events.';


create or replace function public.fiscal_open_document(
  p_idempotency_key text,
  p_organization_id uuid,
  p_branch_id       uuid,
  p_dte_type        text,
  p_ambiente        text,
  p_invoice_id      uuid default null,
  p_customer_id     uuid default null,
  p_actor           text default null
) returns public.fiscal_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc    public.fiscal_documents;
  v_emisor public.fiscal_issuer_config;
  v_numero bigint;
begin
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'fiscal_open_document necesita una llave de idempotencia'
      using errcode = 'null_value_not_allowed';
  end if;
  if p_ambiente is null or p_ambiente not in ('00', '01') then
    raise exception 'Ambiente inválido: %. Se espera 00 (pruebas) o 01 (producción).', p_ambiente
      using errcode = 'check_violation';
  end if;

  -- (1) Gana una sola transacción por llave. Ver 0043.
  insert into public.fiscal_documents (
    idempotency_key, organization_id, branch_id, invoice_id, customer_id,
    dte_type, document_type, ambiente, status
  ) values (
    p_idempotency_key, p_organization_id, p_branch_id, p_invoice_id, p_customer_id,
    p_dte_type, p_dte_type, p_ambiente, 'CREATED'
  )
  on conflict (idempotency_key) do nothing
  returning * into v_doc;

  if v_doc.id is null then
    select * into v_doc
      from public.fiscal_documents
     where idempotency_key = p_idempotency_key;
    -- La llave repetida tiene que ser LA MISMA solicitud. Si no coincide la
    -- organización, el tipo o el ambiente, devolver el documento existente
    -- sería entregarle a otro contribuyente un documento ajeno, o retransmitir
    -- a producción una prueba del sandbox con su numeración.
    if v_doc.organization_id is distinct from p_organization_id
       or v_doc.dte_type is distinct from p_dte_type
       or v_doc.ambiente is distinct from p_ambiente then
      raise exception
        'La llave % ya pertenece a otro documento (tipo %, ambiente %). No se reutiliza.',
        p_idempotency_key, v_doc.dte_type, v_doc.ambiente
        using errcode = 'unique_violation';
    end if;
    return v_doc;
  end if;

  -- La sucursal tiene que ser de la organización: la configuración fiscal de
  -- otra pondría su NIT y sus códigos en un documento numerado por ésta.
  select * into v_emisor
    from public.fiscal_issuer_config
   where branch_id = p_branch_id and organization_id = p_organization_id and activo;

  if v_emisor.id is null then
    raise exception 'La sucursal % no tiene configuración fiscal activa en esta organización (fiscal_issuer_config)', p_branch_id
      using errcode = 'foreign_key_violation';
  end if;

  if p_customer_id is not null and not exists (
       select 1 from public.customers
        where id = p_customer_id and organization_id = p_organization_id) then
    raise exception 'El cliente % no es de esta organización', p_customer_id
      using errcode = 'foreign_key_violation';
  end if;

  -- (2) La reserva, en una sentencia. Ver 0043.
  update public.fiscal_correlatives
     set last_minted = last_minted + 1,
         updated_at  = now()
   where organization_id    = p_organization_id
     and ambiente           = p_ambiente
     and dte_type           = p_dte_type
     and establishment_code = v_emisor.cod_estable
     and pos_code           = v_emisor.cod_punto_venta
     and seeded
  returning last_minted into v_numero;

  if v_numero is null then
    raise exception
      'La secuencia % / % / % del ambiente % no existe o no está sembrada. Sembrarla en Contabilidad → Correlativos antes de emitir.',
      p_dte_type, v_emisor.cod_estable, v_emisor.cod_punto_venta, p_ambiente
      using errcode = 'check_violation';
  end if;

  update public.fiscal_documents
     set correlative        = v_numero,
         establishment_code = v_emisor.cod_estable,
         pos_code           = v_emisor.cod_punto_venta,
         numero_control     = 'DTE-' || p_dte_type || '-' ||
                              v_emisor.cod_estable || v_emisor.cod_punto_venta || '-' ||
                              lpad(v_numero::text, 15, '0'),
         codigo_generacion  = upper(gen_random_uuid()::text),
         updated_at         = now()
   where id = v_doc.id
  returning * into v_doc;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload, actor)
  values
    (p_organization_id, v_doc.id, 'CORRELATIVE_RESERVED',
     jsonb_build_object('ambiente', p_ambiente, 'dte_type', p_dte_type,
                        'correlative', v_numero, 'numero_control', v_doc.numero_control),
     p_actor),
    (p_organization_id, v_doc.id, 'DTE_CREATED',
     jsonb_build_object('idempotency_key', p_idempotency_key), p_actor);

  return v_doc;
end;
$$;

comment on function public.fiscal_open_document(text, uuid, uuid, text, text, uuid, uuid, text) is
  'Reserva el correlativo del ambiente indicado y crea el documento, en una sola operación atómica e idempotente por la llave.';


-- ─────────────────────────────────────────────
-- 4. INVALIDACIONES
-- ─────────────────────────────────────────────

create table if not exists public.fiscal_invalidations (
  id                      uuid        primary key default gen_random_uuid(),
  idempotency_key         text        not null unique,
  organization_id         uuid        not null references public.organizations(id) on delete restrict,
  branch_id               uuid        references public.branches(id) on delete restrict,
  fiscal_document_id      uuid        not null references public.fiscal_documents(id) on delete restrict,
  -- El documento que reemplaza al invalidado (tipos 1 y 3). Null en el tipo 2.
  replacement_document_id uuid        references public.fiscal_documents(id) on delete restrict,
  ambiente                text        not null,
  -- El del EVENTO, no el del documento invalidado.
  codigo_generacion       text        not null unique,
  tipo_anulacion          smallint    not null,
  motivo                  text,
  status                  text        not null default 'CREATED',
  json_original           jsonb,
  signed_jws              text,
  sello_recepcion         text,
  mh_response             jsonb,
  attempt_count           integer     not null default 0,
  last_error              text,
  created_by              text,
  created_at              timestamptz not null default now(),
  signed_at               timestamptz,
  accepted_at             timestamptz,
  rejected_at             timestamptz,
  updated_at              timestamptz not null default now(),

  constraint fiscal_invalidations_tipo_valido check (tipo_anulacion in (1, 2, 3)),
  constraint fiscal_invalidations_estado_valido check (status in (
    'CREATED', 'SIGNED', 'ACCEPTED', 'REJECTED', 'RETRY_PENDING')),
  constraint fiscal_invalidations_ambiente_valido check (ambiente in ('00', '01')),
  -- La regla del schema del MH (anulacion-schema-v2, allOf): el tipo 2 va sin
  -- reemplazo; el 1 y el 3 lo exigen.
  constraint fiscal_invalidations_reemplazo check (
    (tipo_anulacion = 2 and replacement_document_id is null) or
    (tipo_anulacion in (1, 3) and replacement_document_id is not null)),
  constraint fiscal_invalidations_no_se_reemplaza_a_si_mismo check (
    replacement_document_id is null or replacement_document_id <> fiscal_document_id)
);

comment on table public.fiscal_invalidations is
  'Eventos de invalidación ante el MH (/fesv/anulardte). No consumen correlativo. Uno ACEPTADO deja el documento en INVALIDATED.';

-- Una sola invalidación viva por documento. Una rechazada no cuenta: se puede
-- corregir y volver a intentar.
create unique index if not exists fiscal_invalidations_una_viva_uidx
  on public.fiscal_invalidations (fiscal_document_id)
  where status <> 'REJECTED';

create index if not exists fiscal_invalidations_org_idx
  on public.fiscal_invalidations (organization_id, ambiente, created_at desc);


create or replace function public.fiscal_open_invalidation(
  p_idempotency_key         text,
  p_organization_id         uuid,
  p_document_id             uuid,
  p_tipo_anulacion          smallint,
  p_motivo                  text default null,
  p_replacement_document_id uuid default null,
  p_actor                   text default null
) returns public.fiscal_invalidations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv     public.fiscal_invalidations;
  v_doc     public.fiscal_documents;
  v_reemp   public.fiscal_documents;
begin
  -- Idempotente por la llave, igual que la apertura de documentos. Pero la
  -- llave repetida tiene que ser la MISMA solicitud: si apunta a otro
  -- documento, devolver la existente haría firmar un evento sobre un
  -- documento y marcar como invalidado a otro.
  select * into v_inv from public.fiscal_invalidations where idempotency_key = p_idempotency_key;
  if v_inv.id is not null then
    if v_inv.organization_id is distinct from p_organization_id
       or v_inv.fiscal_document_id is distinct from p_document_id
       or v_inv.tipo_anulacion is distinct from p_tipo_anulacion
       or v_inv.replacement_document_id is distinct from p_replacement_document_id then
      raise exception 'La llave % ya pertenece a otra invalidación. No se reutiliza.', p_idempotency_key
        using errcode = 'unique_violation';
    end if;
    return v_inv;
  end if;

  -- Bloquea el documento: dos invalidaciones simultáneas del mismo se
  -- serializan acá y la segunda choca con el índice de «una viva».
  select * into v_doc from public.fiscal_documents where id = p_document_id for update;

  if v_doc.id is null or v_doc.organization_id <> p_organization_id then
    raise exception 'No existe el documento fiscal %', p_document_id
      using errcode = 'no_data_found';
  end if;
  if v_doc.status = 'INVALIDATED' then
    raise exception 'El documento % ya está invalidado ante Hacienda.', v_doc.numero_control
      using errcode = 'check_violation';
  end if;
  -- Sin sello no hay nada que invalidar: para Hacienda ese documento no existe.
  if v_doc.status <> 'ACCEPTED' or v_doc.sello_recepcion is null then
    raise exception 'Sólo se invalida un documento aceptado y sellado por Hacienda. % está en %.',
      coalesce(v_doc.numero_control, v_doc.id::text), v_doc.status
      using errcode = 'check_violation';
  end if;

  if p_replacement_document_id is not null then
    select * into v_reemp from public.fiscal_documents where id = p_replacement_document_id;
    if v_reemp.id is null or v_reemp.organization_id <> p_organization_id then
      raise exception 'No existe el documento de reemplazo %', p_replacement_document_id
        using errcode = 'no_data_found';
    end if;
    if v_reemp.status <> 'ACCEPTED' then
      raise exception 'El documento de reemplazo % todavía no está aceptado por Hacienda (%). Emitirlo primero.',
        coalesce(v_reemp.numero_control, v_reemp.id::text), v_reemp.status
        using errcode = 'check_violation';
    end if;
    if v_reemp.dte_type <> v_doc.dte_type or v_reemp.ambiente <> v_doc.ambiente then
      raise exception 'El reemplazo tiene que ser del mismo tipo y ambiente que el documento invalidado.'
        using errcode = 'check_violation';
    end if;
  end if;

  begin
    insert into public.fiscal_invalidations (
      idempotency_key, organization_id, branch_id, fiscal_document_id,
      replacement_document_id, ambiente, codigo_generacion, tipo_anulacion,
      motivo, created_by
    ) values (
      p_idempotency_key, p_organization_id, v_doc.branch_id, v_doc.id,
      p_replacement_document_id, v_doc.ambiente, upper(gen_random_uuid()::text),
      p_tipo_anulacion, p_motivo, p_actor
    )
    returning * into v_inv;
  exception when unique_violation then
    -- O ganó otra transacción con la misma llave, o ya hay una invalidación
    -- viva para este documento.
    select * into v_inv from public.fiscal_invalidations where idempotency_key = p_idempotency_key;
    if v_inv.id is not null and v_inv.fiscal_document_id = p_document_id
       and v_inv.organization_id = p_organization_id then
      return v_inv;
    end if;
    raise exception 'Ya hay una invalidación en curso para %. Revisarla en el historial antes de abrir otra.',
      v_doc.numero_control
      using errcode = 'unique_violation';
  end;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, fiscal_invalidation_id, event_type, payload, actor)
  values (p_organization_id, v_doc.id, v_inv.id, 'INVALIDATION_CREATED',
          jsonb_build_object('tipo_anulacion', p_tipo_anulacion,
                             'reemplazo', p_replacement_document_id), p_actor);

  return v_inv;
end;
$$;


create or replace function public.fiscal_invalidation_mark_signed(
  p_invalidation_id uuid,
  p_signed_jws      text,
  p_json_original   jsonb
) returns public.fiscal_invalidations
language plpgsql
security definer
set search_path = public
as $$
declare v_inv public.fiscal_invalidations;
begin
  -- Sólo la PRIMERA firma queda. Si dos solicitudes con la misma llave
  -- firmaron a la vez —cada una con su hora—, la segunda recibe la fila con
  -- el JWS de la primera y transmite ése: un evento, una firma.
  update public.fiscal_invalidations
     set status = 'SIGNED', signed_jws = p_signed_jws, json_original = p_json_original,
         signed_at = now(), updated_at = now()
   where id = p_invalidation_id and signed_jws is null
     and status not in ('ACCEPTED', 'REJECTED')
  returning * into v_inv;

  if v_inv.id is null then
    select * into v_inv from public.fiscal_invalidations where id = p_invalidation_id;
    if v_inv.id is null then raise exception 'No existe la invalidación %', p_invalidation_id; end if;
    return v_inv;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, fiscal_invalidation_id, event_type, payload)
  values (v_inv.organization_id, v_inv.fiscal_document_id, v_inv.id, 'INVALIDATION_SIGNED', '{}'::jsonb);
  return v_inv;
end;
$$;


-- Aceptada: el evento queda sellado Y el documento pasa a INVALIDATED, en la
-- misma transacción. Si fueran dos pasos, un corte entre los dos dejaría un
-- documento invalidado ante Hacienda que acá sigue figurando como vigente.
create or replace function public.fiscal_invalidation_mark_accepted(
  p_invalidation_id uuid,
  p_sello           text,
  p_mh_response     jsonb
) returns public.fiscal_invalidations
language plpgsql
security definer
set search_path = public
as $$
declare v_inv public.fiscal_invalidations;
begin
  update public.fiscal_invalidations
     set status = 'ACCEPTED', sello_recepcion = p_sello, mh_response = p_mh_response,
         accepted_at = now(), updated_at = now()
   where id = p_invalidation_id
  returning * into v_inv;
  if v_inv.id is null then raise exception 'No existe la invalidación %', p_invalidation_id; end if;

  update public.fiscal_documents
     set status = 'INVALIDATED', invalidated_at = now(), updated_at = now()
   where id = v_inv.fiscal_document_id;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, fiscal_invalidation_id, event_type, payload)
  values
    (v_inv.organization_id, v_inv.fiscal_document_id, v_inv.id, 'INVALIDATION_ACCEPTED',
     jsonb_build_object('sello', p_sello)),
    (v_inv.organization_id, v_inv.fiscal_document_id, v_inv.id, 'DTE_INVALIDATED',
     jsonb_build_object('invalidacion', v_inv.codigo_generacion));
  return v_inv;
end;
$$;


create or replace function public.fiscal_invalidation_mark_rejected(
  p_invalidation_id uuid,
  p_mh_response     jsonb,
  p_error           text default null
) returns public.fiscal_invalidations
language plpgsql
security definer
set search_path = public
as $$
declare v_inv public.fiscal_invalidations;
begin
  -- Una aceptada no se vuelve rechazada: el documento ya está invalidado
  -- ante Hacienda, y marcarla rechazada permitiría abrir otra.
  update public.fiscal_invalidations
     set status = 'REJECTED', mh_response = p_mh_response, last_error = p_error,
         rejected_at = now(), updated_at = now()
   where id = p_invalidation_id and status <> 'ACCEPTED'
  returning * into v_inv;
  if v_inv.id is null then
    select * into v_inv from public.fiscal_invalidations where id = p_invalidation_id;
    if v_inv.id is null then raise exception 'No existe la invalidación %', p_invalidation_id; end if;
    return v_inv;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, fiscal_invalidation_id, event_type, payload)
  values (v_inv.organization_id, v_inv.fiscal_document_id, v_inv.id, 'INVALIDATION_REJECTED',
          jsonb_build_object('error', p_error));
  return v_inv;
end;
$$;


create or replace function public.fiscal_invalidation_mark_retry(
  p_invalidation_id uuid,
  p_error           text default null
) returns public.fiscal_invalidations
language plpgsql
security definer
set search_path = public
as $$
declare v_inv public.fiscal_invalidations;
begin
  update public.fiscal_invalidations
     set status = 'RETRY_PENDING', attempt_count = attempt_count + 1,
         last_error = p_error, updated_at = now()
   where id = p_invalidation_id and status not in ('ACCEPTED', 'REJECTED')
  returning * into v_inv;
  if v_inv.id is null then
    select * into v_inv from public.fiscal_invalidations where id = p_invalidation_id;
    if v_inv.id is null then raise exception 'No existe la invalidación %', p_invalidation_id; end if;
    return v_inv;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, fiscal_invalidation_id, event_type, payload)
  values (v_inv.organization_id, v_inv.fiscal_document_id, v_inv.id, 'INVALIDATION_RETRY',
          jsonb_build_object('attempt_count', v_inv.attempt_count, 'error', p_error));
  return v_inv;
end;
$$;


-- ─────────────────────────────────────────────
-- 4b. LAS MARCAS DE 0043, CON GUARDAS DE ESTADO
-- ─────────────────────────────────────────────
-- En 0043 cada marca pisaba lo que hubiera. Con dos solicitudes simultáneas
-- de la misma llave eso rompe dos cosas:
--   - las dos firman, cada una con su hora, y la segunda pisa el JWS de la
--     primera: un codigoGeneracion con dos documentos distintos;
--   - la que llega segunda a Hacienda recibe «ya existe», y su
--     fiscal_mark_rejected convierte en RECHAZADO un documento ACEPTADO.
-- Ahora la primera firma gana y un estado final no retrocede. Cuando la marca
-- no aplica, devuelve la fila tal cual está: quien llamó ve el estado real.

create or replace function public.fiscal_mark_signed(
  p_document_id   uuid,
  p_signed_jws    text,
  p_json_original jsonb
) returns public.fiscal_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.fiscal_documents;
begin
  update public.fiscal_documents
     set status        = 'SIGNED',
         signed_jws    = p_signed_jws,
         json_original = p_json_original,
         signed_at     = now(),
         updated_at    = now()
   where id = p_document_id and signed_jws is null
     and status not in ('ACCEPTED', 'REJECTED', 'INVALIDATED')
  returning * into v_doc;

  if v_doc.id is null then
    select * into v_doc from public.fiscal_documents where id = p_document_id;
    if v_doc.id is null then raise exception 'No existe el documento fiscal %', p_document_id; end if;
    return v_doc;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload)
  values (v_doc.organization_id, v_doc.id, 'DTE_SIGNED',
          jsonb_build_object('correlative', v_doc.correlative));
  return v_doc;
end;
$$;

create or replace function public.fiscal_mark_accepted(
  p_document_id     uuid,
  p_sello           text,
  p_mh_response     jsonb,
  p_signed_jws      text default null,
  p_json_original   jsonb default null
) returns public.fiscal_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.fiscal_documents;
begin
  -- Un documento invalidado no vuelve a «aceptado».
  update public.fiscal_documents
     set status          = 'ACCEPTED',
         sello_recepcion = p_sello,
         mh_response     = p_mh_response,
         signed_jws      = coalesce(signed_jws, p_signed_jws),
         json_original   = coalesce(json_original, p_json_original),
         accepted_at     = coalesce(accepted_at, now()),
         submitted_at    = coalesce(submitted_at, now()),
         updated_at      = now()
   where id = p_document_id and status <> 'INVALIDATED'
  returning * into v_doc;

  if v_doc.id is null then
    select * into v_doc from public.fiscal_documents where id = p_document_id;
    if v_doc.id is null then raise exception 'No existe el documento fiscal %', p_document_id; end if;
    return v_doc;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload)
  values
    (v_doc.organization_id, v_doc.id, 'DTE_ACCEPTED',
     jsonb_build_object('correlative', v_doc.correlative, 'sello', p_sello)),
    (v_doc.organization_id, v_doc.id, 'CORRELATIVE_CONSUMED',
     jsonb_build_object('correlative', v_doc.correlative));
  return v_doc;
end;
$$;

create or replace function public.fiscal_mark_rejected(
  p_document_id  uuid,
  p_mh_response  jsonb,
  p_error        text default null
) returns public.fiscal_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.fiscal_documents;
begin
  update public.fiscal_documents
     set status      = 'REJECTED',
         mh_response = p_mh_response,
         last_error  = p_error,
         rejected_at = now(),
         updated_at  = now()
   where id = p_document_id and status not in ('ACCEPTED', 'INVALIDATED')
  returning * into v_doc;

  if v_doc.id is null then
    select * into v_doc from public.fiscal_documents where id = p_document_id;
    if v_doc.id is null then raise exception 'No existe el documento fiscal %', p_document_id; end if;
    return v_doc;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload)
  values
    (v_doc.organization_id, v_doc.id, 'DTE_REJECTED',
     jsonb_build_object('correlative', v_doc.correlative, 'error', p_error,
                        'numero_control', v_doc.numero_control));
  return v_doc;
end;
$$;

create or replace function public.fiscal_mark_retry(
  p_document_id uuid,
  p_error       text default null
) returns public.fiscal_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.fiscal_documents;
begin
  update public.fiscal_documents
     set status        = 'RETRY_PENDING',
         attempt_count = attempt_count + 1,
         last_error    = p_error,
         submitted_at  = coalesce(submitted_at, now()),
         updated_at    = now()
   where id = p_document_id and status not in ('ACCEPTED', 'REJECTED', 'INVALIDATED')
  returning * into v_doc;

  if v_doc.id is null then
    select * into v_doc from public.fiscal_documents where id = p_document_id;
    if v_doc.id is null then raise exception 'No existe el documento fiscal %', p_document_id; end if;
    return v_doc;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload)
  values (v_doc.organization_id, v_doc.id, 'DTE_RETRY',
          jsonb_build_object('attempt_count', v_doc.attempt_count, 'error', p_error));
  return v_doc;
end;
$$;


-- ─────────────────────────────────────────────
-- 5. RPC PARA LA APP
-- ─────────────────────────────────────────────

-- El Worker fiscal la llama CON EL JWT DEL USUARIO, no con el service role.
-- PostgREST valida el token; esta función dice quién es, de qué organización
-- y si tiene el permiso. Así el navegador nunca ve la FISCAL_API_KEY ni el
-- service role, y la decisión de permisos la toma la base, no el Worker.
create or replace function public.fiscal_app_context(p_permission text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org   uuid;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sin sesión' using errcode = '28000';
  end if;
  if not public.has_permission(p_permission) then
    raise exception 'No autorizado: se requiere el permiso %', p_permission
      using errcode = '42501';
  end if;
  v_org := public.get_my_organization_id();
  if v_org is null then
    raise exception 'El usuario no pertenece a ninguna organización' using errcode = '42501';
  end if;
  select email into v_email from auth.users where id = auth.uid();
  return jsonb_build_object('user_id', auth.uid(), 'organization_id', v_org,
                            'email', v_email);
end;
$$;

comment on function public.fiscal_app_context(text) is
  'Para el Worker fiscal: identidad, organización y permiso del usuario del JWT. Lanza 42501 sin permiso.';


-- Sembrar desde la pantalla de Contabilidad. Los códigos de establecimiento y
-- punto de venta salen de fiscal_issuer_config de la sucursal, nunca del
-- navegador: son los mismos con los que fiscal_open_document va a numerar, y
-- sembrar con otros dejaría una secuencia que nadie usa.
create or replace function public.fiscal_seed_correlative_app(
  p_branch_id   uuid,
  p_ambiente    text,
  p_dte_type    text,
  p_last_issued bigint
) returns public.fiscal_correlatives
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid := public.get_my_organization_id();
  v_emisor public.fiscal_issuer_config;
  v_actor  text;
begin
  if not public.has_permission('fiscal.seed') then
    raise exception 'No autorizado: se requiere el permiso fiscal.seed' using errcode = '42501';
  end if;
  if p_dte_type not in ('01', '03', '05', '14') then
    raise exception 'Tipo de DTE no soportado: %', p_dte_type using errcode = 'check_violation';
  end if;
  if p_ambiente not in ('00', '01') then
    raise exception 'Ambiente inválido: %', p_ambiente using errcode = 'check_violation';
  end if;

  select * into v_emisor
    from public.fiscal_issuer_config
   where branch_id = p_branch_id and organization_id = v_org and activo;
  if v_emisor.id is null then
    raise exception 'La sucursal no tiene configuración fiscal activa. Cargar fiscal_issuer_config primero.'
      using errcode = 'foreign_key_violation';
  end if;

  select coalesce(email, auth.uid()::text) into v_actor from auth.users where id = auth.uid();

  return public.fiscal_seed_correlative(
    v_org, p_ambiente, p_dte_type, v_emisor.cod_estable, v_emisor.cod_punto_venta,
    p_last_issued, v_actor);
end;
$$;

comment on function public.fiscal_seed_correlative_app(uuid, text, text, bigint) is
  'Siembra una secuencia desde la app. Pide fiscal.seed; los códigos salen de la configuración fiscal de la sucursal.';


-- ─────────────────────────────────────────────
-- 6. HISTORIAL
-- ─────────────────────────────────────────────
-- security_invoker: la vista se lee con los permisos de QUIEN consulta, así
-- que la RLS de fiscal_documents aplica. Sin esto, una vista creada por el
-- dueño de las tablas se salta la RLS y muestra todas las organizaciones.

create or replace view public.v_fiscal_documents
with (security_invoker = true) as
select
  d.id,
  d.organization_id,
  d.branch_id,
  d.ambiente,
  d.dte_type,
  d.status,
  d.correlative,
  d.numero_control,
  d.codigo_generacion,
  d.sello_recepcion,
  d.invoice_id,
  d.customer_id,
  d.attempt_count,
  d.last_error,
  d.created_at,
  d.accepted_at,
  d.rejected_at,
  d.invalidated_at,
  (d.signed_jws is not null) as firmado,
  d.json_original -> 'identificacion' ->> 'fecEmi' as fecha_emision,
  coalesce(d.json_original -> 'receptor' ->> 'nombre',
           d.json_original -> 'sujetoExcluido' ->> 'nombre') as contraparte_nombre,
  coalesce(d.json_original -> 'receptor' ->> 'nit',
           d.json_original -> 'receptor' ->> 'numDocumento',
           d.json_original -> 'sujetoExcluido' ->> 'numDocumento') as contraparte_documento,
  coalesce((d.json_original -> 'resumen' ->> 'totalPagar')::numeric,
           (d.json_original -> 'resumen' ->> 'montoTotalOperacion')::numeric) as monto_total,
  d.json_original -> 'documentoRelacionado' as documentos_relacionados,
  (select a.actor from public.fiscal_audit_events a
    where a.fiscal_document_id = d.id and a.event_type = 'DTE_CREATED'
    order by a.created_at limit 1) as creado_por
from public.fiscal_documents d
where d.correlative is not null;

comment on view public.v_fiscal_documents is
  'Historial de documentos fiscales para Contabilidad. Lee con los permisos de quien consulta (security_invoker).';

-- La vista de 0043 tenía el mismo problema: se corrige acá, y se le agrega el
-- ambiente (al final: `create or replace view` sólo admite columnas nuevas
-- después de las existentes). Sin él, la prueba 5 y el documento real 5 se
-- verían iguales.
create or replace view public.v_fiscal_correlative_ledger
with (security_invoker = true) as
select
  d.organization_id,
  d.branch_id,
  d.dte_type,
  d.establishment_code,
  d.pos_code,
  d.correlative,
  d.numero_control,
  d.codigo_generacion,
  d.status,
  d.sello_recepcion,
  d.invoice_id,
  d.attempt_count,
  d.last_error,
  (d.mh_response is not null) as tiene_respuesta_mh,
  d.created_at,
  d.accepted_at,
  d.rejected_at,
  d.ambiente
from public.fiscal_documents d
where d.correlative is not null;


-- ─────────────────────────────────────────────
-- 7. RLS Y GRANTS
-- ─────────────────────────────────────────────

alter table public.fiscal_invalidations enable row level security;

drop policy if exists "fiscal_invalidations_select" on public.fiscal_invalidations;
create policy "fiscal_invalidations_select"
  on public.fiscal_invalidations for select
  using (organization_id = public.get_my_organization_id());

-- Las de escritura sólo para el Worker (service role).
--
-- `anon` va EXPLÍCITO. En Supabase los privilegios por defecto le dan EXECUTE
-- a anon sobre toda función nueva de `public`, y `from public` no se lo
-- quita. 0043 lo omitió: cualquiera con la anon key —que viaja en el bundle
-- de la app— podía sembrar la secuencia de producción en 999999999999999,
-- y como sólo sube, no tendría arreglo. Se corrige también para las de 0043.
revoke all on function public.fiscal_seed_correlative(uuid, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.fiscal_open_document(text, uuid, uuid, text, text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fiscal_open_invalidation(text, uuid, uuid, smallint, text, uuid, text) from public, anon, authenticated;
revoke all on function public.fiscal_invalidation_mark_signed(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.fiscal_invalidation_mark_accepted(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.fiscal_invalidation_mark_rejected(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.fiscal_invalidation_mark_retry(uuid, text) from public, anon, authenticated;
revoke all on function public.fiscal_mark_signed(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.fiscal_mark_accepted(uuid, text, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.fiscal_mark_rejected(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.fiscal_mark_retry(uuid, text) from public, anon, authenticated;

grant execute on function public.fiscal_seed_correlative(uuid, text, text, text, text, bigint, text) to service_role;
grant execute on function public.fiscal_open_document(text, uuid, uuid, text, text, uuid, uuid, text) to service_role;
grant execute on function public.fiscal_open_invalidation(text, uuid, uuid, smallint, text, uuid, text) to service_role;
grant execute on function public.fiscal_invalidation_mark_signed(uuid, text, jsonb) to service_role;
grant execute on function public.fiscal_invalidation_mark_accepted(uuid, text, jsonb) to service_role;
grant execute on function public.fiscal_invalidation_mark_rejected(uuid, jsonb, text) to service_role;
grant execute on function public.fiscal_invalidation_mark_retry(uuid, text) to service_role;
grant execute on function public.fiscal_mark_signed(uuid, text, jsonb) to service_role;
grant execute on function public.fiscal_mark_accepted(uuid, text, jsonb, text, jsonb) to service_role;
grant execute on function public.fiscal_mark_rejected(uuid, jsonb, text) to service_role;
grant execute on function public.fiscal_mark_retry(uuid, text) to service_role;

-- Las de la app: cada una verifica su permiso adentro. Sin sesión, nada.
revoke all on function public.fiscal_app_context(text) from public, anon;
revoke all on function public.fiscal_seed_correlative_app(uuid, text, text, bigint) from public, anon;
grant execute on function public.fiscal_app_context(text) to authenticated;
grant execute on function public.fiscal_seed_correlative_app(uuid, text, text, bigint) to authenticated;

grant select on public.v_fiscal_documents to authenticated, service_role;
grant select on public.fiscal_invalidations to authenticated;
revoke all on public.v_fiscal_documents from anon;
revoke all on public.v_fiscal_correlative_ledger from anon;
revoke all on public.fiscal_invalidations from anon;


-- ─────────────────────────────────────────────
-- 8. PERMISOS
-- ─────────────────────────────────────────────

insert into public.permissions (code, module, description) values
  ('screens.accounting', 'screens', 'Pantalla: Contabilidad'),
  ('fiscal.issue',       'fiscal',  'Emitir Notas de Crédito y Sujetos Excluidos, e invalidar documentos ante Hacienda'),
  ('fiscal.seed',        'fiscal',  'Sembrar los correlativos fiscales')
on conflict (code) do nothing;

-- Super Admin y Administrador: todo. Sembrar define la numeración ante
-- Hacienda y no se deshace, así que queda sólo en estos dos roles.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r cross join public.permissions p
where r.id in ('00000000-0000-0000-0002-000000000001',
               '00000000-0000-0000-0002-000000000002')
  and p.code in ('screens.accounting', 'fiscal.issue', 'fiscal.seed')
on conflict do nothing;

-- Gerente: ve y emite, no siembra.
insert into public.role_permissions (role_id, permission_id)
select '00000000-0000-0000-0002-000000000003', p.id
from public.permissions p
where p.code in ('screens.accounting', 'fiscal.issue')
on conflict do nothing;
