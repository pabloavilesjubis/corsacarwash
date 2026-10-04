/**
 * CORSA Carwash — invalidar un documento ante Hacienda.
 *
 * Una factura mal emitida no se borra: se invalida con un evento firmado. El
 * número de control, la fecha y el sello del original NO se escriben acá: el
 * servicio fiscal los toma del JSON que Hacienda selló. Lo único que aporta
 * este formulario es lo que el original no tiene — el motivo, quién responde,
 * quién lo pide y, en una FCF de mostrador, a quién se identifica.
 *
 * Un rechazo de Hacienda acá no cuesta nada: la invalidación no gasta
 * correlativo. Se corrige y se vuelve a intentar.
 */

import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import {
  invalidar, fetchResponsableFijo, dinero, tieneContraparte, ErrorFiscal, NOMBRE_TIPO, TIPO_ANULACION_ETIQUETA,
  type DocumentoFiscal, type Persona,
} from '../../services/fiscal.service'
import { formatearFecha } from '../../utils/fecha'
import { Campo, CamposPersona, Dato, Seccion } from './comunes'
import { avisarResultado, nuevaLlave, problemaDeDocumento, recordarResponsable, responsableRecordado } from './logica'

const EXPLICACION: Record<1 | 2 | 3, string> = {
  1: 'Se emitió con un dato equivocado. Primero se emite el documento corregido y después se invalida éste, indicando cuál lo reemplaza.',
  2: 'La operación no se realizó o se deshizo por completo (devolución total, venta cancelada). No lleva reemplazo.',
  3: 'Cualquier otro motivo. Hacienda exige escribirlo y, como en el tipo 1, indicar el documento que lo reemplaza.',
}

/**
 * Plazos de referencia. NO están verificados contra la normativa en este
 * repositorio: son los que documenta otra implementación en producción. No se
 * bloquea nada con ellos —un rechazo por plazo no gasta correlativo—; sólo se
 * avisa.
 */
function avisoDePlazo(doc: DocumentoFiscal): string | null {
  if (!doc.fecha_emision) return null
  const dias = (Date.now() - new Date(`${doc.fecha_emision}T00:00:00-06:00`).getTime()) / 86_400_000
  if (doc.dte_type === '01' && dias > 90) {
    return 'Esta factura tiene más de tres meses. Hacienda podría rechazar la invalidación por plazo.'
  }
  if (doc.dte_type !== '01' && dias > 1) {
    return 'Este documento tiene más de un día. Para CCF y Notas de Crédito el plazo de invalidación suele ser corto: Hacienda podría rechazarla.'
  }
  return null
}

export function FormInvalidacion({ documentos, inicial, onListo, onCancelar }: {
  /** Documentos aceptados del ambiente actual: los únicos invalidables. */
  documentos: DocumentoFiscal[]
  inicial?: string | null
  onListo: () => void
  onCancelar: () => void
}) {
  const [llave, setLlave] = useState(nuevaLlave)
  const [buscar, setBuscar] = useState('')
  const [documentoId, setDocumentoId] = useState(inicial ?? '')
  const [tipo, setTipo] = useState<1 | 2 | 3>(2)
  const [reemplazoId, setReemplazoId] = useState('')
  const [motivo, setMotivo] = useState('')
  const [receptor, setReceptor] = useState<Persona>({ nombre: '', tipoDocumento: '13', numDocumento: '' })
  const [responsable, setResponsable] = useState<Persona>(responsableRecordado)
  // El responsable fijo de CORSA (Configuración fiscal). Si está, no se pide:
  // el Worker lo pone en el evento.
  const [fijo, setFijo] = useState<Persona | null | undefined>(undefined)
  useEffect(() => {
    fetchResponsableFijo().then(r => setFijo(r as Persona | null)).catch(() => setFijo(null))
  }, [])
  const [solicitante, setSolicitante] = useState<Persona>({ nombre: '', tipoDocumento: '13', numDocumento: '' })
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const doc = documentos.find(d => d.id === documentoId) ?? null

  const candidatos = useMemo(() => {
    const s = buscar.trim().toLowerCase()
    return documentos.filter(d => !s ||
      d.numero_control.toLowerCase().includes(s) ||
      (d.contraparte_nombre ?? '').toLowerCase().includes(s) ||
      d.codigo_generacion.toLowerCase().includes(s))
  }, [documentos, buscar])

  const reemplazos = useMemo(
    () => (doc ? documentos.filter(d => d.dte_type === doc.dte_type && d.id !== doc.id) : []),
    [documentos, doc],
  )

  const elegir = (id: string) => {
    setDocumentoId(id)
    setReemplazoId('')
    const d = documentos.find(x => x.id === id)
    // Quien pide la invalidación suele ser la contraparte: se propone su nombre.
    if (d?.contraparte_nombre && !solicitante.nombre) {
      setSolicitante(s => ({ ...s, nombre: d.contraparte_nombre ?? '' }))
    }
  }

  const pideReceptor = doc !== null && !tieneContraparte(doc)

  const problemas = useMemo(() => {
    const p: string[] = []
    if (!doc) { p.push('Elegí el documento a invalidar'); return p }
    if ((tipo === 1 || tipo === 3) && !reemplazoId) p.push('Elegí el documento que lo reemplaza (emitilo primero si no existe)')
    if (tipo === 3 && motivo.trim().length < 5) p.push('Escribí el motivo (al menos 5 caracteres)')
    if (motivo.trim() && (motivo.trim().length < 5 || motivo.trim().length > 250)) p.push('El motivo va de 5 a 250 caracteres')
    if (pideReceptor) {
      if (receptor.nombre.trim().length < 5) p.push('Escribí el nombre del cliente (al menos 5 caracteres)')
      const r = problemaDeDocumento(receptor.tipoDocumento, receptor.numDocumento)
      if (r) p.push(`Cliente: ${r}`)
    }
    const personas = fijo ? [['Solicitante', solicitante]] as const : [['Responsable', responsable], ['Solicitante', solicitante]] as const
    for (const [quien, per] of personas) {
      if (per.nombre.trim().length < 5) p.push(`${quien}: el nombre va de 5 a 100 caracteres`)
      const r = problemaDeDocumento(per.tipoDocumento, per.numDocumento)
      if (r) p.push(`${quien}: ${r}`)
    }
    return p
  }, [doc, tipo, reemplazoId, motivo, pideReceptor, receptor, responsable, solicitante, fijo])

  const enviar = async () => {
    if (problemas.length > 0) { setError(problemas[0]!); return }
    if (!doc) return
    const confirmado = window.confirm(
      `Vas a invalidar ante Hacienda ${doc.numero_control} (${NOMBRE_TIPO[doc.dte_type]}).\n\n` +
      'Una invalidación aceptada no se deshace. ¿Continuar?')
    if (!confirmado) return

    setEnviando(true)
    setError(null)
    if (!fijo) recordarResponsable(responsable)
    try {
      const r = await invalidar({
        idempotencyKey: llave,
        documentoId: doc.id,
        tipoAnulacion: tipo,
        motivoAnulacion: motivo.trim() || null,
        documentoReemplazoId: tipo === 2 ? null : reemplazoId,
        receptor: pideReceptor ? { ...receptor, nombre: receptor.nombre.trim() } : null,
        // Con responsable fijo no se manda: lo pone el Worker desde la configuración.
        responsable: fijo ? null : { ...responsable, nombre: responsable.nombre.trim() },
        solicitante: { ...solicitante, nombre: solicitante.nombre.trim() },
      })
      const desenlace = avisarResultado(r, 'La invalidación')
      if (desenlace === 'listo' || desenlace === 'pendiente') { onListo(); return }
      // Rechazada (por Hacienda o por la validación previa): no se gastó nada.
      // La próxima es otra invalidación, con otra llave.
      setLlave(nuevaLlave())
      setError(`No se invalidó: ${r.mensaje ?? 'sin detalle'}. Corregí y volvé a intentar.`)
    } catch (e) {
      const err = e as ErrorFiscal
      setError(err.message)
      if (err.codigo === 'SESION_INVALIDA') toast.error(err.message)
    }
    setEnviando(false)
  }

  const plazo = doc ? avisoDePlazo(doc) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Seccion titulo="Documento a invalidar">
        {!inicial && (
          <input className="corsa-input" value={buscar} placeholder="Buscar por número de control o cliente…"
                 onChange={e => setBuscar(e.target.value)}/>
        )}
        <select className="corsa-input" value={documentoId} onChange={e => elegir(e.target.value)} disabled={!!inicial}>
          <option value="">{candidatos.length ? 'Elegí un documento aceptado…' : 'No hay documentos aceptados que coincidan'}</option>
          {candidatos.map(d => (
            <option key={d.id} value={d.id}>
              {d.numero_control} · {d.contraparte_nombre ?? 'Consumidor final'} · {dinero(d.monto_total)}
            </option>
          ))}
        </select>
        {doc && (
          <div>
            <Dato label="Tipo" valor={NOMBRE_TIPO[doc.dte_type]}/>
            <Dato label="Emitido" valor={doc.fecha_emision ? formatearFecha(doc.fecha_emision) : null}/>
            <Dato label="Cliente / proveedor" valor={doc.contraparte_nombre ?? 'Consumidor final (sin identificar)'}/>
            <Dato label="Monto" valor={dinero(doc.monto_total)}/>
            <Dato label="Código de generación" valor={doc.codigo_generacion} mono/>
          </div>
        )}
        {plazo && (
          <div className="alert-banner warning"><div className="alert-body"><div className="alert-desc">{plazo}</div></div></div>
        )}
      </Seccion>

      <Seccion titulo="Tipo de invalidación">
        {([2, 1, 3] as const).map(t => (
          <label key={t} style={{
            display: 'flex', gap: 10, padding: '10px 12px', cursor: 'pointer', borderRadius: 10,
            border: `1px solid ${tipo === t ? 'var(--corsa-green)' : 'var(--border)'}`,
            background: tipo === t ? 'var(--subtle-bg)' : 'transparent',
          }}>
            <input type="radio" checked={tipo === t} onChange={() => setTipo(t)} style={{ accentColor: 'var(--corsa-green)' }}/>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{TIPO_ANULACION_ETIQUETA[t]}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>{EXPLICACION[t]}</div>
            </div>
          </label>
        ))}
        {(tipo === 1 || tipo === 3) && doc && (
          <Campo label="Documento que lo reemplaza" ancho="1 1 100%"
                 ayuda="Tiene que estar ya aceptado por Hacienda y ser del mismo tipo.">
            <select className="corsa-input" value={reemplazoId} onChange={e => setReemplazoId(e.target.value)}>
              <option value="">{reemplazos.length ? 'Elegí el documento corregido…' : 'No hay otro documento aceptado de este tipo'}</option>
              {reemplazos.map(d => (
                <option key={d.id} value={d.id}>
                  {d.numero_control} · {d.contraparte_nombre ?? 'Consumidor final'} · {dinero(d.monto_total)}
                </option>
              ))}
            </select>
          </Campo>
        )}
        <Campo label={tipo === 3 ? 'Motivo' : 'Motivo (opcional)'} ancho="1 1 100%">
          <input className="corsa-input" value={motivo} maxLength={250} onChange={e => setMotivo(e.target.value)}/>
        </Campo>
      </Seccion>

      {pideReceptor && (
        <Seccion titulo="Cliente (la factura fue de mostrador; Hacienda exige identificarlo)">
          <CamposPersona valor={receptor} onChange={setReceptor}/>
        </Seccion>
      )}

      <Seccion titulo="Responsable de la invalidación">
        {fijo
          ? <div style={{ fontSize: 13.5 }}>
              <strong>{fijo.nombre}</strong> · {fijo.tipoDocumento === '13' ? 'DUI' : fijo.tipoDocumento === '36' ? 'NIT' : 'Doc.'} {fijo.numDocumento}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Fijo, de la configuración fiscal de CORSA.</div>
            </div>
          : fijo === undefined
            ? <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Cargando…</div>
            : <CamposPersona valor={responsable} onChange={setResponsable}/>}
      </Seccion>

      <Seccion titulo="Quién la solicita">
        <CamposPersona valor={solicitante} onChange={setSolicitante}/>
      </Seccion>

      {error && (
        <div className="alert-banner danger"><div className="alert-body"><div className="alert-desc">{error}</div></div></div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn btn-ghost" onClick={onCancelar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-danger" onClick={enviar} disabled={enviando}>
          {enviando ? 'Invalidando…' : 'Invalidar ante Hacienda'}
        </button>
      </div>
    </div>
  )
}
