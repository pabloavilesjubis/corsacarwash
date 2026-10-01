/**
 * CORSA Carwash — nueva Factura de Sujeto Excluido (DTE 14).
 *
 * Es una COMPRA: CORSA le paga a alguien que no está inscrito como
 * contribuyente y emite el documento por él. El caso de todos los días son
 * honorarios a una persona natural, con 10 % de renta retenida.
 *
 * Los totales que se ven acá son una vista previa. Los que valen son los que
 * calcula el servicio fiscal en centavos enteros; si alguna vez difirieran,
 * manda el documento firmado.
 */

import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { SearchSelect } from '../../components/ui/SearchSelect'
import { ACTIVIDADES_ECONOMICAS } from '../../lib/mh-catalogs'
import {
  emitirSujetoExcluido, dinero, ErrorFiscal, type Direccion,
} from '../../services/fiscal.service'
import { Campo, CamposDireccion, Fila, Seccion, SelectTipoDocumento } from './comunes'
import { avisarResultado, nuevaLlave, problemaDeDocumento } from './logica'

interface Linea { descripcion: string; cantidad: string; precioUni: string }

const lineaVacia = (): Linea => ({ descripcion: '', cantidad: '1', precioUni: '' })
const centavos = (v: string) => Math.round((Number(v) || 0) * 100)

export function FormSujetoExcluido({ branchId, onListo, onCancelar }: {
  branchId: string
  onListo: () => void
  onCancelar: () => void
}) {
  // La llave vive mientras el formulario siga abierto: reenviar después de un
  // error de red, o con un dato corregido, reusa el mismo documento.
  const [llave, setLlave] = useState(nuevaLlave)
  const [tipoDoc, setTipoDoc] = useState('13')
  const [numDoc, setNumDoc] = useState('')
  const [nombre, setNombre] = useState('')
  const [actividad, setActividad] = useState('')
  const [direccion, setDireccion] = useState<Direccion>({ departamento: '', municipio: '', complemento: '' })
  const [telefono, setTelefono] = useState('')
  const [correo, setCorreo] = useState('')
  const [lineas, setLineas] = useState<Linea[]>([lineaVacia()])
  const [retenerRenta, setRetenerRenta] = useState(true)
  const [tasaRenta, setTasaRenta] = useState('10')
  const [credito, setCredito] = useState(false)
  const [observaciones, setObservaciones] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totales = useMemo(() => {
    const compra = lineas.reduce((s, l) => s + Math.round(centavos(l.precioUni) * (Number(l.cantidad) || 0)), 0)
    const renta = retenerRenta ? Math.round(compra * (Number(tasaRenta) || 0) / 100) : 0
    return { compra, renta, pagar: compra - renta }
  }, [lineas, retenerRenta, tasaRenta])

  const problemas = useMemo(() => {
    const p: string[] = []
    const doc = problemaDeDocumento(tipoDoc, numDoc)
    if (doc) p.push(doc)
    if (nombre.trim().length < 3) p.push('Falta el nombre del sujeto excluido')
    if (!direccion.departamento || !direccion.municipio || !direccion.complemento.trim()) {
      p.push('Falta la dirección completa (departamento, municipio y dirección)')
    }
    if (telefono && !/^\d{8,30}$/.test(telefono)) p.push('El teléfono va sólo con dígitos, de 8 a 30')
    lineas.forEach((l, i) => {
      if (!l.descripcion.trim()) p.push(`La línea ${i + 1} no tiene descripción`)
      if (!(Number(l.cantidad) > 0)) p.push(`La línea ${i + 1} no tiene cantidad`)
      if (!(Number(l.precioUni) > 0)) p.push(`La línea ${i + 1} no tiene precio`)
    })
    return p
  }, [tipoDoc, numDoc, nombre, direccion, telefono, lineas])

  const emitir = async () => {
    if (problemas.length > 0) { setError(problemas[0]!); return }
    setEnviando(true)
    setError(null)
    try {
      const r = await emitirSujetoExcluido({
        idempotencyKey: llave,
        branchId,
        sujetoExcluido: {
          tipoDocumento: tipoDoc,
          numDocumento: numDoc.trim(),
          nombre: nombre.trim(),
          codActividad: actividad || null,
          descActividad: actividad ? (ACTIVIDADES_ECONOMICAS.find(a => a.codigo === actividad)?.nombre ?? null) : null,
          direccion: { ...direccion, complemento: direccion.complemento.trim() },
          telefono: telefono || null,
          correo: correo.trim() || null,
        },
        lineas: lineas.map(l => ({
          descripcion: l.descripcion.trim(), cantidad: Number(l.cantidad), precioUni: Number(l.precioUni),
        })),
        reglasDeRetencion: retenerRenta ? [{ tipo: 'renta', tasa: (Number(tasaRenta) || 0) / 100 }] : [],
        condicionOperacion: credito ? 2 : 1,
        observaciones: observaciones.trim() || null,
      })
      const desenlace = avisarResultado(r, 'Sujeto excluido')
      if (desenlace === 'listo' || desenlace === 'pendiente') { onListo(); return }
      if (desenlace === 'rechazado') {
        // El número quedó quemado con el rechazo: el próximo intento es otro
        // documento, con otra llave.
        setLlave(nuevaLlave())
        setError(`Hacienda lo rechazó: ${r.mensaje ?? 'sin detalle'}. Corregí los datos y volvé a emitir.`)
      } else {
        // No llegó a firmarse: el número quedó reservado para ESTE formulario.
        // Corregir y volver a emitir reusa ese mismo número.
        setError(`${r.mensaje ?? 'No se pudo emitir.'}${r.numeroControl ? ` El número ${r.numeroControl} quedó reservado: al corregir y volver a emitir se usa el mismo.` : ''}`)
      }
    } catch (e) {
      const err = e as ErrorFiscal
      setError(err.problemas?.length
        ? `${err.message} — ${err.problemas.map(p => p.campo).join(', ')}`
        : err.message)
      if (err.codigo === 'SESION_INVALIDA') toast.error(err.message)
    }
    setEnviando(false)
  }

  const cambiarLinea = (i: number, cambio: Partial<Linea>) =>
    setLineas(ls => ls.map((l, j) => (j === i ? { ...l, ...cambio } : l)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Seccion titulo="Sujeto excluido (a quién se le compra)">
        <Fila>
          <Campo label="Tipo de documento" ancho="0 1 160px">
            <SelectTipoDocumento valor={tipoDoc} onChange={setTipoDoc}/>
          </Campo>
          <Campo label="Número" ancho="1 1 160px">
            <input className="corsa-input" value={numDoc} maxLength={20}
                   onChange={e => setNumDoc(e.target.value.replace(/[\s-]/g, ''))}/>
          </Campo>
          <Campo label="Nombre completo" ancho="2 1 240px">
            <input className="corsa-input" value={nombre} maxLength={250}
                   onChange={e => setNombre(e.target.value)}/>
          </Campo>
        </Fila>
        <CamposDireccion valor={direccion} onChange={setDireccion}/>
        <Fila>
          <Campo label="Teléfono (opcional)" ancho="1 1 140px">
            <input className="corsa-input" value={telefono} inputMode="tel"
                   onChange={e => setTelefono(e.target.value.replace(/\D/g, ''))}/>
          </Campo>
          <Campo label="Correo (opcional)" ancho="1 1 200px">
            <input className="corsa-input" type="email" value={correo} maxLength={100}
                   onChange={e => setCorreo(e.target.value)}/>
          </Campo>
          <Campo label="Actividad económica (opcional)" ancho="2 1 260px">
            <SearchSelect items={ACTIVIDADES_ECONOMICAS} value={actividad} onChange={setActividad}/>
          </Campo>
        </Fila>
      </Seccion>

      <Seccion titulo="Qué se compra">
        {lineas.map((l, i) => (
          <Fila key={i}>
            <Campo label={i === 0 ? 'Descripción' : ''} ancho="3 1 260px">
              <input className="corsa-input" value={l.descripcion} maxLength={1000}
                     placeholder="Honorarios por servicios profesionales…"
                     onChange={e => cambiarLinea(i, { descripcion: e.target.value })}/>
            </Campo>
            <Campo label={i === 0 ? 'Cantidad' : ''} ancho="0 1 90px">
              <input className="corsa-input" value={l.cantidad} inputMode="decimal"
                     onChange={e => cambiarLinea(i, { cantidad: e.target.value })}/>
            </Campo>
            <Campo label={i === 0 ? 'Precio unitario' : ''} ancho="0 1 120px">
              <input className="corsa-input" value={l.precioUni} inputMode="decimal" placeholder="0.00"
                     onChange={e => cambiarLinea(i, { precioUni: e.target.value })}/>
            </Campo>
            {lineas.length > 1 && (
              <button className="btn btn-ghost" style={{ alignSelf: 'flex-end', padding: '9px 12px' }}
                      onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))} aria-label="Quitar línea">×</button>
            )}
          </Fila>
        ))}
        <div>
          <button className="btn btn-ghost" onClick={() => setLineas(ls => [...ls, lineaVacia()])}>+ Agregar línea</button>
        </div>
      </Seccion>

      <Seccion titulo="Retención y pago">
        <Fila>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, flex: '1 1 260px' }}>
            <input type="checkbox" checked={retenerRenta} onChange={e => setRetenerRenta(e.target.checked)}
                   style={{ accentColor: 'var(--corsa-green)' }}/>
            Retener renta
            {retenerRenta && (
              <>
                <input className="corsa-input" style={{ width: 70 }} value={tasaRenta} inputMode="decimal"
                       onChange={e => setTasaRenta(e.target.value)}/>
                <span>%</span>
              </>
            )}
          </label>
          <Campo label="Condición" ancho="0 1 160px">
            <select className="corsa-input" value={credito ? '2' : '1'} onChange={e => setCredito(e.target.value === '2')}>
              <option value="1">Contado</option>
              <option value="2">Crédito</option>
            </select>
          </Campo>
        </Fila>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
          Honorarios a una persona natural: 10 % de renta. Confirmá la tasa con contabilidad si el servicio es otro.
        </div>
        <Campo label="Observaciones (opcional)" ancho="1 1 100%">
          <input className="corsa-input" value={observaciones} maxLength={3000}
                 onChange={e => setObservaciones(e.target.value)}/>
        </Campo>
      </Seccion>

      <div style={{ background: 'var(--subtle-bg)', borderRadius: 12, padding: '12px 14px', fontSize: 13.5 }}>
        <Total label="Compra" valor={totales.compra}/>
        {totales.renta > 0 && <Total label={`Retención de renta (${tasaRenta} %)`} valor={-totales.renta}/>}
        <Total label="Total a pagar" valor={totales.pagar} fuerte/>
      </div>

      {error && (
        <div className="alert-banner danger"><div className="alert-body"><div className="alert-desc">{error}</div></div></div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn btn-ghost" onClick={onCancelar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-primary" onClick={emitir} disabled={enviando}>
          {enviando ? 'Emitiendo…' : 'Emitir y transmitir a Hacienda'}
        </button>
      </div>
    </div>
  )
}

export function Total({ label, valor, fuerte }: { label: string; valor: number; fuerte?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontWeight: fuerte ? 700 : 400 }}>
      <span>{label}</span>
      <span className="font-mono">{valor < 0 ? '−' : ''}{dinero(Math.abs(valor) / 100)}</span>
    </div>
  )
}
