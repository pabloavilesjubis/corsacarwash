/**
 * CORSA Carwash — nueva Nota de Crédito (DTE 05).
 *
 * Acredita una PARTE de uno o más CCF: una devolución, un descuento después
 * de la venta, un cobro de más. Una Factura de Consumidor Final no se acredita
 * —se invalida—, por eso acá sólo se relacionan CCF.
 *
 * El CCF puede ser nuestro (sale de la lista, y el servicio fiscal verifica
 * que esté aceptado y sea del mismo cliente) o de antes de CORSA —del sistema
 * anterior o en papel—: ése se escribe a mano y no hay contra qué verificarlo.
 *
 * Los precios van SIN IVA, como en el CCF. El IVA se suma aparte sobre lo
 * gravado.
 */

import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { SearchSelect } from '../../components/ui/SearchSelect'
import { ACTIVIDADES_ECONOMICAS, MH_PATTERNS, onlyDigits } from '../../lib/mh-catalogs'
import { searchCustomers } from '../../services/customers.service'
import {
  emitirNotaCredito, fetchDocumentos, ErrorFiscal,
  type Ambiente, type Direccion, type DocumentoFiscal,
} from '../../services/fiscal.service'
import { formatearFecha } from '../../utils/fecha'
import { Campo, CamposDireccion, Fila, Seccion } from './comunes'
import { avisarResultado, nuevaLlave } from './logica'
import { Total } from './FormSujetoExcluido'

interface Receptor {
  nit: string; nrc: string; nombre: string; nombreComercial: string
  codActividad: string; direccion: Direccion; telefono: string; correo: string
}

interface Relacionado {
  tipoGeneracion: 1 | 2
  numeroDocumento: string
  fechaEmision: string
}

interface Linea {
  descripcion: string; cantidad: string; precioUni: string
  numeroDocumento: string; tipoVenta: 'gravada' | 'exenta' | 'nosujeta'
}

const receptorVacio: Receptor = {
  nit: '', nrc: '', nombre: '', nombreComercial: '', codActividad: '',
  direccion: { departamento: '', municipio: '', complemento: '' }, telefono: '', correo: '',
}

const UUID = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/
const centavos = (v: string) => Math.round((Number(v) || 0) * 100)

export function FormNotaCredito({ branchId, ambiente, onListo, onCancelar }: {
  branchId: string
  ambiente: Ambiente
  onListo: () => void
  onCancelar: () => void
}) {
  const [llave, setLlave] = useState(nuevaLlave)
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [receptor, setReceptor] = useState<Receptor>(receptorVacio)
  const [relacionados, setRelacionados] = useState<Relacionado[]>([])
  const [lineas, setLineas] = useState<Linea[]>([])
  const [credito, setCredito] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // CCF propios aceptados: los que se pueden acreditar con verificación.
  const [ccfPropios, setCcfPropios] = useState<DocumentoFiscal[]>([])
  useEffect(() => {
    fetchDocumentos({ tipos: ['03'], ambiente, estados: ['ACCEPTED'], limite: 200 })
      .then(setCcfPropios).catch(() => setCcfPropios([]))
  }, [ambiente])

  // Clientes con datos de CCF, para no escribir el receptor a mano.
  const [buscarCliente, setBuscarCliente] = useState('')
  const [clientes, setClientes] = useState<any[]>([])
  useEffect(() => {
    if (buscarCliente.trim().length < 2) { setClientes([]); return }
    const t = setTimeout(() => {
      searchCustomers(buscarCliente, undefined, 20)
        .then(cs => setClientes(cs.filter((c: any) => c.fiscal_document_type === 'ccf')))
        .catch(() => setClientes([]))
    }, 300)
    return () => clearTimeout(t)
  }, [buscarCliente])

  const usarCliente = (c: any) => {
    setCustomerId(c.id)
    setReceptor({
      nit: onlyDigits(c.normalized_nit ?? c.nit),
      nrc: onlyDigits(c.nrc),
      nombre: c.legal_name ?? [c.first_name, c.last_name].filter(Boolean).join(' '),
      nombreComercial: c.trade_name ?? '',
      codActividad: c.cod_actividad ?? '',
      direccion: {
        departamento: c.fiscal_departamento ?? '',
        municipio: c.fiscal_municipio ?? '',
        complemento: c.fiscal_complemento ?? '',
      },
      telefono: onlyDigits(c.normalized_phone ?? c.phone),
      correo: c.billing_email || c.email || '',
    })
    setBuscarCliente('')
    setClientes([])
  }

  const agregarCcfPropio = (id: string) => {
    const d = ccfPropios.find(x => x.id === id)
    if (!d || relacionados.some(r => r.numeroDocumento === d.codigo_generacion)) return
    setRelacionados(rs => [...rs, {
      tipoGeneracion: 2, numeroDocumento: d.codigo_generacion,
      fechaEmision: d.fecha_emision ?? d.created_at.slice(0, 10),
    }])
    if (lineas.length === 0) agregarLinea(d.codigo_generacion)
  }

  const agregarLinea = (numeroDocumento = relacionados[0]?.numeroDocumento ?? '') =>
    setLineas(ls => [...ls, { descripcion: '', cantidad: '1', precioUni: '', numeroDocumento, tipoVenta: 'gravada' }])

  const cambiarRel = (i: number, cambio: Partial<Relacionado>) =>
    setRelacionados(rs => rs.map((r, j) => (j === i ? { ...r, ...cambio } : r)))
  const cambiarLinea = (i: number, cambio: Partial<Linea>) =>
    setLineas(ls => ls.map((l, j) => (j === i ? { ...l, ...cambio } : l)))

  const totales = useMemo(() => {
    const monto = (l: Linea) => Math.round(centavos(l.precioUni) * (Number(l.cantidad) || 0))
    const gravada = lineas.filter(l => l.tipoVenta === 'gravada').reduce((s, l) => s + monto(l), 0)
    const otras = lineas.filter(l => l.tipoVenta !== 'gravada').reduce((s, l) => s + monto(l), 0)
    const iva = Math.round(gravada * 0.13)
    return { subtotal: gravada + otras, iva, total: gravada + otras + iva }
  }, [lineas])

  const problemas = useMemo(() => {
    const p: string[] = []
    if (!MH_PATTERNS.nit.test(receptor.nit)) p.push('El NIT del cliente son 14 dígitos (o 9)')
    if (!MH_PATTERNS.nrc.test(receptor.nrc)) p.push('El NRC del cliente son hasta 8 dígitos')
    if (receptor.nombre.trim().length < 3) p.push('Falta el nombre del cliente')
    if (!receptor.codActividad) p.push('Falta la actividad económica del cliente')
    if (!receptor.direccion.departamento || !receptor.direccion.municipio || !receptor.direccion.complemento.trim()) {
      p.push('Falta la dirección completa del cliente')
    }
    if (!receptor.correo.includes('@')) p.push('Falta el correo del cliente')
    if (relacionados.length === 0) p.push('Agregá el CCF que se acredita')
    relacionados.forEach((r, i) => {
      if (r.tipoGeneracion === 2 && !UUID.test(r.numeroDocumento)) {
        p.push(`El CCF ${i + 1} es electrónico: su número es el código de generación (UUID en mayúsculas)`)
      }
      if (r.tipoGeneracion === 1 && !r.numeroDocumento.trim()) p.push(`Falta el número del CCF ${i + 1}`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.fechaEmision)) p.push(`Falta la fecha del CCF ${i + 1}`)
    })
    if (lineas.length === 0) p.push('Agregá al menos una línea')
    lineas.forEach((l, i) => {
      if (!l.descripcion.trim()) p.push(`La línea ${i + 1} no tiene descripción`)
      if (!(Number(l.cantidad) > 0) || !(Number(l.precioUni) > 0)) p.push(`La línea ${i + 1} no tiene cantidad o precio`)
      if (!relacionados.some(r => r.numeroDocumento === l.numeroDocumento)) {
        p.push(`La línea ${i + 1} no dice de qué CCF sale`)
      }
    })
    return p
  }, [receptor, relacionados, lineas])

  const emitir = async () => {
    if (problemas.length > 0) { setError(problemas[0]!); return }
    setEnviando(true)
    setError(null)
    try {
      const r = await emitirNotaCredito({
        idempotencyKey: llave,
        branchId,
        customerId,
        receptor: {
          nit: receptor.nit, nrc: receptor.nrc, nombre: receptor.nombre.trim(),
          codActividad: receptor.codActividad,
          descActividad: ACTIVIDADES_ECONOMICAS.find(a => a.codigo === receptor.codActividad)?.nombre ?? '',
          nombreComercial: receptor.nombreComercial.trim() || null,
          direccion: { ...receptor.direccion, complemento: receptor.direccion.complemento.trim() },
          telefono: receptor.telefono || null,
          correo: receptor.correo.trim(),
        },
        documentosRelacionados: relacionados.map(r => ({
          tipoDocumento: '03', tipoGeneracion: r.tipoGeneracion,
          numeroDocumento: r.numeroDocumento.trim(), fechaEmision: r.fechaEmision,
        })),
        lineas: lineas.map(l => ({
          descripcion: l.descripcion.trim(), cantidad: Number(l.cantidad), precioUni: Number(l.precioUni),
          numeroDocumento: l.numeroDocumento, tipoVenta: l.tipoVenta,
        })),
        condicionOperacion: credito ? 2 : 1,
      })
      const desenlace = avisarResultado(r, 'Nota de crédito')
      if (desenlace === 'listo' || desenlace === 'pendiente') { onListo(); return }
      if (desenlace === 'rechazado') {
        setLlave(nuevaLlave())
        setError(`Hacienda la rechazó: ${r.mensaje ?? 'sin detalle'}. Corregí los datos y volvé a emitir.`)
      } else {
        setError(`${r.mensaje ?? 'No se pudo emitir.'}${r.numeroControl ? ` El número ${r.numeroControl} quedó reservado: al corregir y volver a emitir se usa el mismo.` : ''}`)
      }
    } catch (e) {
      const err = e as ErrorFiscal
      setError(err.problemas?.length ? `${err.message} — ${err.problemas.map(p => p.campo).join(', ')}` : err.message)
      if (err.codigo === 'SESION_INVALIDA') toast.error(err.message)
    }
    setEnviando(false)
  }

  const etiquetaRel = (numero: string) => {
    const propio = ccfPropios.find(d => d.codigo_generacion === numero)
    return propio ? propio.numero_control : numero.length > 13 ? `${numero.slice(0, 8)}…${numero.slice(-4)}` : numero
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Seccion titulo="Cliente (el mismo del CCF)">
        <div style={{ position: 'relative' }}>
          <input className="corsa-input" style={{ width: '100%' }} value={buscarCliente}
                 placeholder="Buscar un cliente con crédito fiscal para llenar sus datos…"
                 onChange={e => setBuscarCliente(e.target.value)}/>
          {clientes.length > 0 && (
            <div style={{
              position: 'absolute', zIndex: 5, top: '100%', left: 0, right: 0, marginTop: 4,
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
              maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            }}>
              {clientes.map(c => (
                <button key={c.id} onClick={() => usarCliente(c)}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px',
                                 border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent',
                                 cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13 }}>
                  <strong>{c.legal_name ?? `${c.first_name ?? ''} ${c.last_name ?? ''}`}</strong>
                  <span style={{ color: 'var(--text-secondary)' }}> · NIT {c.nit} · NRC {c.nrc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Fila>
          <Campo label="NIT" ancho="1 1 150px">
            <input className="corsa-input" value={receptor.nit} inputMode="numeric"
                   onChange={e => setReceptor({ ...receptor, nit: onlyDigits(e.target.value) })}/>
          </Campo>
          <Campo label="NRC" ancho="1 1 110px">
            <input className="corsa-input" value={receptor.nrc} inputMode="numeric"
                   onChange={e => setReceptor({ ...receptor, nrc: onlyDigits(e.target.value) })}/>
          </Campo>
          <Campo label="Razón social" ancho="3 1 240px">
            <input className="corsa-input" value={receptor.nombre} maxLength={250}
                   onChange={e => setReceptor({ ...receptor, nombre: e.target.value })}/>
          </Campo>
        </Fila>
        <Fila>
          <Campo label="Nombre comercial (opcional)" ancho="1 1 200px">
            <input className="corsa-input" value={receptor.nombreComercial} maxLength={150}
                   onChange={e => setReceptor({ ...receptor, nombreComercial: e.target.value })}/>
          </Campo>
          <Campo label="Actividad económica" ancho="2 1 280px">
            <SearchSelect items={ACTIVIDADES_ECONOMICAS} value={receptor.codActividad}
                          onChange={v => setReceptor({ ...receptor, codActividad: v })}/>
          </Campo>
        </Fila>
        <CamposDireccion valor={receptor.direccion} onChange={d => setReceptor({ ...receptor, direccion: d })}/>
        <Fila>
          <Campo label="Correo" ancho="2 1 220px">
            <input className="corsa-input" type="email" value={receptor.correo} maxLength={100}
                   onChange={e => setReceptor({ ...receptor, correo: e.target.value })}/>
          </Campo>
          <Campo label="Teléfono (opcional)" ancho="1 1 140px">
            <input className="corsa-input" value={receptor.telefono} inputMode="tel"
                   onChange={e => setReceptor({ ...receptor, telefono: onlyDigits(e.target.value) })}/>
          </Campo>
        </Fila>
      </Seccion>

      <Seccion titulo="CCF que se acredita">
        {ccfPropios.length > 0 && (
          <select className="corsa-input" value="" onChange={e => agregarCcfPropio(e.target.value)}>
            <option value="">Agregar un CCF emitido por CORSA…</option>
            {ccfPropios.map(d => (
              <option key={d.id} value={d.id}>
                {d.numero_control} · {d.contraparte_nombre ?? '—'} · {d.fecha_emision ? formatearFecha(d.fecha_emision) : ''}
              </option>
            ))}
          </select>
        )}
        {relacionados.map((r, i) => (
          <Fila key={i}>
            <Campo label={i === 0 ? 'Origen' : ''} ancho="0 1 150px">
              <select className="corsa-input" value={String(r.tipoGeneracion)}
                      onChange={e => cambiarRel(i, { tipoGeneracion: Number(e.target.value) as 1 | 2 })}>
                <option value="2">Electrónico</option>
                <option value="1">Papel</option>
              </select>
            </Campo>
            <Campo label={i === 0 ? (r.tipoGeneracion === 2 ? 'Código de generación' : 'Número impreso') : ''} ancho="3 1 280px">
              <input className="corsa-input font-mono" value={r.numeroDocumento} maxLength={36}
                     onChange={e => {
                       const nuevo = r.tipoGeneracion === 2 ? e.target.value.toUpperCase().trim() : e.target.value
                       // Las líneas que apuntaban a este CCF lo siguen.
                       setLineas(ls => ls.map(l => (l.numeroDocumento === r.numeroDocumento ? { ...l, numeroDocumento: nuevo } : l)))
                       cambiarRel(i, { numeroDocumento: nuevo })
                     }}/>
            </Campo>
            <Campo label={i === 0 ? 'Fecha del CCF' : ''} ancho="0 1 150px">
              <input className="corsa-input" type="date" value={r.fechaEmision}
                     onChange={e => cambiarRel(i, { fechaEmision: e.target.value })}/>
            </Campo>
            <button className="btn btn-ghost" style={{ alignSelf: 'flex-end', padding: '9px 12px' }} aria-label="Quitar CCF"
                    onClick={() => setRelacionados(rs => rs.filter((_, j) => j !== i))}>×</button>
          </Fila>
        ))}
        <div>
          <button className="btn btn-ghost"
                  onClick={() => setRelacionados(rs => [...rs, { tipoGeneracion: 2, numeroDocumento: '', fechaEmision: '' }])}>
            + CCF de antes de CORSA
          </button>
        </div>
      </Seccion>

      <Seccion titulo="Qué se acredita (precios sin IVA)">
        {lineas.map((l, i) => (
          <Fila key={i}>
            <Campo label={i === 0 ? 'Descripción' : ''} ancho="3 1 220px">
              <input className="corsa-input" value={l.descripcion} maxLength={1000}
                     placeholder="Descuento sobre lavado…"
                     onChange={e => cambiarLinea(i, { descripcion: e.target.value })}/>
            </Campo>
            <Campo label={i === 0 ? 'Cant.' : ''} ancho="0 1 70px">
              <input className="corsa-input" value={l.cantidad} inputMode="decimal"
                     onChange={e => cambiarLinea(i, { cantidad: e.target.value })}/>
            </Campo>
            <Campo label={i === 0 ? 'Precio' : ''} ancho="0 1 100px">
              <input className="corsa-input" value={l.precioUni} inputMode="decimal" placeholder="0.00"
                     onChange={e => cambiarLinea(i, { precioUni: e.target.value })}/>
            </Campo>
            <Campo label={i === 0 ? 'Tipo' : ''} ancho="0 1 120px">
              <select className="corsa-input" value={l.tipoVenta}
                      onChange={e => cambiarLinea(i, { tipoVenta: e.target.value as Linea['tipoVenta'] })}>
                <option value="gravada">Gravada</option>
                <option value="exenta">Exenta</option>
                <option value="nosujeta">No sujeta</option>
              </select>
            </Campo>
            <Campo label={i === 0 ? 'Del CCF' : ''} ancho="1 1 170px">
              <select className="corsa-input" value={l.numeroDocumento}
                      onChange={e => cambiarLinea(i, { numeroDocumento: e.target.value })}>
                <option value="">—</option>
                {relacionados.filter(r => r.numeroDocumento).map(r => (
                  <option key={r.numeroDocumento} value={r.numeroDocumento}>{etiquetaRel(r.numeroDocumento)}</option>
                ))}
              </select>
            </Campo>
            <button className="btn btn-ghost" style={{ alignSelf: 'flex-end', padding: '9px 12px' }} aria-label="Quitar línea"
                    onClick={() => setLineas(ls => ls.filter((_, j) => j !== i))}>×</button>
          </Fila>
        ))}
        <Fila>
          <button className="btn btn-ghost" onClick={() => agregarLinea()}>+ Agregar línea</button>
          <Campo label="Condición" ancho="0 1 150px">
            <select className="corsa-input" value={credito ? '2' : '1'} onChange={e => setCredito(e.target.value === '2')}>
              <option value="1">Contado</option>
              <option value="2">Crédito</option>
            </select>
          </Campo>
        </Fila>
      </Seccion>

      <div style={{ background: 'var(--subtle-bg)', borderRadius: 12, padding: '12px 14px', fontSize: 13.5 }}>
        <Total label="Subtotal" valor={totales.subtotal}/>
        <Total label="IVA 13 % (sobre lo gravado)" valor={totales.iva}/>
        <Total label="Total acreditado" valor={totales.total} fuerte/>
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
