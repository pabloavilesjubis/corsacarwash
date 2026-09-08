/**
 * CORSA Carwash — Estado del receptor para facturar
 *
 * Responde una sola pregunta, la que le importa al cajero antes de cobrar:
 * ¿con los datos que tiene este cliente hoy, el DTE va a pasar?
 *
 * Las reglas son las mismas que aplica 0029_customer_fiscal_dte.sql en la base
 * y que salen de los esquemas del MH. Acá se repiten para poder mostrarlas
 * campo por campo en pantalla: el CHECK de la base sólo sabe decir que sí o
 * que no, y el cajero necesita saber QUÉ falta.
 */

import {
  findDepartamento, findMunicipio, onlyDigits, MH_PATTERNS,
  FCF_IDENTIFICACION_OBLIGATORIA_DESDE, TIPOS_DOCUMENTO_RECEPTOR,
} from '../mh-catalogs'

/** Forma mínima que necesita el chequeo; la cumple el CustomerResult del POS. */
export interface ReceptorSource {
  customer_type?: 'individual' | 'company'
  first_name?: string | null
  last_name?: string | null
  legal_name?: string | null
  trade_name?: string | null
  dui?: string | null
  nit?: string | null
  nrc?: string | null
  email?: string | null
  phone?: string | null
  fiscal_document_type?: string | null
  fiscal_doc_type?: string | null
  fiscal_doc_number?: string | null
  cod_actividad?: string | null
  desc_actividad?: string | null
  fiscal_departamento?: string | null
  fiscal_municipio?: string | null
  fiscal_complemento?: string | null
  billing_email?: string | null
}

export interface ReceptorField {
  label: string
  /** Lo que se enviará al MH, ya formateado para leer. */
  value: string
  /** Cumple lo que se le exige. Un campo informativo vacío igual es `ok`. */
  ok: boolean
  /** Si falta, bloquea el cobro. Los informativos se muestran pero no frenan. */
  required: boolean
  /** Qué corregir cuando no está ok. */
  hint?: string
}

export interface ReceptorStatus {
  fields: ReceptorField[]
  ok: boolean
  /** Etiquetas de lo que falta, para el mensaje resumido. */
  missing: string[]
}

/**
 * El `nombre` del receptor en el DTE es la razón social, no el nombre
 * comercial: ese último viaja aparte en `nombreComercial`. Por eso legal_name
 * manda sobre trade_name, al revés de lo que hace la UI del POS, que muestra
 * el comercial porque es como el cajero reconoce al cliente.
 */
function nombreDe(c: ReceptorSource): string {
  if (c.customer_type === 'company') return (c.legal_name || c.trade_name || '').trim()
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
}

function correoDe(c: ReceptorSource): string {
  return (c.billing_email || c.email || '').trim()
}

function build(fields: ReceptorField[]): ReceptorStatus {
  const faltantes = fields.filter(f => f.required && !f.ok)
  return {
    fields,
    ok: faltantes.length === 0,
    missing: faltantes.map(f => f.label),
  }
}

/**
 * Receptor de Comprobante de Crédito Fiscal.
 * fe-ccf-v3.json exige los nueve campos, todos no-nulos.
 */
export function ccfReceptorStatus(c: ReceptorSource): ReceptorStatus {
  const nombre = nombreDe(c)
  const nit = onlyDigits(c.nit)
  const nrc = onlyDigits(c.nrc)
  const correo = correoDe(c)
  const tel = onlyDigits(c.phone)
  const dep = c.fiscal_departamento ? findDepartamento(c.fiscal_departamento) : undefined
  const mun = (c.fiscal_departamento && c.fiscal_municipio)
    ? findMunicipio(c.fiscal_departamento, c.fiscal_municipio)
    : undefined

  const direccion = [dep?.nombre, mun?.nombre, c.fiscal_complemento]
    .filter(Boolean).join(', ')

  // fe-ccf-v3.json exige los nueve campos: acá todos son obligatorios.
  return build([
    {
      label: c.customer_type === 'company' ? 'Razón social' : 'Nombre',
      value: nombre || '—', ok: Boolean(nombre), required: true,
    },
    {
      label: 'NIT', value: c.nit || '—', required: true,
      ok: MH_PATTERNS.nit.test(nit),
      hint: 'Debe tener 14 dígitos (o 9 si es NIT-DUI)',
    },
    {
      label: 'NRC', value: c.nrc || '—', required: true,
      ok: MH_PATTERNS.nrc.test(nrc),
      hint: 'Obligatorio: el receptor de un CCF es contribuyente registrado',
    },
    {
      label: 'Actividad', value: c.desc_actividad || '—', required: true,
      ok: Boolean(c.cod_actividad && c.desc_actividad),
    },
    {
      label: 'Dirección', value: direccion || '—', required: true,
      ok: Boolean(dep && mun && c.fiscal_complemento),
      hint: 'Requiere departamento, municipio y dirección',
    },
    {
      label: 'Teléfono', value: c.phone || '—', required: true,
      ok: tel.length >= 8,
      hint: 'El MH exige al menos 8 dígitos',
    },
    {
      label: 'Correo', value: correo || '—', required: true,
      ok: Boolean(correo),
      hint: 'Ahí se envía el DTE',
    },
  ])
}

/**
 * Receptor de Factura de Consumidor Final.
 *
 * fe-fc-v1.json lo deja todo nulo, salvo cuando la venta llega al umbral:
 * ahí exige tipoDocumento, numDocumento y nombre. Por eso el chequeo depende
 * del total y por debajo del umbral siempre pasa.
 */
export function fcfReceptorStatus(c: ReceptorSource | null, total: number): ReceptorStatus {
  // Sobre el umbral, nombre y documento dejan de ser opcionales.
  const exigeIdentificacion = total >= FCF_IDENTIFICACION_OBLIGATORIA_DESDE

  if (!c) {
    return build(exigeIdentificacion
      ? [{
          label: 'Cliente', value: '—', ok: false, required: true,
          hint: `Sobre US$${FCF_IDENTIFICACION_OBLIGATORIA_DESDE.toFixed(2)} hay que identificar al comprador`,
        }]
      : [])
  }

  const nombre = nombreDe(c)
  const tipo = TIPOS_DOCUMENTO_RECEPTOR.find(t => t.codigo === c.fiscal_doc_type)
  // El número vive donde corresponde según el tipo: NIT y DUI en sus columnas,
  // el resto en fiscal_doc_number.
  const numero = (
    c.fiscal_doc_type === '36' ? c.nit
    : c.fiscal_doc_type === '13' ? c.dui
    : c.fiscal_doc_type ? c.fiscal_doc_number
    // Sin tipo declarado mostramos el DUI, que es lo habitual en una persona.
    : c.dui
  )
  const correo = correoDe(c)

  return build([
    {
      label: 'Nombre de facturación', value: nombre || '—',
      ok: Boolean(nombre), required: exigeIdentificacion,
    },
    {
      label: tipo ? tipo.nombre : 'DUI',
      value: numero || '—',
      ok: Boolean(numero?.trim()),
      required: exigeIdentificacion,
      hint: exigeIdentificacion && !numero
        ? 'Definí el documento en la ficha del cliente'
        : undefined,
    },
    // El MH acepta correo y teléfono nulos en una FCF: se muestran para que el
    // cajero los confirme con el cliente, pero no frenan el cobro.
    { label: 'Correo', value: correo || '—', ok: true, required: false },
    { label: 'Teléfono', value: c.phone || '—', ok: true, required: false },
  ])
}

/** El documento que el cliente tiene configurado; por defecto, ticket. */
export function preferredDocType(c: ReceptorSource | null): 'ticket' | 'ccf' {
  return c?.fiscal_document_type === 'ccf' ? 'ccf' : 'ticket'
}
