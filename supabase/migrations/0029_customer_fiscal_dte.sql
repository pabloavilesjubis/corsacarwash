-- ============================================================
-- Migration: 0029_customer_fiscal_dte.sql
-- Description: Datos fiscales del cliente para emitir DTE (El Salvador).
--
--   Contexto: 0007 guardaba dui/nit/nrc y una dirección de texto libre. Eso
--   alcanza para el CRM pero NO para emitir un Comprobante de Crédito Fiscal:
--   el MH exige el receptor completo y con formato.
--
--   Fuente: esquemas JSON oficiales del MH (svfe-json-schemas), tomados del
--   proyecto ERP-PAAJ:
--
--   fe-ccf-v3.json → receptor.required =
--     [nit, nrc, nombre, codActividad, descActividad, nombreComercial,
--      direccion{departamento, municipio, complemento}, telefono, correo]
--     TODOS obligatorios y no-nulos. Un receptor de CCF es necesariamente un
--     contribuyente registrado: por eso el NRC es exigible, no opcional.
--
--   fe-fc-v1.json → receptor de Factura de Consumidor Final: todo nullable.
--     El receptor entero puede omitirse (venta anónima de mostrador).
--
--   De ahí el diseño: fiscal_document_type marca qué pide el cliente, y la
--   validación fuerte sólo se aplica cuando pide CCF. Un cliente FCF sigue
--   guardándose con nombre y nada más, como hoy.
--
--   Identificación del receptor:
--   - CCF: siempre por NIT (columna `nit` existente).
--   - FCF: por el tipo de CAT-022 en fiscal_doc_type. Para NIT/DUI se reusan
--     las columnas existentes — así siguen sirviendo los índices de
--     deduplicación de 0007. fiscal_doc_number es sólo para los casos raros
--     (carnet de residente, pasaporte, otro).
-- ============================================================

alter table public.customers
  -- Qué documento tributario requiere este cliente.
  add column if not exists fiscal_document_type text not null default 'fcf',

  -- CAT-022 — con qué documento se identifica en una FCF.
  add column if not exists fiscal_doc_type      text,
  add column if not exists fiscal_doc_number    text,   -- sólo tipos 02/03/37

  -- CAT-019 — actividad económica.
  add column if not exists cod_actividad        text,
  add column if not exists desc_actividad       text,

  -- Dirección estructurada que exige el DTE (CAT-012 / CAT-013).
  add column if not exists fiscal_departamento  text,
  add column if not exists fiscal_municipio     text,
  add column if not exists fiscal_complemento   text,

  -- Correo al que se envía el DTE. Separado de `email` (contacto comercial)
  -- porque en empresas suele ser una casilla distinta (facturacion@…).
  add column if not exists billing_email        text;

comment on column public.customers.fiscal_document_type is
  'Documento tributario que requiere el cliente: fcf (consumidor final) o ccf (crédito fiscal). Lo lee el POS al facturar.';
comment on column public.customers.fiscal_doc_type is
  'CAT-022: 36=NIT, 13=DUI, 02=Carnet residente, 03=Pasaporte, 37=Otro. Sólo aplica al receptor de una FCF. Obligatorio si la venta llega a US$1,095.';
comment on column public.customers.fiscal_doc_number is
  'Número de documento para los tipos 02/03/37. Para NIT y DUI se usan las columnas nit y dui.';
comment on column public.customers.cod_actividad is
  'CAT-019 — código de actividad económica (2 a 6 dígitos). Obligatorio para CCF.';
comment on column public.customers.billing_email is
  'Correo para el envío del DTE. Si está vacío se cae a `email`.';


-- ─────────────────────────────────────────────
-- FORMATO — patrones exactos del schema del MH.
-- Se validan siempre que el campo tenga valor, sea FCF o CCF: un dato mal
-- formado guardado hoy es un DTE rechazado dentro de seis meses.
-- ─────────────────────────────────────────────
alter table public.customers
  drop constraint if exists customers_fiscal_document_type_valid,
  add  constraint customers_fiscal_document_type_valid
    check (fiscal_document_type in ('fcf', 'ccf'));

alter table public.customers
  drop constraint if exists customers_fiscal_doc_type_valid,
  add  constraint customers_fiscal_doc_type_valid
    check (fiscal_doc_type is null or fiscal_doc_type in ('36','13','02','03','37'));

alter table public.customers
  drop constraint if exists customers_nit_format,
  add  constraint customers_nit_format
    -- 14 dígitos (formato clásico) o 9 (NIT-DUI homologado).
    check (nit is null or nit = '' or normalized_nit ~ '^([0-9]{14}|[0-9]{9})$');

alter table public.customers
  drop constraint if exists customers_nrc_format,
  add  constraint customers_nrc_format
    check (nrc is null or nrc = '' or normalized_nrc ~ '^[0-9]{1,8}$');

alter table public.customers
  drop constraint if exists customers_cod_actividad_format,
  add  constraint customers_cod_actividad_format
    check (cod_actividad is null or cod_actividad ~ '^[0-9]{2,6}$');

alter table public.customers
  drop constraint if exists customers_departamento_format,
  add  constraint customers_departamento_format
    check (fiscal_departamento is null or fiscal_departamento ~ '^(0[1-9]|1[0-4])$');

alter table public.customers
  drop constraint if exists customers_municipio_format,
  add  constraint customers_municipio_format
    check (fiscal_municipio is null or fiscal_municipio ~ '^[0-9]{2}$');

alter table public.customers
  drop constraint if exists customers_fiscal_text_lengths,
  add  constraint customers_fiscal_text_lengths
    check (
      (desc_actividad     is null or char_length(desc_actividad)     between 1 and 150)
      and (fiscal_complemento is null or char_length(fiscal_complemento) between 1 and 200)
      and (billing_email      is null or char_length(billing_email)      <= 100)
    );


-- ─────────────────────────────────────────────
-- COMPLETITUD PARA CCF
--
-- Se aplica SÓLO cuando el cliente pide CCF. Marcar a alguien como CCF es
-- afirmar que se le puede emitir uno; si faltara un campo, el rechazo llegaría
-- recién al transmitir el DTE, con el cliente esperando en caja. Mejor que
-- falle al guardar la ficha.
--
-- `nombre` y `nombreComercial` del receptor salen de legal_name/trade_name
-- (empresas) o first_name/last_name (personas), que 0007 ya obliga.
-- ─────────────────────────────────────────────
alter table public.customers
  drop constraint if exists customers_ccf_requires_fiscal_data,
  add  constraint customers_ccf_requires_fiscal_data
    check (
      fiscal_document_type <> 'ccf'
      or (
            normalized_nit      ~ '^([0-9]{14}|[0-9]{9})$'
        and normalized_nrc      ~ '^[0-9]{1,8}$'
        and cod_actividad       is not null
        and desc_actividad      is not null
        and fiscal_departamento is not null
        and fiscal_municipio    is not null
        and fiscal_complemento  is not null
        -- El MH exige teléfono de 8 caracteres como mínimo.
        and char_length(coalesce(normalized_phone, '')) >= 8
        -- correo: billing_email si existe, si no el de contacto.
        and coalesce(nullif(billing_email, ''), nullif(email, '')) is not null
      )
    );

-- El POS filtra por este campo al elegir qué documento emitir.
create index if not exists idx_customers_fiscal_document_type
  on public.customers(organization_id, fiscal_document_type);


-- ─────────────────────────────────────────────
-- IDENTIFICACIÓN EN CONSUMIDOR FINAL
--
-- fe-fc-v1.json trae una regla condicional en la raíz:
--
--   if   resumen.montoTotalOperacion >= 1095.00
--   then receptor = objeto con tipoDocumento, numDocumento y nombre no nulos
--
-- Es decir: una FCF normal puede ir sin receptor (venta anónima de mostrador),
-- pero al llegar a US$1,095 hay que identificar al comprador. Ese umbral se
-- evalúa contra el monto de la venta, así que quien lo hace cumplir es el POS
-- al facturar, no esta tabla. Lo que sí garantizamos acá es que la ficha pueda
-- guardar esa identificación de forma utilizable: si se declara un tipo de
-- documento, tiene que venir su número.
--
-- El nombre del receptor ya lo asegura 0007 (first_name / legal_name).
-- ─────────────────────────────────────────────
alter table public.customers
  drop constraint if exists customers_fiscal_doc_has_number,
  add  constraint customers_fiscal_doc_has_number
    check (
      fiscal_doc_type is null
      -- 36=NIT y 13=DUI reusan las columnas existentes; el resto va en
      -- fiscal_doc_number.
      or (fiscal_doc_type = '36' and nullif(nit, '') is not null)
      or (fiscal_doc_type = '13' and nullif(dui, '') is not null)
      or (fiscal_doc_type in ('02','03','37') and nullif(fiscal_doc_number, '') is not null)
    );
