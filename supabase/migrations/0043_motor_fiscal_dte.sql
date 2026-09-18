-- ============================================================
-- Migration: 0043_motor_fiscal_dte.sql
-- Description: Numeración fiscal, documentos e idempotencia del motor DTE.
--
--   CORSA emite sus propios Documentos Tributarios Electrónicos contra el
--   Ministerio de Hacienda desde un Worker de Cloudflare (repositorio
--   corsa-fiscal-api). Esta migración es el lado de la base: de dónde sale el
--   correlativo, dónde vive el documento y qué impide emitirlo dos veces.
--
-- LA REGLA QUE MANDA SOBRE TODAS
--   El correlativo se reserva UNA vez por documento, y ese número le pertenece
--   para siempre.
--
--   Si Hacienda tarda, si se cae el Internet, si el Worker da timeout, si la
--   cola reintenta, si el cajero refresca o vuelve a tocar Emitir: se recupera
--   EL MISMO documento y se reprocesa. Nunca se pide un correlativo nuevo, ni
--   un numeroControl nuevo, ni un codigoGeneracion nuevo. Por eso reservar y
--   crear el documento son la MISMA operación atómica (fiscal_open_document) y
--   no dos llamadas que alguien podría separar.
--
-- POR QUÉ LA RESERVA VIVE ACÁ Y NO EN EL WORKER
--   Un `select` que vuelve al Worker, suma uno y hace `update` deja que dos
--   Workers concurrentes lean el mismo valor. Los Workers además no tienen
--   estado compartido: hay miles de isolates y ninguno puede coordinar con
--   otro. La única serialización real es la fila bloqueada de Postgres.
--
-- SIN HUECOS: CÓMO, Y EN QUÉ SE APARTA DE ERP-PAAJ
--   La decisión tomada para CORSA es que un correlativo rechazado se
--   reutiliza, para que la numeración quede continua.
--
--   ERP-PAAJ *parece* hacer eso, pero no lo garantiza. Su reserva calcula
--   `max(ultimo_consumido, max(reservados)) + 1`, así que sólo recupera el
--   número devuelto si era el más alto. Con dos cajas emitiendo a la vez:
--
--       caja A reserva 126 · caja B reserva 127
--       MH rechaza A (devuelve 126) · MH acepta B (consume 127)
--       siguiente venta -> 128,  y el 126 queda como HUECO
--
--   Acá se lleva una lista explícita de números liberados y la reserva toma
--   primero el menor de esa lista. Un número entregado termina consumido o
--   vuelve a la bolsa; no se pierde. Eso sí cumple «sin huecos», al costo de
--   que los documentos pueden emitirse en distinto orden que su numeración
--   —el 126 puede salir después del 130— lo cual queda registrado con sus
--   marcas de tiempo en fiscal_documents.
--
-- ALCANCE DE LA SECUENCIA
--   Por (organización, tipo de DTE, establecimiento, punto de venta). La
--   organización entra porque los códigos de establecimiento los asigna
--   Hacienda POR NIT: dos organizaciones distintas son dos contribuyentes
--   distintos y no pueden compartir una secuencia. ERP-PAAJ indexa sólo por
--   tipo de DTE porque es un único punto de venta; CORSA tiene sucursales.
-- ============================================================


-- ─────────────────────────────────────────────
-- CONFIGURACIÓN FISCAL DEL EMISOR
--
-- Los datos que van dentro del DTE, por sucursal. NO hay secretos acá: la
-- llave privada del certificado y la contraseña de Hacienda viven en los
-- secretos de Cloudflare, cifrados, y no tocan Postgres. Esta tabla sólo
-- guarda lo que igual viaja dentro del documento y es público en la factura.
-- ─────────────────────────────────────────────
create table if not exists public.fiscal_issuer_config (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null references public.organizations(id) on delete restrict,
  branch_id            uuid        not null references public.branches(id) on delete restrict,

  -- Identificación ante Hacienda. NIT de 14 dígitos SIN guiones: el schema
  -- del MH rechaza el formato con guiones que usa la gente.
  nit                  text        not null,
  nrc                  text        not null,
  nombre               text        not null,
  nombre_comercial     text,

  -- CAT-019 actividad económica · CAT-011 tipo de establecimiento.
  cod_actividad        text        not null,
  desc_actividad       text        not null,
  tipo_establecimiento text        not null,

  -- CAT-012 departamento · CAT-013 municipio.
  departamento         text        not null,
  municipio            text        not null,
  complemento          text        not null,
  telefono             text,
  correo               text        not null,

  -- Los que define el contribuyente; entran al numeroControl.
  cod_estable          text        not null,
  cod_punto_venta      text        not null,
  -- Los que asigna Hacienda en el portal. Si no coinciden con lo dado de alta
  -- para el NIT, el MH rechaza y el mensaje no explica por qué.
  cod_estable_mh       text,
  cod_punto_venta_mh   text,

  activo               boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (branch_id)
);

comment on table public.fiscal_issuer_config is
  'Datos del emisor que viajan dentro del DTE, por sucursal. Sin secretos: el certificado y las credenciales del MH viven en los secretos de Cloudflare.';

alter table public.fiscal_issuer_config
  drop constraint if exists fiscal_issuer_nit_formato,
  add  constraint fiscal_issuer_nit_formato
    check (nit ~ '^[0-9]{14}$');

alter table public.fiscal_issuer_config
  drop constraint if exists fiscal_issuer_codigos_formato,
  add  constraint fiscal_issuer_codigos_formato
    check (
      cod_estable          ~ '^[A-Z0-9]{4}$' and
      cod_punto_venta      ~ '^[A-Z0-9]{4}$' and
      (cod_estable_mh     is null or cod_estable_mh     ~ '^[A-Z0-9]{4}$') and
      (cod_punto_venta_mh is null or cod_punto_venta_mh ~ '^[A-Z0-9]{4}$')
    );


-- ─────────────────────────────────────────────
-- CORRELATIVOS
-- ─────────────────────────────────────────────
create table if not exists public.fiscal_correlatives (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete restrict,
  dte_type            text        not null,
  establishment_code  text        not null,
  pos_code            text        not null,

  -- Sembrado a mano antes de operar. Sin esto no se puede reservar: arrancar
  -- en 1 cuando el contribuyente ya emitió 3.000 documentos duplicaría
  -- numeración ante Hacienda, y eso no se arregla después.
  seeded              boolean     not null default false,
  seeded_at           timestamptz,
  seeded_by           text,

  -- El número más alto entregado alguna vez. NUNCA decrece.
  last_minted         bigint      not null default 0,
  -- Entregados y todavía en vuelo hacia Hacienda.
  reserved            bigint[]    not null default '{}',
  -- Entregados, rechazados y disponibles para reusar. La reserva toma de acá
  -- primero, y por eso la numeración no deja huecos.
  released            bigint[]    not null default '{}',

  updated_at          timestamptz not null default now(),

  unique (organization_id, dte_type, establishment_code, pos_code)
);

comment on table public.fiscal_correlatives is
  'Secuencia fiscal por organización, tipo de DTE, establecimiento y punto de venta. La reserva ocurre entera en Postgres: ver fiscal_open_document.';
comment on column public.fiscal_correlatives.released is
  'Números entregados y rechazados, disponibles para reusar. La reserva toma el menor de acá antes de acuñar uno nuevo — así la numeración no deja huecos.';

alter table public.fiscal_correlatives
  drop constraint if exists fiscal_correlatives_tipo_valido,
  add  constraint fiscal_correlatives_tipo_valido
    check (dte_type in ('01', '03'));

alter table public.fiscal_correlatives
  drop constraint if exists fiscal_correlatives_codigos_formato,
  add  constraint fiscal_correlatives_codigos_formato
    check (establishment_code ~ '^[A-Z0-9]{4}$' and pos_code ~ '^[A-Z0-9]{4}$');

-- El correlativo cabe en 15 dígitos dentro del numeroControl.
alter table public.fiscal_correlatives
  drop constraint if exists fiscal_correlatives_rango,
  add  constraint fiscal_correlatives_rango
    check (last_minted >= 0 and last_minted <= 999999999999999);


-- ─────────────────────────────────────────────
-- DOCUMENTOS FISCALES
--
-- 0022 creó una tabla placeholder, atada uno a uno con `invoices` y sin nada
-- de lo que un DTE necesita. Nunca se pobló —FiscalProvider lanzaba error si
-- alguien lo llamaba— así que se reestructura en lugar de arrastrar la forma
-- vieja.
-- ─────────────────────────────────────────────
alter table public.fiscal_documents
  -- La llave de idempotencia: 'SALE:<invoice_id>:DTE:<tipo>'. Es lo que hace
  -- que un doble clic no pueda producir dos documentos, y no el cuidado de
  -- quien escribe el frontend.
  add column if not exists idempotency_key   text,
  add column if not exists organization_id   uuid references public.organizations(id) on delete restrict,
  add column if not exists branch_id         uuid references public.branches(id) on delete restrict,
  add column if not exists customer_id       uuid references public.customers(id) on delete set null,
  add column if not exists dte_type          text,
  add column if not exists correlative       bigint,
  add column if not exists numero_control    text,
  add column if not exists codigo_generacion text,
  add column if not exists establishment_code text,
  add column if not exists pos_code          text,
  add column if not exists json_original     jsonb,
  add column if not exists signed_jws        text,
  add column if not exists sello_recepcion   text,
  add column if not exists mh_response       jsonb,
  add column if not exists attempt_count     integer not null default 0,
  add column if not exists last_error        text,
  add column if not exists signed_at         timestamptz,
  add column if not exists submitted_at      timestamptz,
  add column if not exists accepted_at       timestamptz,
  add column if not exists rejected_at       timestamptz,
  add column if not exists updated_at        timestamptz not null default now();

-- `invoice_id` deja de ser obligatorio y único: un mismo comprobante puede
-- llegar a tener más de un documento fiscal a lo largo de su vida (una factura
-- y, más adelante, su invalidación o una nota de crédito).
alter table public.fiscal_documents alter column invoice_id drop not null;
alter table public.fiscal_documents drop constraint if exists fiscal_documents_invoice_id_key;

-- Estados del ciclo de vida. El de 0022 sólo conocía cinco y ninguno servía
-- para «el MH no contestó, hay que reintentar ESTE mismo».
alter table public.fiscal_documents drop constraint if exists fiscal_documents_status_check;
alter table public.fiscal_documents
  alter column status set default 'CREATED';
alter table public.fiscal_documents
  add constraint fiscal_documents_status_check
    check (status in (
      'CREATED',        -- correlativo reservado, documento aún sin construir
      'VALIDATED',      -- pasa el schema oficial del MH
      'SIGNED',         -- JWS RS512 generado
      'SUBMITTED',      -- enviado, sin respuesta concluyente
      'ACCEPTED',       -- PROCESADO y con sello
      'REJECTED',       -- el MH lo leyó y dijo que no: hay que corregirlo
      'RETRY_PENDING',  -- el MH no contestó: se reintenta EL MISMO
      'CONTINGENCY',    -- emitido en contingencia, pendiente de transmitir
      'INVALIDATED'     -- anulado ante Hacienda con evento firmado
    ));

-- Las tres cosas que no pueden repetirse nunca.
--
-- El de idempotencia va SIN cláusula `where`, a diferencia de los otros dos.
-- `on conflict (idempotency_key)` no puede inferir un índice parcial salvo que
-- la sentencia repita el predicado, y esa sutileza es fácil de romper sin
-- notarlo: bastaría que alguien reescriba el insert para que la idempotencia
-- deje de funcionar en silencio. Postgres admite varios NULL en un índice
-- único, así que el índice completo cubre lo mismo sin esa trampa.
create unique index if not exists fiscal_documents_idempotency_key_uidx
  on public.fiscal_documents (idempotency_key);
create unique index if not exists fiscal_documents_codigo_generacion_uidx
  on public.fiscal_documents (codigo_generacion) where codigo_generacion is not null;
-- El numeroControl es único entre los documentos VIVOS, y por eso el índice
-- excluye los rechazados.
--
-- No es una concesión: es la consecuencia directa de haber elegido reutilizar
-- los correlativos rechazados. Si el 126 se rechaza y vuelve a la bolsa, el
-- siguiente documento lo toma y arma el MISMO numeroControl — un índice único
-- sin excepción lo bloquearía y la promesa de «sin huecos» sería imposible de
-- cumplir.
--
-- Fiscalmente es correcto: un documento rechazado nunca existió para Hacienda,
-- nunca recibió sello, y su numeroControl jamás fue emitido. Los que SÍ
-- existieron —incluidos los invalidados, que fueron sellados y después
-- anulados, y los que están en vuelo o esperando reintento— siguen bajo la
-- restricción, que es donde un duplicado sí sería un problema real ante el MH.
--
-- El rechazado conserva su numero_control en la fila: así
-- v_fiscal_correlative_ledger muestra que el 126 se intentó, se rechazó y se
-- reutilizó, en vez de que el número reaparezca sin explicación.
create unique index if not exists fiscal_documents_numero_control_uidx
  on public.fiscal_documents (numero_control)
  where numero_control is not null and status <> 'REJECTED';

create index if not exists fiscal_documents_pendientes_idx
  on public.fiscal_documents (status, updated_at)
  where status in ('CREATED', 'SIGNED', 'SUBMITTED', 'RETRY_PENDING', 'CONTINGENCY');
create index if not exists fiscal_documents_branch_idx
  on public.fiscal_documents (branch_id, created_at desc);

comment on column public.fiscal_documents.idempotency_key is
  'SALE:<invoice_id>:DTE:<tipo>. UNIQUE — es lo que impide que un doble clic genere dos documentos.';
comment on column public.fiscal_documents.correlative is
  'El número reservado. Pertenece a este documento para siempre: un reintento NO pide otro.';


-- ─────────────────────────────────────────────
-- AUDITORÍA
--
-- Una fila por transición. Nunca secretos: ni la llave, ni la contraseña de
-- Hacienda, ni el token. Un secreto que toca un log hay que darlo por
-- filtrado.
-- ─────────────────────────────────────────────
create table if not exists public.fiscal_audit_events (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        references public.organizations(id) on delete restrict,
  fiscal_document_id uuid        references public.fiscal_documents(id) on delete cascade,
  event_type         text        not null,
  payload            jsonb       not null default '{}'::jsonb,
  actor              text,
  created_at         timestamptz not null default now()
);

create index if not exists fiscal_audit_events_doc_idx
  on public.fiscal_audit_events (fiscal_document_id, created_at);

alter table public.fiscal_audit_events
  drop constraint if exists fiscal_audit_events_tipo_valido,
  add  constraint fiscal_audit_events_tipo_valido
    check (event_type in (
      'DTE_CREATED', 'DTE_VALIDATED', 'DTE_SIGNED', 'MH_AUTHENTICATED',
      'DTE_SUBMITTED', 'DTE_ACCEPTED', 'DTE_REJECTED', 'DTE_RETRY',
      'CORRELATIVE_RESERVED', 'CORRELATIVE_CONSUMED', 'CORRELATIVE_RELEASED',
      'CORRELATIVE_SEEDED', 'DTE_INVALIDATED'
    ));

comment on table public.fiscal_audit_events is
  'Traza de cada transición del ciclo de vida de un DTE. Nunca guarda secretos.';


-- ============================================================
-- SEMBRAR LA SECUENCIA
--
-- Antes de operar hay que decir en qué número va el contribuyente. NO se
-- asume que arranca en 1: si CORSA ya emitió documentos por otro medio,
-- empezar de cero duplicaría numeración ante Hacienda y eso no se arregla
-- después. Sube, nunca baja.
-- ============================================================
create or replace function public.fiscal_seed_correlative(
  p_organization_id    uuid,
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
  v_fila public.fiscal_correlatives;
begin
  if p_last_issued < 0 then
    raise exception 'El último correlativo emitido no puede ser negativo: %', p_last_issued
      using errcode = 'check_violation';
  end if;

  insert into public.fiscal_correlatives (
    organization_id, dte_type, establishment_code, pos_code,
    seeded, seeded_at, seeded_by, last_minted
  ) values (
    p_organization_id, p_dte_type, p_establishment_code, p_pos_code,
    true, now(), p_actor, p_last_issued
  )
  on conflict (organization_id, dte_type, establishment_code, pos_code) do update
    set seeded      = true,
        -- `greatest` y no asignación directa: sembrar dos veces con un número
        -- menor haría retroceder la secuencia y duplicar numeración.
        last_minted = greatest(public.fiscal_correlatives.last_minted, excluded.last_minted),
        seeded_at   = coalesce(public.fiscal_correlatives.seeded_at, excluded.seeded_at),
        seeded_by   = coalesce(public.fiscal_correlatives.seeded_by, excluded.seeded_by),
        updated_at  = now()
  returning * into v_fila;

  insert into public.fiscal_audit_events (organization_id, event_type, payload, actor)
  values (p_organization_id, 'CORRELATIVE_SEEDED',
          jsonb_build_object('dte_type', p_dte_type, 'establishment_code', p_establishment_code,
                             'pos_code', p_pos_code, 'last_minted', v_fila.last_minted),
          p_actor);

  return v_fila;
end;
$$;

comment on function public.fiscal_seed_correlative is
  'Fija el punto de arranque de una secuencia fiscal. Sube, nunca baja. Cada llamada queda en fiscal_audit_events.';


-- ============================================================
-- ABRIR UN DOCUMENTO — LA FUNCIÓN QUE SOSTIENE TODO
--
-- Reservar el correlativo y crear el documento son la MISMA operación. Si
-- fueran dos llamadas, entre una y otra cabría un timeout, y el reintento
-- pediría un correlativo nuevo para una venta que ya tenía uno.
--
-- Idempotente por construcción, no por cuidado:
--
--   1. Se intenta CLAVAR la llave de idempotencia con un insert
--      `on conflict do nothing`. Gana una sola transacción.
--   2. Si no ganamos, otra ya la tiene: su bloqueo nos hace esperar a que
--      confirme, y devolvemos SU documento. No se toca el correlativo.
--   3. Si ganamos, recién ahí se reserva el número y se completa la fila.
--
-- Un doble clic entra dos veces y sale con el mismo documento las dos.
-- ============================================================
create or replace function public.fiscal_open_document(
  p_idempotency_key text,
  p_organization_id uuid,
  p_branch_id       uuid,
  p_dte_type        text,
  p_invoice_id      uuid default null,
  p_customer_id     uuid default null,
  p_actor           text default null
) returns public.fiscal_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc          public.fiscal_documents;
  v_emisor       public.fiscal_issuer_config;
  v_corr         public.fiscal_correlatives;
  v_numero       bigint;
  v_reusado      boolean := false;
begin
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'fiscal_open_document necesita una llave de idempotencia'
      using errcode = 'null_value_not_allowed';
  end if;

  -- (1) Clavar la llave. Sólo una transacción se queda con la fila nueva.
  insert into public.fiscal_documents (
    idempotency_key, organization_id, branch_id, invoice_id, customer_id,
    dte_type, document_type, status
  ) values (
    p_idempotency_key, p_organization_id, p_branch_id, p_invoice_id, p_customer_id,
    p_dte_type, p_dte_type, 'CREATED'
  )
  on conflict (idempotency_key) do nothing
  returning * into v_doc;

  -- (2) No ganamos: ya existe. Se devuelve tal cual, con su correlativo
  --     original. Es exactamente el caso del doble clic y del reintento.
  if v_doc.id is null then
    select * into v_doc
      from public.fiscal_documents
     where idempotency_key = p_idempotency_key;
    return v_doc;
  end if;

  -- (3) Ganamos: ahora sí, el correlativo.
  select * into v_emisor
    from public.fiscal_issuer_config
   where branch_id = p_branch_id and activo;

  if v_emisor.id is null then
    raise exception 'La sucursal % no tiene configuración fiscal activa (fiscal_issuer_config)', p_branch_id
      using errcode = 'foreign_key_violation';
  end if;

  -- FOR UPDATE: acá se serializan las emisiones concurrentes. Es el único
  -- punto del sistema donde eso puede ocurrir de verdad.
  select * into v_corr
    from public.fiscal_correlatives
   where organization_id    = p_organization_id
     and dte_type           = p_dte_type
     and establishment_code = v_emisor.cod_estable
     and pos_code           = v_emisor.cod_punto_venta
   for update;

  if v_corr.id is null or not v_corr.seeded then
    raise exception
      'La secuencia % / % / % no está sembrada. Correr fiscal_seed_correlative antes de emitir.',
      p_dte_type, v_emisor.cod_estable, v_emisor.cod_punto_venta
      using errcode = 'check_violation';
  end if;

  -- Primero se reusa un número devuelto; recién si no hay, se acuña uno nuevo.
  -- Esto es lo que hace que la numeración no deje huecos.
  if array_length(v_corr.released, 1) is not null then
    select min(n) into v_numero from unnest(v_corr.released) as n;
    v_reusado := true;
    update public.fiscal_correlatives
       set released   = array_remove(released, v_numero),
           reserved   = array_append(reserved, v_numero),
           updated_at = now()
     where id = v_corr.id;
  else
    v_numero := v_corr.last_minted + 1;
    update public.fiscal_correlatives
       set last_minted = v_numero,
           reserved    = array_append(reserved, v_numero),
           updated_at  = now()
     where id = v_corr.id;
  end if;

  update public.fiscal_documents
     set correlative        = v_numero,
         establishment_code = v_emisor.cod_estable,
         pos_code           = v_emisor.cod_punto_venta,
         -- Formato del MH: DTE-NN-EEEEPPPP-NNNNNNNNNNNNNNN, 31 caracteres.
         numero_control     = 'DTE-' || p_dte_type || '-' ||
                              v_emisor.cod_estable || v_emisor.cod_punto_venta || '-' ||
                              lpad(v_numero::text, 15, '0'),
         -- UUID v4 en MAYÚSCULAS: el schema del MH exige [A-F0-9].
         codigo_generacion  = upper(gen_random_uuid()::text),
         updated_at         = now()
   where id = v_doc.id
  returning * into v_doc;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload, actor)
  values
    (p_organization_id, v_doc.id, 'CORRELATIVE_RESERVED',
     jsonb_build_object('dte_type', p_dte_type, 'correlative', v_numero,
                        'numero_control', v_doc.numero_control, 'reusado', v_reusado),
     p_actor),
    (p_organization_id, v_doc.id, 'DTE_CREATED',
     jsonb_build_object('idempotency_key', p_idempotency_key), p_actor);

  return v_doc;
end;
$$;

comment on function public.fiscal_open_document is
  'Reserva el correlativo y crea el documento en una sola operación atómica. Idempotente por la llave: un doble clic devuelve el MISMO documento, con su mismo correlativo.';


-- ============================================================
-- CERRAR EL DOCUMENTO
--
-- Tres desenlaces, y la diferencia entre los dos últimos es la que importa:
--
--   aceptado   el MH selló. El número queda consumido.
--   rechazado  el MH lo leyó y dijo que no. El número vuelve a la bolsa.
--   reintento  el MH NO contestó. El número sigue reservado y el documento
--              se reprocesa TAL CUAL. No se devuelve nada: puede que Hacienda
--              lo haya recibido y todavía no lo sepamos.
-- ============================================================
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
  update public.fiscal_documents
     set status          = 'ACCEPTED',
         sello_recepcion = p_sello,
         mh_response     = p_mh_response,
         signed_jws      = coalesce(p_signed_jws, signed_jws),
         json_original   = coalesce(p_json_original, json_original),
         accepted_at     = now(),
         submitted_at    = coalesce(submitted_at, now()),
         updated_at      = now()
   where id = p_document_id
  returning * into v_doc;

  if v_doc.id is null then
    raise exception 'No existe el documento fiscal %', p_document_id;
  end if;

  -- Consumir: sale de «en vuelo» y no vuelve a la bolsa.
  update public.fiscal_correlatives
     set reserved   = array_remove(reserved, v_doc.correlative),
         updated_at = now()
   where organization_id    = v_doc.organization_id
     and dte_type           = v_doc.dte_type
     and establishment_code = v_doc.establishment_code
     and pos_code           = v_doc.pos_code;

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
   where id = p_document_id
  returning * into v_doc;

  if v_doc.id is null then
    raise exception 'No existe el documento fiscal %', p_document_id;
  end if;

  -- El número vuelve a la bolsa. La próxima emisión lo toma antes de acuñar
  -- uno nuevo, y por eso la numeración queda continua.
  update public.fiscal_correlatives
     set reserved   = array_remove(reserved, v_doc.correlative),
         released   = array_append(array_remove(released, v_doc.correlative), v_doc.correlative),
         updated_at = now()
   where organization_id    = v_doc.organization_id
     and dte_type           = v_doc.dte_type
     and establishment_code = v_doc.establishment_code
     and pos_code           = v_doc.pos_code;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload)
  values
    (v_doc.organization_id, v_doc.id, 'DTE_REJECTED',
     jsonb_build_object('correlative', v_doc.correlative, 'error', p_error)),
    (v_doc.organization_id, v_doc.id, 'CORRELATIVE_RELEASED',
     jsonb_build_object('correlative', v_doc.correlative));

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
  -- El correlativo NO se toca: Hacienda puede haber recibido el documento sin
  -- que nos llegara la respuesta. Devolver el número acá permitiría que otra
  -- venta lo usara y terminaríamos con dos documentos con el mismo
  -- numeroControl ante el MH.
  update public.fiscal_documents
     set status        = 'RETRY_PENDING',
         attempt_count = attempt_count + 1,
         last_error    = p_error,
         submitted_at  = coalesce(submitted_at, now()),
         updated_at    = now()
   where id = p_document_id
  returning * into v_doc;

  if v_doc.id is null then
    raise exception 'No existe el documento fiscal %', p_document_id;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload)
  values (v_doc.organization_id, v_doc.id, 'DTE_RETRY',
          jsonb_build_object('attempt_count', v_doc.attempt_count, 'error', p_error));

  return v_doc;
end;
$$;

comment on function public.fiscal_mark_retry is
  'El MH no contestó. NO devuelve el correlativo: el documento pudo haber entrado. Se reprocesa el mismo.';


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
   where id = p_document_id
  returning * into v_doc;

  if v_doc.id is null then
    raise exception 'No existe el documento fiscal %', p_document_id;
  end if;

  insert into public.fiscal_audit_events
    (organization_id, fiscal_document_id, event_type, payload)
  values (v_doc.organization_id, v_doc.id, 'DTE_SIGNED',
          jsonb_build_object('correlative', v_doc.correlative));

  return v_doc;
end;
$$;


-- ============================================================
-- RLS
--
-- Las tablas fiscales se LEEN desde la app con el JWT del usuario, y se
-- ESCRIBEN sólo desde el Worker con el service role. No hay política de
-- insert/update para `authenticated` a propósito: si el frontend pudiera
-- tocar un correlativo o marcar un documento como aceptado, toda la
-- integridad fiscal dependería del navegador.
-- ============================================================
alter table public.fiscal_issuer_config  enable row level security;
alter table public.fiscal_correlatives   enable row level security;
alter table public.fiscal_audit_events   enable row level security;

drop policy if exists "fiscal_issuer_config_select" on public.fiscal_issuer_config;
create policy "fiscal_issuer_config_select"
  on public.fiscal_issuer_config for select
  using (organization_id = public.get_my_organization_id());

drop policy if exists "fiscal_correlatives_select" on public.fiscal_correlatives;
create policy "fiscal_correlatives_select"
  on public.fiscal_correlatives for select
  using (organization_id = public.get_my_organization_id());

drop policy if exists "fiscal_audit_events_select" on public.fiscal_audit_events;
create policy "fiscal_audit_events_select"
  on public.fiscal_audit_events for select
  using (organization_id = public.get_my_organization_id());

-- La política de 0022 miraba `invoice_id`, que ahora puede ser nulo: un
-- documento sin comprobante asociado quedaría invisible para su propia
-- organización. Se reemplaza por `organization_id`, que es la columna que
-- realmente dice de quién es.
drop policy if exists "fiscal_documents_select" on public.fiscal_documents;
create policy "fiscal_documents_select"
  on public.fiscal_documents for select
  using (organization_id = public.get_my_organization_id());

-- Las funciones son SECURITY DEFINER y las llama el Worker con el service
-- role. `authenticated` no las necesita y no debe tenerlas: reservar un
-- correlativo desde el navegador no tiene ningún uso legítimo.
revoke all on function public.fiscal_seed_correlative(uuid, text, text, text, bigint, text) from public, authenticated;
revoke all on function public.fiscal_open_document(text, uuid, uuid, text, uuid, uuid, text) from public, authenticated;
revoke all on function public.fiscal_mark_accepted(uuid, text, jsonb, text, jsonb) from public, authenticated;
revoke all on function public.fiscal_mark_rejected(uuid, jsonb, text) from public, authenticated;
revoke all on function public.fiscal_mark_retry(uuid, text) from public, authenticated;
revoke all on function public.fiscal_mark_signed(uuid, text, jsonb) from public, authenticated;

grant execute on function public.fiscal_seed_correlative(uuid, text, text, text, bigint, text) to service_role;
grant execute on function public.fiscal_open_document(text, uuid, uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.fiscal_mark_accepted(uuid, text, jsonb, text, jsonb) to service_role;
grant execute on function public.fiscal_mark_rejected(uuid, jsonb, text) to service_role;
grant execute on function public.fiscal_mark_retry(uuid, text) to service_role;
grant execute on function public.fiscal_mark_signed(uuid, text, jsonb) to service_role;


-- ─────────────────────────────────────────────
-- VISTA DE AUDITORÍA
--
-- La pregunta que hay que poder contestar sin cruzar tablas a mano: qué pasó
-- con cada número de la secuencia.
-- ─────────────────────────────────────────────
create or replace view public.v_fiscal_correlative_ledger as
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
  d.created_at,
  d.accepted_at,
  d.rejected_at
from public.fiscal_documents d
where d.correlative is not null;

comment on view public.v_fiscal_correlative_ledger is
  'Qué pasó con cada número de la secuencia fiscal: a qué venta fue, en qué estado quedó y con qué sello.';

grant select on public.v_fiscal_correlative_ledger to authenticated, service_role;
