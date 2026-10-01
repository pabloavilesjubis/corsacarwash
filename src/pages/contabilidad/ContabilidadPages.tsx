/**
 * CORSA Carwash — Contabilidad
 *
 * Cuatro pantallas bajo un mismo submenú:
 *
 *   Notas de crédito     historial de DTE 05 y emisión de una nueva
 *   Sujetos excluidos    historial de DTE 14 y emisión de una nueva
 *   Invalidaciones       historial de eventos y una invalidación nueva
 *   Correlativos         dónde va cada secuencia y el sembrado de arranque
 *
 * El historial muestra el AMBIENTE al que transmite el servicio fiscal: en
 * pruebas se ven las pruebas, en producción los documentos reales. Las dos
 * secuencias son distintas y nunca se mezclan.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import { Modal } from '../../components/ui/Modal'
import { formatearFecha, formatearFechaHora } from '../../utils/fecha'
import {
  fetchDocumentos, fetchInvalidaciones, reintentarDocumento, reintentarInvalidacion,
  dinero, NOMBRE_TIPO, NOMBRE_CORTO_TIPO, TIPO_ANULACION_ETIQUETA,
  type DocumentoFiscal, type EstadoFiscal, type Invalidacion, type TipoDte,
} from '../../services/fiscal.service'
import { Dato, Encabezado, EstadoBadge } from './comunes'
import { avisarResultado, useServicioFiscal } from './logica'
import { FormSujetoExcluido } from './FormSujetoExcluido'
import { FormNotaCredito } from './FormNotaCredito'
import { FormInvalidacion } from './FormInvalidacion'
export { CorrelativosPage } from './CorrelativosPage'

const PENDIENTES: EstadoFiscal[] = ['CREATED', 'SIGNED', 'SUBMITTED', 'RETRY_PENDING', 'CONTINGENCY']

const FILTROS: { id: string; label: string; estados?: EstadoFiscal[] }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'aceptados', label: 'Aceptados', estados: ['ACCEPTED'] },
  { id: 'pendientes', label: 'Pendientes', estados: PENDIENTES },
  { id: 'rechazados', label: 'Rechazados', estados: ['REJECTED'] },
  { id: 'invalidados', label: 'Invalidados', estados: ['INVALIDATED'] },
]

function SinAcceso() {
  return (
    <div className="page-inner">
      <div className="empty-state">
        <div className="empty-state-title">No tenés acceso a Contabilidad</div>
        <div className="empty-state-sub">Pedile acceso a un administrador.</div>
      </div>
    </div>
  )
}

// ─── Historial de documentos (NC y FSEE) ─────────────────────

function HistorialDocumentos({ tipo }: { tipo: Extract<TipoDte, '05' | '14'> }) {
  const { hasPermission, currentBranch } = useAuth()
  const navigate = useNavigate()
  const servicio = useServicioFiscal()
  const puedeEmitir = hasPermission('fiscal.issue')

  const [docs, setDocs] = useState<DocumentoFiscal[]>([])
  const [filtro, setFiltro] = useState('todos')
  const [buscar, setBuscar] = useState('')
  const [cargando, setCargando] = useState(true)
  const [abiertoId, setAbiertoId] = useState<string | null>(null)
  const [nuevo, setNuevo] = useState(false)
  const [reintentando, setReintentando] = useState(false)

  const ambiente = servicio?.ambiente

  const cargar = useCallback(async () => {
    if (!ambiente) return
    setCargando(true)
    try {
      const estados = FILTROS.find(f => f.id === filtro)?.estados
      setDocs(await fetchDocumentos({ tipos: [tipo], ambiente, estados, buscar }))
    } catch {
      toast.error('No se pudo cargar el historial')
    }
    setCargando(false)
  }, [ambiente, tipo, filtro, buscar])

  useEffect(() => {
    const t = setTimeout(cargar, buscar ? 300 : 0)
    return () => clearTimeout(t)
  }, [cargar, buscar])

  // Se guarda el id y no la fila: al recargar, el panel muestra la versión nueva.
  const abierto = docs.find(d => d.id === abiertoId) ?? null

  const resumen = useMemo(() => ({
    aceptados: docs.filter(d => d.status === 'ACCEPTED').length,
    pendientes: docs.filter(d => PENDIENTES.includes(d.status)).length,
    monto: docs.filter(d => d.status === 'ACCEPTED').reduce((s, d) => s + Number(d.monto_total ?? 0), 0),
  }), [docs])

  const reintentar = async (d: DocumentoFiscal) => {
    setReintentando(true)
    try {
      const r = await reintentarDocumento(d.id)
      const desenlace = avisarResultado(r, NOMBRE_CORTO_TIPO[tipo] ?? 'Documento')
      if (desenlace === 'rechazado' || desenlace === 'error') toast.error(r.mensaje ?? 'No se pudo reintentar')
      cargar()
    } catch (e: any) {
      toast.error(e?.message ?? 'No se pudo reintentar')
    }
    setReintentando(false)
  }

  const esNc = tipo === '05'
  const titulo = esNc ? 'Notas de crédito' : 'Sujetos excluidos'
  const nombreUno = esNc ? 'Nota de crédito' : 'Sujeto excluido'
  const branchId = (currentBranch as any)?.id as string | undefined

  return (
    <div className="page-inner">
      <Encabezado
        titulo={titulo}
        subtitulo={esNc
          ? 'Acreditan una parte de un Comprobante de Crédito Fiscal: devoluciones, descuentos posteriores, cobros de más.'
          : 'Compras a personas no inscritas como contribuyentes. CORSA emite el documento por ellas.'}
        servicio={servicio}
        accion={puedeEmitir && (
          <button className="btn btn-primary" onClick={() => setNuevo(true)}
                  disabled={!servicio?.disponible || !branchId}>
            + {esNc ? 'Nueva nota de crédito' : 'Nuevo sujeto excluido'}
          </button>
        )}
      />

      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">Aceptados en el listado</div><div className="kpi-value">{resumen.aceptados}</div></div>
        <div className="kpi-card"><div className="kpi-label">Pendientes</div><div className="kpi-value">{resumen.pendientes}</div></div>
        <div className="kpi-card"><div className="kpi-label">{esNc ? 'Total acreditado' : 'Total pagado'}</div><div className="kpi-value">{dinero(resumen.monto)}</div></div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <div className="filter-pills">
          {FILTROS.map(f => (
            <button key={f.id} className={`filter-pill${filtro === f.id ? ' active' : ''}`}
                    onClick={() => setFiltro(f.id)}>{f.label}</button>
          ))}
        </div>
        <input className="corsa-input" style={{ flex: '1 1 220px' }} value={buscar}
               placeholder={esNc ? 'Número, cliente o NIT…' : 'Número, proveedor o documento…'}
               onChange={e => setBuscar(e.target.value)}/>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <div style={{ flex: '2 1 560px', minWidth: 0, background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {cargando ? (
            <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
          ) : docs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">Sin documentos en este filtro</div>
              <div className="empty-state-sub">Los que se emitan aparecen acá con su estado ante Hacienda.</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="corsa-table">
                <thead>
                  <tr>
                    <th>Número de control</th><th>Fecha</th><th>{esNc ? 'Cliente' : 'Proveedor'}</th>
                    <th>Estado</th><th style={{ textAlign: 'right' }}>{esNc ? 'Acreditado' : 'Total a pagar'}</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map(d => (
                    <tr key={d.id} className={abierto?.id === d.id ? 'selected' : ''} onClick={() => setAbiertoId(d.id)}>
                      <td className="font-mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{d.numero_control}</td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {d.fecha_emision ? formatearFecha(d.fecha_emision) : formatearFecha(d.created_at)}
                      </td>
                      <td className="truncate" style={{ fontSize: 13, maxWidth: 260 }}>{d.contraparte_nombre ?? '—'}</td>
                      <td><EstadoBadge estado={d.status}/></td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{dinero(d.monto_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {abierto && (
          <div className="side-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="panel-section-label">{nombreUno}</div>
              <button className="panel-close" onClick={() => setAbiertoId(null)} aria-label="Cerrar">×</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 700 }}>{abierto.numero_control}</span>
              <EstadoBadge estado={abierto.status}/>
            </div>
            <div>
              <Dato label={esNc ? 'Cliente' : 'Proveedor'} valor={abierto.contraparte_nombre}/>
              <Dato label={esNc ? 'NIT' : 'Documento'} valor={abierto.contraparte_documento} mono/>
              <Dato label="Fecha de emisión" valor={abierto.fecha_emision ? formatearFecha(abierto.fecha_emision) : null}/>
              <Dato label="Monto" valor={dinero(abierto.monto_total)}/>
              {esNc && abierto.documentos_relacionados?.map(r => (
                <Dato key={r.numeroDocumento} label={`CCF del ${formatearFecha(r.fechaEmision)}`} valor={r.numeroDocumento} mono/>
              ))}
              <Dato label="Código de generación" valor={abierto.codigo_generacion} mono/>
              <Dato label="Sello de Hacienda" valor={abierto.sello_recepcion} mono/>
              <Dato label="Creado" valor={formatearFechaHora(abierto.created_at)}/>
              <Dato label="Por" valor={abierto.creado_por}/>
              {abierto.invalidated_at && <Dato label="Invalidado" valor={formatearFechaHora(abierto.invalidated_at)}/>}
              {abierto.attempt_count > 0 && <Dato label="Intentos" valor={abierto.attempt_count}/>}
            </div>
            {abierto.last_error && abierto.status !== 'ACCEPTED' && (
              <div className="alert-banner danger"><div className="alert-body"><div className="alert-desc">{abierto.last_error}</div></div></div>
            )}
            {puedeEmitir && PENDIENTES.includes(abierto.status) && abierto.firmado && (
              <button className="btn btn-primary" style={{ justifyContent: 'center' }}
                      onClick={() => reintentar(abierto)} disabled={reintentando}>
                {reintentando ? 'Reintentando…' : 'Reintentar transmisión'}
              </button>
            )}
            {puedeEmitir && abierto.status === 'ACCEPTED' && (
              <button className="btn btn-ghost" style={{ justifyContent: 'center' }}
                      onClick={() => navigate(`/contabilidad/invalidaciones?documento=${abierto.id}`)}>
                Invalidar este documento
              </button>
            )}
          </div>
        )}
      </div>

      {nuevo && branchId && servicio && (
        <Modal open onClose={() => setNuevo(false)} title={esNc ? 'Nueva nota de crédito' : 'Nuevo sujeto excluido'} maxWidth={860}>
          {esNc ? (
            <FormNotaCredito branchId={branchId} ambiente={servicio.ambiente}
                             onListo={() => { setNuevo(false); cargar() }} onCancelar={() => setNuevo(false)}/>
          ) : (
            <FormSujetoExcluido branchId={branchId}
                                onListo={() => { setNuevo(false); cargar() }} onCancelar={() => setNuevo(false)}/>
          )}
        </Modal>
      )}
    </div>
  )
}

export function NotasCreditoPage() {
  const { hasPermission } = useAuth()
  return hasPermission('screens.accounting') ? <HistorialDocumentos tipo="05"/> : <SinAcceso/>
}

export function SujetosExcluidosPage() {
  const { hasPermission } = useAuth()
  return hasPermission('screens.accounting') ? <HistorialDocumentos tipo="14"/> : <SinAcceso/>
}

// ─── Invalidaciones ──────────────────────────────────────────

export function InvalidacionesPage() {
  const { hasPermission } = useAuth()
  const servicio = useServicioFiscal()
  const [params, setParams] = useSearchParams()
  const puedeEmitir = hasPermission('fiscal.issue')

  const [invalidaciones, setInvalidaciones] = useState<Invalidacion[]>([])
  const [aceptados, setAceptados] = useState<DocumentoFiscal[]>([])
  const [cargando, setCargando] = useState(true)
  const [abierta, setAbierta] = useState<Invalidacion | null>(null)
  const [reintentando, setReintentando] = useState(false)

  // ?documento=<id> llega desde el detalle de un documento: abre el
  // formulario con ese documento ya elegido.
  const documentoInicial = params.get('documento')
  const [nueva, setNueva] = useState(!!documentoInicial)

  const ambiente = servicio?.ambiente

  const cargar = useCallback(async () => {
    if (!ambiente) return
    setCargando(true)
    try {
      const [inv, docs] = await Promise.all([
        fetchInvalidaciones(ambiente),
        fetchDocumentos({ tipos: ['01', '03', '05', '14'], ambiente, estados: ['ACCEPTED'], limite: 500 }),
      ])
      setInvalidaciones(inv)
      setAceptados(docs)
    } catch {
      toast.error('No se pudieron cargar las invalidaciones')
    }
    setCargando(false)
  }, [ambiente])

  useEffect(() => { cargar() }, [cargar])

  const cerrarForm = () => {
    setNueva(false)
    if (documentoInicial) setParams({}, { replace: true })
  }

  const reintentar = async (i: Invalidacion) => {
    setReintentando(true)
    try {
      const r = await reintentarInvalidacion(i.id)
      const desenlace = avisarResultado(r, 'La invalidación')
      if (desenlace === 'rechazado' || desenlace === 'error') toast.error(r.mensaje ?? 'No se pudo reintentar')
      setAbierta(null)
      cargar()
    } catch (e: any) {
      toast.error(e?.message ?? 'No se pudo reintentar')
    }
    setReintentando(false)
  }

  if (!hasPermission('screens.accounting')) return <SinAcceso/>

  return (
    <div className="page-inner">
      <Encabezado
        titulo="Invalidaciones"
        subtitulo="Un documento mal emitido no se borra: se invalida ante Hacienda con un evento firmado. No gasta correlativo."
        servicio={servicio}
        accion={puedeEmitir && (
          <button className="btn btn-primary" onClick={() => setNueva(true)} disabled={!servicio?.disponible}>
            + Nueva invalidación
          </button>
        )}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <div style={{ flex: '2 1 560px', minWidth: 0, background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {cargando ? (
            <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
          ) : invalidaciones.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">Sin invalidaciones</div>
              <div className="empty-state-sub">Se invalida desde acá o desde el detalle de un documento aceptado.</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="corsa-table">
                <thead>
                  <tr><th>Documento</th><th>Tipo</th><th>Motivo</th><th>Fecha</th><th>Estado</th></tr>
                </thead>
                <tbody>
                  {invalidaciones.map(i => (
                    <tr key={i.id} className={abierta?.id === i.id ? 'selected' : ''} onClick={() => setAbierta(i)}>
                      <td className="font-mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                        {i.documento?.numero_control ?? '—'}
                      </td>
                      <td style={{ fontSize: 12.5 }}>{TIPO_ANULACION_ETIQUETA[i.tipo_anulacion]}</td>
                      <td className="truncate" style={{ fontSize: 12.5, maxWidth: 240, color: 'var(--text-secondary)' }}>{i.motivo ?? '—'}</td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{formatearFechaHora(i.created_at)}</td>
                      <td><EstadoBadge estado={i.status}/></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {abierta && (
          <div className="side-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="panel-section-label">Invalidación</div>
              <button className="panel-close" onClick={() => setAbierta(null)} aria-label="Cerrar">×</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 700 }}>{abierta.documento?.numero_control}</span>
              <EstadoBadge estado={abierta.status}/>
            </div>
            <div>
              <Dato label="Documento" valor={abierta.documento ? NOMBRE_TIPO[abierta.documento.dte_type] : null}/>
              <Dato label="Tipo" valor={TIPO_ANULACION_ETIQUETA[abierta.tipo_anulacion]}/>
              <Dato label="Motivo" valor={abierta.motivo}/>
              <Dato label="Reemplazado por" valor={abierta.json_original?.documento?.codigoGeneracionR} mono/>
              <Dato label="Responsable" valor={abierta.json_original?.motivo?.nombreResponsable}/>
              <Dato label="Solicitó" valor={abierta.json_original?.motivo?.nombreSolicita}/>
              <Dato label="Código del evento" valor={abierta.codigo_generacion} mono/>
              <Dato label="Sello de Hacienda" valor={abierta.sello_recepcion} mono/>
              <Dato label="Creada" valor={formatearFechaHora(abierta.created_at)}/>
              <Dato label="Por" valor={abierta.created_by}/>
            </div>
            {abierta.last_error && abierta.status !== 'ACCEPTED' && (
              <div className="alert-banner danger"><div className="alert-body"><div className="alert-desc">{abierta.last_error}</div></div></div>
            )}
            {puedeEmitir && abierta.status === 'RETRY_PENDING' && (
              <button className="btn btn-primary" style={{ justifyContent: 'center' }}
                      onClick={() => reintentar(abierta)} disabled={reintentando}>
                {reintentando ? 'Reintentando…' : 'Reintentar transmisión'}
              </button>
            )}
          </div>
        )}
      </div>

      {nueva && servicio && (
        <Modal open onClose={cerrarForm} title="Invalidar un documento" maxWidth={760}>
          {cargando ? (
            <div className="loading-center"><div className="spinner"/></div>
          ) : (
            <FormInvalidacion
              documentos={aceptados}
              inicial={documentoInicial && aceptados.some(d => d.id === documentoInicial) ? documentoInicial : null}
              onListo={() => { cerrarForm(); cargar() }}
              onCancelar={cerrarForm}
            />
          )}
        </Modal>
      )}
    </div>
  )
}
