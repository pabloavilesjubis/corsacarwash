/**
 * CORSA — carga masiva de vehículos (placas) desde un Excel.
 *
 *   1. elegir el archivo (o bajar la plantilla);
 *   2. elegir a quién van: un cliente de la base o un grupo empresarial (con
 *      un grupo, la columna «Empresa» reparte por miembro y el resto va al
 *      predeterminado); revisar fila por fila;
 *   3. importar y ver el resultado.
 *
 * Sólo la placa es obligatoria: lo demás se carga si viene. Las placas ya
 * registradas o repetidas en el archivo se saltan, nunca se duplican.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import readXlsxFile from 'read-excel-file'
import { useEsMovil } from '../hooks/useEsMovil'
import type { Celda } from '../lib/clientes/cargaMasiva'
import {
  interpretarVehiculos, resolverDestino, type DestinoMiembro, type FilaVehiculo,
} from '../lib/vehiculos/cargaMasiva'
import {
  fetchPlacasExistentes, fetchTamanosVehiculo, insertarVehiculosEnLote, searchCustomers, type CustomerWithStats,
} from '../services/customers.service'
import { cargarMiembros, listarGrupos, nombreMiembro, type GrupoEmpresarial } from '../lib/grupos/grupos'

type Paso = 'archivo' | 'revision' | 'importando' | 'listo'
type Destino = 'cliente' | 'grupo'

const ESTADO: Record<FilaVehiculo['estado'], { label: string; color: string; tint: string }> = {
  nuevo:     { label: 'Se carga',    color: 'var(--color-success-text)', tint: 'var(--color-success-tint)' },
  existe:    { label: 'Ya existe',   color: 'var(--color-warning-text)', tint: 'var(--color-warning-tint)' },
  repetida:  { label: 'Repetida',    color: 'var(--color-warning-text)', tint: 'var(--color-warning-tint)' },
  sin_placa: { label: 'Sin placa',   color: 'var(--color-danger-text)',  tint: 'var(--color-danger-tint)' },
}

const nombreCliente = (c: CustomerWithStats) => c.customer_type === 'individual'
  ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Cliente'
  : c.trade_name || c.legal_name || 'Cliente'

export function CargaMasivaVehiculos({ orgId, onCerrar, onImportado }: {
  orgId: string
  onCerrar: () => void
  onImportado: () => void
}) {
  const esMovil = useEsMovil()
  const [paso, setPaso] = useState<Paso>('archivo')
  const [archivo, setArchivo] = useState('')
  const [leyendo, setLeyendo] = useState(false)
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null)
  const [base, setBase] = useState<FilaVehiculo[]>([])
  const [ignoradas, setIgnoradas] = useState<string[]>([])
  const [conEmpresa, setConEmpresa] = useState(false)

  // Destino
  const [destino, setDestino] = useState<Destino | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState<CustomerWithStats[]>([])
  const [cliente, setCliente] = useState<DestinoMiembro | null>(null)
  const [grupos, setGrupos] = useState<GrupoEmpresarial[]>([])
  const [grupoId, setGrupoId] = useState('')
  const [miembros, setMiembros] = useState<DestinoMiembro[]>([])
  const [predeterminado, setPredeterminado] = useState('')

  const [avance, setAvance] = useState(0)
  const [resultado, setResultado] = useState<{ creados: number; fallidos: { fila: number; error: string }[] } | null>(null)

  const leer = async (file: File) => {
    setLeyendo(true); setErrorArchivo(null); setArchivo(file.name)
    try {
      if (!/\.xlsx$/i.test(file.name)) {
        throw new Error('El archivo tiene que ser .xlsx. Si es .xls o .csv, abrilo en Excel y guardalo como «Libro de Excel (.xlsx)».')
      }
      const [hoja, existentes] = await Promise.all([
        readXlsxFile(file) as Promise<Celda[][]>,
        fetchPlacasExistentes(orgId),
      ])
      const r = interpretarVehiculos(hoja, existentes)
      if (r.filas.length === 0) throw new Error('El archivo no tiene filas debajo de los encabezados.')
      setBase(r.filas); setIgnoradas(r.ignoradas); setConEmpresa(r.conEmpresa); setPaso('revision')
    } catch (e) {
      setErrorArchivo(e instanceof Error ? e.message : 'No se pudo leer el archivo')
    }
    setLeyendo(false)
  }

  // Búsqueda de cliente
  useEffect(() => {
    if (destino !== 'cliente' || busqueda.trim().length < 2) { setResultados([]); return }
    let vivo = true
    const t = setTimeout(() => {
      searchCustomers(busqueda.trim()).then(r => { if (vivo) setResultados(r.slice(0, 8)) }).catch(() => {})
    }, 250)
    return () => { vivo = false; clearTimeout(t) }
  }, [busqueda, destino])

  // Grupos y sus miembros
  useEffect(() => {
    if (destino !== 'grupo' || grupos.length) return
    listarGrupos().then(setGrupos).catch(() => setGrupos([]))
  }, [destino, grupos.length])
  useEffect(() => {
    if (!grupoId) { setMiembros([]); setPredeterminado(''); return }
    let vivo = true
    cargarMiembros(grupoId).then(ms => {
      if (!vivo) return
      const lista = ms.map(m => ({ id: m.id, nombre: nombreMiembro(m), nit: m.nit, dui: m.dui }))
      setMiembros(lista)
      setPredeterminado(lista[0]?.id ?? '')
    }).catch(() => { if (vivo) setMiembros([]) })
    return () => { vivo = false }
  }, [grupoId])

  const filas = useMemo(() => {
    if (destino === 'cliente') return resolverDestino(base, cliente ? [cliente] : [], cliente)
    if (destino === 'grupo') return resolverDestino(base, miembros, miembros.find(m => m.id === predeterminado) ?? null)
    return base
  }, [base, destino, cliente, miembros, predeterminado])

  const aCargar = filas.filter(f => f.estado === 'nuevo' && f.clienteId)
  const cuenta = {
    nuevo: filas.filter(f => f.estado === 'nuevo').length,
    saltadas: filas.filter(f => f.estado === 'existe' || f.estado === 'repetida').length,
    sinPlaca: filas.filter(f => f.estado === 'sin_placa').length,
  }
  const destinoListo = destino === 'cliente' ? !!cliente : destino === 'grupo' ? !!predeterminado : false

  const importar = async () => {
    setPaso('importando'); setAvance(0)
    try {
      const tamanos = await fetchTamanosVehiculo(orgId)
      const tipo = (t: string) => tamanos.find(x => x.tamano === t)?.id ?? tamanos[0]?.id
      if (!tamanos.length) throw new Error('No hay tamaños de vehículo configurados')
      const r = await insertarVehiculosEnLote(orgId, aCargar.map(f => ({
        fila: f.fila, customer_id: f.clienteId!, plate: f.placa, brand: f.marca, model: f.modelo,
        color: f.color, year: f.anio, vehicle_type_id: tipo(f.tamano)!,
      })), setAvance)
      setResultado(r)
      if (r.creados > 0) onImportado()
    } catch (e) {
      setResultado({ creados: 0, fallidos: [{ fila: 0, error: e instanceof Error ? e.message : String(e) }] })
    }
    setPaso('listo')
  }

  const cerrable = paso !== 'importando'

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: esMovil ? 10 : 20 }}
      onClick={e => { if (e.target === e.currentTarget && cerrable) onCerrar() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: paso === 'archivo' ? 560 : 1000, maxHeight: '92vh', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>Carga masiva de vehículos</div>
            {archivo && paso !== 'archivo' && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{archivo}</div>}
          </div>
          {cerrable && <button onClick={onCerrar} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {paso === 'archivo' && (<>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              Subí un Excel (.xlsx) con una fila de encabezados y un vehículo por fila.
              Sólo la <strong style={{ color: 'var(--text-primary)' }}>Placa</strong> es obligatoria; también se leen
              Marca, Modelo, Color, Año, Tamaño (S, M o L) y, para grupos, Empresa (NIT o nombre).
              Lo que falte se deja vacío y el carro se carga igual. Después de elegir el archivo
              decidís si van a un cliente o a un grupo empresarial.
            </div>
            <label style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
              border: '2px dashed var(--border)', borderRadius: 14, padding: '28px 16px', cursor: leyendo ? 'wait' : 'pointer',
              background: 'var(--subtle-bg)', textAlign: 'center',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.8" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{leyendo ? 'Leyendo…' : 'Elegir archivo .xlsx'}</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>No se guarda nada hasta que confirmes</span>
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style={{ display: 'none' }}
                disabled={leyendo}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) leer(f) }}/>
            </label>
            {errorArchivo && (
              <div style={{ fontSize: 13, color: 'var(--color-danger-text)', background: 'var(--color-danger-tint)', padding: '10px 12px', borderRadius: 10 }}>{errorArchivo}</div>
            )}
            <a href="/plantillas/vehiculos.xlsx" download style={{ fontSize: 13, alignSelf: 'flex-start' }}>Descargar plantilla de ejemplo</a>
          </>)}

          {paso === 'revision' && (<>
            {/* ¿A quién van? */}
            <section style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>¿A quién se cargan estos {base.length} vehículos?</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {([
                  ['cliente', 'Un cliente de la base', 'Todos los carros a un cliente'],
                  ['grupo', 'Un grupo empresarial', conEmpresa ? 'Se reparten por la columna Empresa' : 'Al miembro que elijas'],
                ] as [Destino, string, string][]).map(([id, l, sub]) => (
                  <button key={id} type="button" id={`destino-${id}`} onClick={() => setDestino(id)}
                    style={{ textAlign: 'left', padding: '9px 12px', borderRadius: 10, cursor: 'pointer', color: 'var(--text-primary)',
                             border: `1.5px solid ${destino === id ? 'var(--corsa-green)' : 'var(--border)'}`,
                             background: destino === id ? 'var(--subtle-bg)' : 'var(--surface)' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{l}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{sub}</div>
                  </button>
                ))}
              </div>

              {destino === 'cliente' && (
                cliente ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                    <span>Se cargan a <strong>{cliente.nombre}</strong></span>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setCliente(null); setBusqueda('') }}>Cambiar</button>
                  </div>
                ) : (
                  <div style={{ position: 'relative' }}>
                    <input className="corsa-input" placeholder="Buscar cliente por nombre, NIT, DUI o placa…" value={busqueda}
                           onChange={e => setBusqueda(e.target.value)} autoFocus/>
                    {resultados.length > 0 && (
                      <div style={{ border: '1px solid var(--border)', borderRadius: 10, marginTop: 4, overflow: 'hidden' }}>
                        {resultados.map(c => (
                          <button key={c.id} type="button" onClick={() => setCliente({ id: c.id, nombre: nombreCliente(c), nit: c.nit, dui: c.dui })}
                            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', borderBottom: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', fontSize: 13, color: 'var(--text-primary)' }}>
                            <strong>{nombreCliente(c)}</strong>
                            <span style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>{c.nit ? `NIT ${c.nit}` : c.dui ? `DUI ${c.dui}` : ''}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              )}

              {destino === 'grupo' && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <label className="ficha-campo" style={{ flex: '1 1 220px' }}>
                    <span>Grupo empresarial</span>
                    <select className="corsa-input" value={grupoId} onChange={e => setGrupoId(e.target.value)}>
                      <option value="">Elegí el grupo…</option>
                      {grupos.map(g => <option key={g.id} value={g.id}>{g.name} ({g.miembros})</option>)}
                    </select>
                  </label>
                  {grupoId && (
                    <label className="ficha-campo" style={{ flex: '1 1 220px' }}>
                      <span>{conEmpresa ? 'Si la fila no dice Empresa, va a' : 'Se cargan a'}</span>
                      <select className="corsa-input" value={predeterminado} onChange={e => setPredeterminado(e.target.value)}>
                        {miembros.length === 0 && <option value="">El grupo no tiene miembros</option>}
                        {miembros.map(m => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </section>

            <div style={{ display: 'flex', gap: 14, fontSize: 12.5, flexWrap: 'wrap' }}>
              <span><strong style={{ color: 'var(--color-success-text)' }}>{cuenta.nuevo}</strong> se cargan</span>
              <span><strong style={{ color: 'var(--color-warning-text)' }}>{cuenta.saltadas}</strong> ya existen o se repiten (se saltan)</span>
              <span><strong style={{ color: 'var(--color-danger-text)' }}>{cuenta.sinPlaca}</strong> sin placa (no se cargan)</span>
              {ignoradas.length > 0 && <span style={{ color: 'var(--text-secondary)' }}>Columnas ignoradas: {ignoradas.join(', ')}</span>}
            </div>

            <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'auto' }}>
              <table className="corsa-table ventas-tabla" style={{ border: 'none' }}>
                <thead><tr>
                  <th>Fila</th><th>Placa</th><th>Marca / modelo</th><th>Color</th><th>Año</th><th>Tam.</th>
                  <th>Va a</th><th>Estado</th><th>Observaciones</th>
                </tr></thead>
                <tbody>
                  {filas.map(f => {
                    const e = ESTADO[f.estado]
                    return (
                      <tr key={f.fila}>
                        <td style={{ color: 'var(--text-secondary)' }}>{f.fila}</td>
                        <td className="font-mono" style={{ fontWeight: 700 }}>{f.placa || '—'}</td>
                        <td>{[f.marca, f.modelo].filter(Boolean).join(' ') || '—'}</td>
                        <td>{f.color ?? '—'}</td>
                        <td>{f.anio ?? '—'}</td>
                        <td style={{ fontWeight: 700 }}>{f.tamano}</td>
                        <td className="cliente" title={f.clienteNombre ?? ''}>{f.estado === 'nuevo' ? (f.clienteNombre ?? <span style={{ color: 'var(--text-secondary)' }}>elegí el destino</span>) : '—'}</td>
                        <td><span className="badge" style={{ color: e.color, background: e.tint }}>{e.label}</span></td>
                        <td className="envuelve" style={{ fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 180 }}>{f.avisos.join(' · ') || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>)}

          {paso === 'importando' && (
            <div style={{ padding: '30px 0', textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Cargando {avance} de {aCargar.length}…</div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden', maxWidth: 420, margin: '0 auto' }}>
                <div style={{ height: '100%', width: `${aCargar.length ? (avance / aCargar.length) * 100 : 0}%`, background: 'var(--corsa-green)', transition: 'width 0.2s' }}/>
              </div>
            </div>
          )}

          {paso === 'listo' && resultado && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 15 }}>
                <strong>{resultado.creados}</strong> vehículos cargados
                {resultado.fallidos.length > 0 && <> · <strong style={{ color: 'var(--color-danger-text)' }}>{resultado.fallidos.length}</strong> no se pudieron guardar</>}.
              </div>
              {resultado.fallidos.length > 0 && (
                <div style={{ fontSize: 12.5, background: 'var(--color-danger-tint)', color: 'var(--color-danger-text)', padding: '10px 12px', borderRadius: 10 }}>
                  {resultado.fallidos.map((f, i) => <div key={i}>{f.fila ? `Fila ${f.fila}: ` : ''}{f.error}</div>)}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0 }}>
          {paso === 'revision' && (<>
            <button className="btn btn-ghost btn-sm" onClick={() => { setPaso('archivo'); setBase([]) }}>Elegir otro archivo</button>
            <button id="vehiculos-importar" className="btn btn-primary btn-sm" onClick={importar} disabled={!destinoListo || aCargar.length === 0}>
              {!destino ? 'Elegí a quién van' : !destinoListo ? 'Elegí el destino' : `Cargar ${aCargar.length} ${aCargar.length === 1 ? 'vehículo' : 'vehículos'}`}
            </button>
          </>)}
          {(paso === 'archivo' || paso === 'listo') && (
            <button className="btn btn-ghost btn-sm" onClick={onCerrar}>{paso === 'listo' ? 'Cerrar' : 'Cancelar'}</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
