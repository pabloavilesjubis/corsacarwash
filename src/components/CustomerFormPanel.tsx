/**
 * CORSA Carwash — Ficha de cliente (alta y edición)
 *
 * Un solo formulario para ambos casos: los campos y las reglas son los mismos,
 * y tenerlos duplicados garantizaba que se desincronizaran.
 *
 * Las validaciones de este archivo son un espejo del CHECK
 * `customers_ccf_requires_fiscal_data` de 0029_customer_fiscal_dte.sql, que a
 * su vez sale del schema oficial fe-ccf-v3.json del MH. La base es la que manda;
 * acá se valida sólo para dar un error legible en el campo en vez de un 400 de
 * PostgREST. Si cambia una regla, cambian las dos.
 */

import { useMemo, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import toast from 'react-hot-toast'
import {
  DEPARTAMENTOS, ACTIVIDADES_ECONOMICAS, TIPOS_DOCUMENTO_RECEPTOR,
  MH_PATTERNS, onlyDigits, getMunicipiosFor,
} from '../lib/mh-catalogs'
import { SearchSelect } from './ui/SearchSelect'
import {
  createCustomer, updateCustomer,
  type CustomerWritableFields,
} from '../services/customers.service'
import type { Customer } from '../types'

// ─── Esquema ─────────────────────────────────────────────────

const schema = z.object({
  customer_type: z.enum(['individual', 'company']),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  legal_name: z.string().optional(),
  trade_name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  dui: z.string().optional(),
  nit: z.string().optional(),
  nrc: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  fiscal_document_type: z.enum(['fcf', 'ccf']),
  fiscal_doc_type: z.string().optional(),
  fiscal_doc_number: z.string().optional(),
  cod_actividad: z.string().optional(),
  desc_actividad: z.string().optional(),
  fiscal_departamento: z.string().optional(),
  fiscal_municipio: z.string().optional(),
  fiscal_complemento: z.string().optional(),
  billing_email: z.string().optional(),
}).superRefine((v, ctx) => {
  const req = (path: keyof typeof v, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message })

  const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)

  // ── Nombre según el tipo (0007 lo exige con un CHECK) ──
  if (v.customer_type === 'individual' && !v.first_name?.trim()) {
    req('first_name', 'El nombre es obligatorio')
  }
  if (v.customer_type === 'company' && !v.legal_name?.trim()) {
    req('legal_name', 'La razón social es obligatoria')
  }

  // ── Formato, siempre que el campo tenga valor ──
  if (v.nit?.trim() && !MH_PATTERNS.nit.test(onlyDigits(v.nit))) {
    req('nit', 'El NIT debe tener 14 dígitos (o 9 si es NIT-DUI)')
  }
  if (v.nrc?.trim() && !MH_PATTERNS.nrc.test(onlyDigits(v.nrc))) {
    req('nrc', 'El NRC debe tener entre 1 y 8 dígitos')
  }
  if (v.email?.trim() && !isEmail(v.email)) req('email', 'Correo inválido')
  if (v.billing_email?.trim() && !isEmail(v.billing_email)) {
    req('billing_email', 'Correo inválido')
  }

  // ── Identificación en Consumidor Final ──
  // fe-fc-v1.json exige receptor identificado (tipoDocumento + numDocumento +
  // nombre) cuando la venta llega a US$1,095. El umbral lo evalúa el POS contra
  // el monto; acá sólo garantizamos que el dato quede completo y usable.
  if (v.fiscal_document_type === 'fcf' && v.fiscal_doc_type) {
    if (v.fiscal_doc_type === '36' && !v.nit?.trim()) {
      req('nit', 'Escribí el NIT o cambiá el tipo de documento')
    }
    if (v.fiscal_doc_type === '13' && !v.dui?.trim()) {
      req('dui', 'Escribí el DUI o cambiá el tipo de documento')
    }
    if (['02', '03', '37'].includes(v.fiscal_doc_type) && !v.fiscal_doc_number?.trim()) {
      req('fiscal_doc_number', 'Escribí el número de documento')
    }
  }

  // ── Completitud para Crédito Fiscal ──
  if (v.fiscal_document_type !== 'ccf') return

  if (!v.nit?.trim()) req('nit', 'El NIT es obligatorio para emitir CCF')
  // El receptor de un CCF es siempre un contribuyente registrado.
  if (!v.nrc?.trim()) req('nrc', 'El NRC es obligatorio para emitir CCF')
  if (!v.cod_actividad?.trim()) req('cod_actividad', 'Elegí la actividad económica')
  if (!v.fiscal_departamento?.trim()) req('fiscal_departamento', 'Elegí el departamento')
  if (!v.fiscal_municipio?.trim()) req('fiscal_municipio', 'Elegí el municipio')
  if (!v.fiscal_complemento?.trim()) req('fiscal_complemento', 'La dirección es obligatoria')
  // El MH exige teléfono de 8 caracteres como mínimo.
  if (onlyDigits(v.phone).length < 8) {
    req('phone', 'El teléfono es obligatorio para CCF (mínimo 8 dígitos)')
  }
  if (!v.billing_email?.trim() && !v.email?.trim()) {
    req('billing_email', 'Se necesita un correo para enviar el DTE')
  }
})

type FormValues = z.infer<typeof schema>

// ─── Helpers de presentación ─────────────────────────────────

function Field({ label, error, children }: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error && (
        <div style={{ color: 'var(--color-danger-text)', fontSize: 11.5, marginTop: 3 }}>{error}</div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="panel-section-label" style={{ marginTop: 6 }}>{children}</div>
}

function defaultsFrom(customer?: Customer): FormValues {
  return {
    customer_type: customer?.customer_type ?? 'individual',
    first_name: customer?.first_name ?? '',
    last_name: customer?.last_name ?? '',
    legal_name: customer?.legal_name ?? '',
    trade_name: customer?.trade_name ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    dui: customer?.dui ?? '',
    nit: customer?.nit ?? '',
    nrc: customer?.nrc ?? '',
    address: customer?.address ?? '',
    notes: customer?.notes ?? '',
    fiscal_document_type: customer?.fiscal_document_type ?? 'fcf',
    fiscal_doc_type: customer?.fiscal_doc_type ?? '',
    fiscal_doc_number: customer?.fiscal_doc_number ?? '',
    cod_actividad: customer?.cod_actividad ?? '',
    desc_actividad: customer?.desc_actividad ?? '',
    fiscal_departamento: customer?.fiscal_departamento ?? '',
    fiscal_municipio: customer?.fiscal_municipio ?? '',
    fiscal_complemento: customer?.fiscal_complemento ?? '',
    billing_email: customer?.billing_email ?? '',
  }
}

/** '' → null: la base distingue "sin dato" de "cadena vacía" en los CHECK. */
function blankToNull(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

// ─── Panel ───────────────────────────────────────────────────

export function CustomerFormPanel({
  customer, orgId, onClose, onSaved,
}: {
  /** Presente = edición; ausente = alta. */
  customer?: Customer
  orgId: string
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const isEdit = Boolean(customer)
  // Último valor que el espejo escribió en billing_email. Sirve para distinguir
  // "el usuario nunca lo tocó" de "lo cambió a propósito".
  const previousEmail = useRef(customer?.email ?? '')

  const {
    register, handleSubmit, watch, setValue, getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultsFrom(customer),
  })

  const type = watch('customer_type')
  const docType = watch('fiscal_document_type')
  const departamento = watch('fiscal_departamento')
  const docTypeCode = watch('fiscal_doc_type') ?? ''

  const municipios = useMemo(
    () => (departamento ? getMunicipiosFor(departamento) : []),
    [departamento]
  )

  const onSubmit = async (v: FormValues) => {
    const fields: CustomerWritableFields = {
      customer_type: v.customer_type,
      first_name: v.customer_type === 'individual' ? blankToNull(v.first_name) : null,
      last_name: v.customer_type === 'individual' ? blankToNull(v.last_name) : null,
      legal_name: v.customer_type === 'company' ? blankToNull(v.legal_name) : null,
      trade_name: blankToNull(v.trade_name),
      phone: blankToNull(v.phone),
      email: blankToNull(v.email),
      dui: blankToNull(v.dui),
      nit: blankToNull(v.nit),
      nrc: blankToNull(v.nrc),
      address: blankToNull(v.address),
      notes: blankToNull(v.notes),
      fiscal_document_type: v.fiscal_document_type,
      fiscal_doc_type: blankToNull(v.fiscal_doc_type),
      fiscal_doc_number: blankToNull(v.fiscal_doc_number),
      cod_actividad: blankToNull(v.cod_actividad),
      desc_actividad: blankToNull(v.desc_actividad),
      fiscal_departamento: blankToNull(v.fiscal_departamento),
      fiscal_municipio: blankToNull(v.fiscal_municipio),
      fiscal_complemento: blankToNull(v.fiscal_complemento),
      billing_email: blankToNull(v.billing_email),
    }

    try {
      if (customer) {
        await updateCustomer(customer.id, fields as Partial<Customer>)
        toast.success('Cliente actualizado')
        onSaved(customer.id)
      } else {
        const created = await createCustomer({ ...fields, organization_id: orgId })
        toast.success('Cliente guardado')
        onSaved((created as { id: string }).id)
      }
    } catch (err) {
      // Los CHECK de la base son la última línea de defensa; si uno salta acá
      // es que el espejo de validaciones se desincronizó. Mostralo tal cual.
      const message = err instanceof Error ? err.message : ''
      toast.error(
        /ccf_requires_fiscal_data/.test(message)
          ? 'Faltan datos fiscales obligatorios para emitir CCF'
          : 'No se pudo guardar el cliente'
      )
    }
  }

  return (
    <div className="side-panel" style={{ maxWidth: 420 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
          {isEdit ? 'Editar cliente' : 'Nuevo cliente'}
        </div>
        <button className="panel-close" onClick={onClose} aria-label="Cerrar">×</button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* ── Tipo de cliente ── */}
        <div className="filter-pills">
          {(['individual', 'company'] as const).map(t => (
            <button
              key={t}
              type="button"
              className={`filter-pill${type === t ? ' active' : ''}`}
              onClick={() => setValue('customer_type', t, { shouldValidate: true })}
            >
              {t === 'individual' ? 'Persona' : 'Empresa'}
            </button>
          ))}
        </div>

        {type === 'individual' ? (
          <>
            <Field label="Nombre *" error={errors.first_name?.message}>
              <input {...register('first_name')} className="corsa-input" placeholder="Nombre"/>
            </Field>
            <Field label="Apellido">
              <input {...register('last_name')} className="corsa-input" placeholder="Apellido"/>
            </Field>
            <Field label="DUI" error={errors.dui?.message}>
              <input {...register('dui')} className="corsa-input" placeholder="00000000-0"/>
            </Field>
          </>
        ) : (
          <>
            <Field label="Razón social *" error={errors.legal_name?.message}>
              <input {...register('legal_name')} className="corsa-input" placeholder="Razón social"/>
            </Field>
            <Field label="Nombre comercial">
              <input {...register('trade_name')} className="corsa-input" placeholder="Nombre comercial"/>
            </Field>
          </>
        )}

        <Field label="Teléfono" error={errors.phone?.message}>
          <input {...register('phone')} className="corsa-input" placeholder="2222-1111"/>
        </Field>
        <Field label="Correo" error={errors.email?.message}>
          <input
            {...register('email')}
            className="corsa-input"
            placeholder="correo@ejemplo.com"
            onChange={e => {
              const next = e.target.value
              setValue('email', next, { shouldValidate: true })
              // El correo de facturación arranca igual al de contacto: en la
              // mayoría de los casos es el mismo y escribirlo dos veces sólo
              // invita a la errata. Se sigue pudiendo separar a mano — una vez
              // que difieren, dejamos de sobrescribirlo.
              const factura = getValues('billing_email') ?? ''
              if (factura === '' || factura === previousEmail.current) {
                setValue('billing_email', next)
              }
              previousEmail.current = next
            }}
          />
        </Field>

        {/* ── Documento tributario ── */}
        <SectionLabel>Documento tributario</SectionLabel>
        <div className="filter-pills">
          {([
            ['fcf', 'Consumidor final'],
            ['ccf', 'Crédito fiscal'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`filter-pill${docType === value ? ' active' : ''}`}
              onClick={() => setValue('fiscal_document_type', value, { shouldValidate: true })}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: -4 }}>
          {docType === 'ccf'
            ? 'El POS emitirá CCF. El Ministerio de Hacienda exige todos los campos de abajo; sin ellos el DTE se rechaza.'
            : 'El POS emitirá Factura de Consumidor Final. No requiere datos fiscales.'}
        </div>

        {docType === 'fcf' && (
          <>
            <Field label="Se identifica con">
              <select {...register('fiscal_doc_type')} className="corsa-input">
                <option value="">— Ninguno (venta anónima) —</option>
                {TIPOS_DOCUMENTO_RECEPTOR.map(t => (
                  <option key={t.codigo} value={t.codigo}>{t.nombre}</option>
                ))}
              </select>
            </Field>
            {docTypeCode && (
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: -6 }}>
                El Ministerio de Hacienda exige identificar al comprador cuando la
                venta llega a US$1,095. Debajo de ese monto es opcional.
              </div>
            )}
            {/* NIT y DUI reusan sus columnas de siempre; los demás tipos van a
                fiscal_doc_number. Sin esto no había dónde escribir el número. */}
            {docTypeCode === '36' && (
              <Field label="NIT" error={errors.nit?.message}>
                <input {...register('nit')} className="corsa-input" placeholder="0614-010101-101-5"/>
              </Field>
            )}
            {/* Las personas ya tienen su DUI en el bloque de identidad de arriba;
                repetirlo acá ataría dos inputs al mismo campo del formulario. */}
            {docTypeCode === '13' && type === 'company' && (
              <Field label="DUI" error={errors.dui?.message}>
                <input {...register('dui')} className="corsa-input" placeholder="00000000-0"/>
              </Field>
            )}
            {['02', '03', '37'].includes(docTypeCode) && (
              <Field label="Número de documento" error={errors.fiscal_doc_number?.message}>
                <input {...register('fiscal_doc_number')} className="corsa-input"/>
              </Field>
            )}
          </>
        )}

        {/* ── Datos exigidos por el MH para CCF ── */}
        {docType === 'ccf' && (
          <>
            <Field label="NIT *" error={errors.nit?.message}>
              <input {...register('nit')} className="corsa-input" placeholder="0614-010101-101-5"/>
            </Field>
            <Field label="NRC *" error={errors.nrc?.message}>
              <input {...register('nrc')} className="corsa-input" placeholder="123456"/>
            </Field>

            <Field label="Actividad económica *" error={errors.cod_actividad?.message}>
              {/* 769 opciones: un <select> obliga a scrollear a ciegas. */}
              <SearchSelect
                id="cod-actividad"
                items={ACTIVIDADES_ECONOMICAS}
                value={watch('cod_actividad') ?? ''}
                placeholder="Escribí para buscar (ej. lavado, taller, comercio)…"
                onChange={codigo => {
                  setValue('cod_actividad', codigo, { shouldValidate: true })
                  // descActividad viaja junto al código en el DTE.
                  setValue(
                    'desc_actividad',
                    ACTIVIDADES_ECONOMICAS.find(a => a.codigo === codigo)?.nombre ?? ''
                  )
                }}
              />
            </Field>

            <Field label="Departamento *" error={errors.fiscal_departamento?.message}>
              <select
                {...register('fiscal_departamento')}
                className="corsa-input"
                onChange={e => {
                  setValue('fiscal_departamento', e.target.value, { shouldValidate: true })
                  // El código de municipio sólo es válido dentro de su departamento.
                  setValue('fiscal_municipio', '')
                }}
              >
                <option value="">— Elegí uno —</option>
                {DEPARTAMENTOS.map(d => (
                  <option key={d.codigo} value={d.codigo}>{d.nombre}</option>
                ))}
              </select>
            </Field>

            <Field label="Municipio *" error={errors.fiscal_municipio?.message}>
              <select {...register('fiscal_municipio')} className="corsa-input" disabled={!departamento}>
                <option value="">{departamento ? '— Elegí uno —' : '— Elegí el departamento primero —'}</option>
                {municipios.map(m => (
                  <option key={m.codigo} value={m.codigo}>{m.nombre}</option>
                ))}
              </select>
            </Field>

            <Field label="Dirección *" error={errors.fiscal_complemento?.message}>
              <input {...register('fiscal_complemento')} className="corsa-input"
                     placeholder="Col. Escalón, Calle 1 #23"/>
            </Field>

            <Field label="Correo para facturación electrónica" error={errors.billing_email?.message}>
              <input {...register('billing_email')} className="corsa-input"
                     placeholder="facturacion@empresa.com"/>
            </Field>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: -6 }}>
              Se copia del correo de contacto. Cambialo si la empresa recibe las
              facturas en otra casilla.
            </div>
          </>
        )}

        <SectionLabel>Notas</SectionLabel>
        <textarea {...register('notes')} className="corsa-input" rows={2}
                  placeholder="Notas internas"/>

        <button
          type="submit"
          disabled={isSubmitting}
          style={{ textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: '#fff', background: 'var(--corsa-green)', borderRadius: 5, padding: 10, cursor: 'pointer', border: 'none', marginTop: 4 }}
        >
          {isSubmitting ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Guardar cliente'}
        </button>
      </form>
    </div>
  )
}
