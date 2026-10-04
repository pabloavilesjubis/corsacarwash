/**
 * CORSA — carga masiva de clientes desde un Excel.
 *
 * Tres pasos en el mismo modal:
 *   1. elegir el archivo (o bajar la plantilla);
 *   2. revisar: cada fila con lo que se va a guardar, los avisos y los
 *      errores. Nada se escribe todavía;
 *   3. importar las filas nuevas y ver el resultado.
 *
 * Los duplicados y las filas con error no se importan nunca: un cliente que
 * ya existe se corrige en su ficha, no se pisa desde un Excel.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import readXlsxFile from 'read-excel-file'
import { useEsMovil } from '../hooks/useEsMovil'
import { interpretarHoja, type FilaInterpretada, type Celda } from '../lib/clientes/cargaMasiva'
import { fetchClientesParaDuplicados, insertarClientesEnLote } from '../services/customers.service'
import { findDepartamento, findMunicipio } from '../lib/mh-catalogs'

type Paso = 'archivo' | 'revision' | 'importando' | 'listo'
type Filtro = 'todas' | 'nuevo' | 'duplicado' | 'error' | 'avisos'

interface Props {
  orgId: string
  onCerrar: () => void
  /** Se llama al terminar una importación con al menos un cliente creado. */
  onImportado: () => void
}

const ESTADO_ESTILO: Record<FilaInterpretada['estado'], { label: string; color: string; tint: string }> = {
  nuevo:     { label: 'Nuevo',     color: 'var(--color-success-text)', tint: 'var(--color-success-tint)' },
  duplicado: { label: 'Ya existe', color: 'var(--color-warning-text)', tint: 'var(--color-warning-tint)' },
  error:     { label: 'Error',     color: 'var(--color-danger-text)',  tint: 'var(--color-danger-tint)' },
}

export function CargaMasivaClientes({ orgId, onCerrar, onImportado }: Props) {
  const esMovil = useEsMovil()
  const [paso, setPaso] = useState<Paso>('archivo')
  const [archivo, setArchivo] = useState<string>('')
  const [leyendo, setLeyendo] = useState(false)
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null)
  const [filas, setFilas] = useState<FilaInterpretada[]>([])
  const [ignoradas, setIgnoradas] = useState<string[]>([])
  const [filtro, setFiltro] = useState<Filtro>('todas')
  const [avance, setAvance] = useState(0)
  const [resultado, setResultado] = useState<{ creados: number; fallidos: { fila: number; error: string }[] } | null>(null)

  const nuevas = useMemo(() => filas.filter(f => f.estado === 'nuevo' && f.ficha), [filas])
  const cuenta = useMemo(() => ({
    nuevo: filas.filter(f => f.estado === 'nuevo').length,
    duplicado: filas.filter(f => f.estado === 'duplicado').length,
    error: filas.filter(f => f.estado === 'error').length,
    avisos: filas.filter(f => f.avisos.length > 0).length,
    ccf: nuevas.filter(f => f.ficha?.fiscal_document_type === 'ccf').length,
  }), [filas, nuevas])

  const visibles = filas.filter(f =>
    filtro === 'todas' ? true
    : filtro === 'avisos' ? f.avisos.length > 0
    : f.estado === filtro)

  const leer = async (file: File) => {
    setLeyendo(true); setErrorArchivo(null); setArchivo(file.name)
    try {
      if (!/\.xlsx$/i.test(file.name)) {
        throw new Error('El archivo tiene que ser .xlsx. Si es .xls o .csv, abrilo en Excel y guardalo como «Libro de Excel (.xlsx)».')
      }
      const [hoja, existentes] = await Promise.all([
        readXlsxFile(file) as Promise<Celda[][]>,
        fetchClientesParaDuplicados(orgId),
      ])
      const r = interpretarHoja(hoja, existentes)
      if (r.filas.length === 0) throw new Error('El archivo no tiene filas debajo de los encabezados.')
      setFilas(r.filas); setIgnoradas(r.ignoradas); setFiltro('todas'); setPaso('revision')
    } catch (e) {
      setErrorArchivo(e instanceof Error ? e.message : 'No se pudo leer el archivo')
    }
    setLeyendo(false)
  }

  const importar = async () => {
    setPaso('importando'); setAvance(0)
    const r = await insertarClientesEnLote(
      orgId,
      nuevas.map(f => ({ fila: f.fila, ficha: f.ficha! })),
      setAvance,
    ).catch(e => ({ creados: 0, fallidos: [{ fila: 0, error: e instanceof Error ? e.message : String(e) }] }))
    setResultado(r); setPaso('listo')
    if (r.creados > 0) onImportado()
  }

  const cerrable = paso !== 'importando'

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: esMovil ? 10 : 20 }}
      onClick={e => { if (e.target === e.currentTarget && cerrable) onCerrar() }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: paso === 'archivo' ? 560 : 1040, maxHeight: '92vh', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>Carga masiva de clientes</div>
            {archivo && paso !== 'archivo' && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{archivo}</div>}
          </div>
          {cerrable && <button onClick={onCerrar} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {paso === 'archivo' && (<>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              Subí un Excel (.xlsx) con una fila de encabezados y un cliente por fila. Se reconocen estas columnas,
              en cualquier orden: <strong style={{ color: 'var(--text-primary)' }}>Nombre / Razón social</strong> (obligatoria),
              Nombre comercial, NIT, NRC, Documento (DUI), Cód. actividad, Giro, Teléfono, Correo y Dirección.
              Antes de guardar vas a ver qué pasa con cada fila.
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
            <a href="/plantillas/clientes.xlsx" download style={{ fontSize: 13, alignSelf: 'flex-start' }}>Descargar plantilla de ejemplo</a>
          </>)}

          {paso === 'revision' && (<>
            <div style={{ display: 'grid', gridTemplateColumns: esMovil ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 8 }}>
              {[
                { id: 'nuevo' as const, label: 'Se importan', valor: cuenta.nuevo, sub: `${cuenta.ccf} como CCF`, color: 'var(--color-success-text)' },
                { id: 'duplicado' as const, label: 'Ya existen', valor: cuenta.duplicado, sub: 'no se tocan', color: 'var(--color-warning-text)' },
                { id: 'error' as const, label: 'Con error', valor: cuenta.error, sub: 'no se importan', color: 'var(--color-danger-text)' },
                { id: 'avisos' as const, label: 'Con avisos', valor: cuenta.avisos, sub: 'se importan igual', color: 'var(--text-primary)' },
              ].map(k => (
                <button key={k.id} onClick={() => setFiltro(filtro === k.id ? 'todas' : k.id)}
                  style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 12, cursor: 'pointer', background: 'var(--surface)',
                           border: `1.5px solid ${filtro === k.id ? k.color : 'var(--border)'}` }}>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{k.label}</div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, color: k.color, lineHeight: 1.2 }}>{k.valor}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{k.sub}</div>
                </button>
              ))}
            </div>

            {ignoradas.length > 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '8px 12px', borderRadius: 10 }}>
                Columnas que no se reconocieron y se ignoran: {ignoradas.join(', ')}
              </div>
            )}

            <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'auto' }}>
              <table className="corsa-table" style={{ minWidth: 820 }}>
                <thead>
                  <tr>
                    <th style={{ width: 52 }}>Fila</th>
                    <th>Cliente</th>
                    <th>Documentos</th>
                    <th>Contacto</th>
                    <th>Documento fiscal</th>
                    <th>Observaciones</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map(f => {
                    const est = ESTADO_ESTILO[f.estado]
                    const c = f.ficha
                    const depto = c?.fiscal_departamento ? findDepartamento(c.fiscal_departamento)?.nombre : null
                    const muni = c?.fiscal_departamento && c?.fiscal_municipio ? findMunicipio(c.fiscal_departamento, c.fiscal_municipio)?.nombre : null
                    return (
                      <tr key={f.fila} style={{ verticalAlign: 'top' }}>
                        <td style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{f.fila}</td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{f.nombre || '—'}</div>
                          {c && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                            {c.customer_type === 'company' ? 'Empresa' : `Persona · ${c.first_name} / ${c.last_name ?? '—'}`}
                            {c.trade_name ? ` · ${c.trade_name}` : ''}
                          </div>}
                          <span style={{ display: 'inline-block', marginTop: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: est.color, background: est.tint }}>{est.label}</span>
                        </td>
                        <td style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                          {c?.nit && <div>NIT {c.nit}</div>}
                          {c?.nrc && <div>NRC {c.nrc}</div>}
                          {c?.dui && <div>DUI {c.dui}</div>}
                          {!c?.nit && !c?.nrc && !c?.dui && <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {c?.phone && <div>{c.phone}</div>}
                          {c?.email && <div style={{ wordBreak: 'break-all' }}>{c.email}</div>}
                          {!c?.phone && !c?.email && <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {c && <div style={{ fontWeight: 700 }}>{c.fiscal_document_type === 'ccf' ? 'CCF' : 'Ticket'}</div>}
                          {c?.cod_actividad && <div>{c.cod_actividad}{c.desc_actividad ? ` · ${c.desc_actividad}` : ''}</div>}
                          {depto && <div style={{ color: 'var(--text-secondary)' }}>{muni}, {depto}</div>}
                        </td>
                        <td style={{ fontSize: 12, maxWidth: 280 }}>
                          {f.errores.map((e, i) => <div key={'e' + i} style={{ color: 'var(--color-danger-text)', fontWeight: 600 }}>{e}</div>)}
                          {f.avisos.map((a, i) => <div key={'a' + i} style={{ color: 'var(--color-warning-text)' }}>{a}</div>)}
                          {f.errores.length === 0 && f.avisos.length === 0 && <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>)}

          {paso === 'importando' && (
            <div style={{ padding: '30px 0', textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Importando {avance} de {nuevas.length}…</div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden', maxWidth: 420, margin: '0 auto' }}>
                <div style={{ height: '100%', width: `${nuevas.length ? (avance / nuevas.length) * 100 : 0}%`, background: 'var(--corsa-green)', transition: 'width 0.2s' }}/>
              </div>
            </div>
          )}

          {paso === 'listo' && resultado && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 15 }}>
                <strong>{resultado.creados}</strong> clientes importados
                {resultado.fallidos.length > 0 && <> · <strong style={{ color: 'var(--color-danger-text)' }}>{resultado.fallidos.length}</strong> no se pudieron guardar</>}.
              </div>
              {resultado.fallidos.length > 0 && (
                <div style={{ fontSize: 12.5, background: 'var(--color-danger-tint)', color: 'var(--color-danger-text)', padding: '10px 12px', borderRadius: 10 }}>
                  {resultado.fallidos.map(f => <div key={f.fila}>{f.fila ? `Fila ${f.fila}: ` : ''}{f.error}</div>)}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexShrink: 0 }}>
          {paso === 'revision' && (<>
            <button className="btn btn-ghost" onClick={() => { setPaso('archivo'); setFilas([]) }}>Elegir otro archivo</button>
            <div className="clip-btn-wrap" style={{ opacity: nuevas.length ? 1 : 0.5, pointerEvents: nuevas.length ? 'auto' : 'none' }}>
              <div className="clip-btn-corner"/>
              <button className="clip-btn" onClick={importar} disabled={!nuevas.length}>
                Importar {nuevas.length} {nuevas.length === 1 ? 'cliente' : 'clientes'}
              </button>
            </div>
          </>)}
          {(paso === 'archivo' || paso === 'listo') && (
            <button className="btn btn-ghost" onClick={onCerrar}>{paso === 'listo' ? 'Cerrar' : 'Cancelar'}</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
