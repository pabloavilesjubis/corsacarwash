/**
 * CORSA Carwash — Correlativos fiscales
 *
 * Acá se dice en qué número va cada secuencia ANTES de emitir el primer
 * documento. Es la fuente de inicio de la numeración ante Hacienda:
 *
 *   - Si CORSA nunca emitió ese tipo de documento, se siembra en 0 y el
 *     primero sale con el 1.
 *   - Si ya emitió con otro sistema, se siembra con el ÚLTIMO número que
 *     emitió ese sistema, y el primero de CORSA sale con el siguiente.
 *
 * Sólo sube. Bajar entregaría otra vez números que ya salieron —un
 * numeroControl duplicado ante Hacienda— y la base lo rechaza.
 *
 * Pruebas y producción son secuencias distintas: lo que se gaste probando
 * contra el sandbox no mueve la de producción.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import { Modal } from '../../components/ui/Modal'
import { formatearFechaHora } from '../../utils/fecha'
import {
  fetchConfigFiscal, fetchCorrelativos, sembrarCorrelativo, proximoNumeroControl,
  NOMBRE_TIPO, type Ambiente, type ConfigFiscal, type Correlativo, type TipoDte,
} from '../../services/fiscal.service'
import { AmbienteBadge, Campo, Encabezado, Fila } from './comunes'
import { useServicioFiscal } from './logica'

const TIPOS: TipoDte[] = ['01', '03', '05', '14']
const AMBIENTES: Ambiente[] = ['01', '00']

export function CorrelativosPage() {
  const { hasPermission, accessibleBranches } = useAuth()
  const servicio = useServicioFiscal()
  const puedeSembrar = hasPermission('fiscal.seed')

  const [configs, setConfigs] = useState<ConfigFiscal[]>([])
  const [correlativos, setCorrelativos] = useState<Correlativo[]>([])
  const [cargando, setCargando] = useState(true)
  const [sembrando, setSembrando] = useState<{ config: ConfigFiscal; ambiente: Ambiente; tipo: TipoDte } | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const [c, k] = await Promise.all([fetchConfigFiscal(), fetchCorrelativos()])
      setConfigs(c.filter(x => x.activo))
      setCorrelativos(k)
    } catch {
      toast.error('No se pudieron cargar los correlativos')
    }
    setCargando(false)
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const nombreSucursal = (branchId: string) =>
    (accessibleBranches.find(b => b.id === branchId) as any)?.name ?? 'Sucursal'

  const buscar = (c: ConfigFiscal, ambiente: Ambiente, tipo: TipoDte) =>
    correlativos.find(k => k.ambiente === ambiente && k.dte_type === tipo &&
      k.establishment_code === c.cod_estable && k.pos_code === c.cod_punto_venta)

  if (!hasPermission('screens.accounting')) {
    return (
      <div className="page-inner">
        <div className="empty-state"><div className="empty-state-title">No tenés acceso a Contabilidad</div></div>
      </div>
    )
  }

  return (
    <div className="page-inner">
      <Encabezado
        titulo="Correlativos"
        subtitulo="El punto de arranque de cada secuencia fiscal. Se siembra una vez, antes del primer documento, y sólo puede subir."
        servicio={servicio}
      />

      <div className="alert-banner warning">
        <div className="alert-body">
          <div className="alert-title">Antes de pasar a producción</div>
          <div className="alert-desc">
            Sembrá cada tipo en el ambiente de <strong>Producción</strong> con el último número que emitió el sistema
            anterior para ese tipo, o en 0 si nunca se emitió. Un número equivocado no se puede bajar después: revisalo
            contra el último documento sellado por Hacienda.
          </div>
        </div>
      </div>

      {cargando ? (
        <div className="loading-center"><div className="spinner"/><span>Cargando…</span></div>
      ) : configs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">Ninguna sucursal tiene configuración fiscal</div>
          <div className="empty-state-sub">
            Hay que cargar los datos del emisor (NIT, NRC, códigos de establecimiento y punto de venta del portal del MH)
            en fiscal_issuer_config antes de sembrar.
          </div>
        </div>
      ) : configs.map(c => (
        <div key={c.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card-header" style={{ marginBottom: 0 }}>
            <div>
              <div className="card-title">{nombreSucursal(c.branch_id)}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                {c.nombre} · NIT {c.nit} · Establecimiento <span className="font-mono">{c.cod_estable}</span> ·
                Punto de venta <span className="font-mono">{c.cod_punto_venta}</span>
              </div>
            </div>
          </div>
          {!c.telefono && (
            <div className="alert-banner danger">
              <div className="alert-body"><div className="alert-desc">
                Esta sucursal no tiene teléfono en su configuración fiscal. La Nota de Crédito y el Sujeto Excluido lo
                exigen: sin él, Hacienda los rechaza.
              </div></div>
            </div>
          )}
          <div className="table-wrap">
            <table className="corsa-table">
              <thead>
                <tr>
                  <th>Documento</th>
                  {AMBIENTES.map(a => <th key={a}><AmbienteBadge ambiente={a}/></th>)}
                </tr>
              </thead>
              <tbody>
                {TIPOS.map(t => (
                  <tr key={t} style={{ cursor: 'default' }}>
                    <td style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 600 }}>{NOMBRE_TIPO[t]}</div>
                      <div className="font-mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>DTE {t}</div>
                    </td>
                    {AMBIENTES.map(a => {
                      const k = buscar(c, a, t)
                      return (
                        <td key={a} style={{ fontSize: 12.5, verticalAlign: 'top' }}>
                          {k?.seeded ? (
                            <>
                              <div>Último emitido: <strong className="font-mono">{k.last_minted}</strong></div>
                              <div className="font-mono" style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
                                Próximo: {proximoNumeroControl(t, c.cod_estable, c.cod_punto_venta, k.last_minted)}
                              </div>
                              {k.seeded_by && (
                                <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>
                                  Sembrado por {k.seeded_by}{k.seeded_at ? ` · ${formatearFechaHora(k.seeded_at)}` : ''}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="badge badge-warning">Sin sembrar — no se puede emitir</span>
                          )}
                          {puedeSembrar && (
                            <div style={{ marginTop: 6 }}>
                              <button className="btn btn-ghost" style={{ padding: '5px 12px', fontSize: 12.5 }}
                                      onClick={() => setSembrando({ config: c, ambiente: a, tipo: t })}>
                                {k?.seeded ? 'Ajustar' : 'Sembrar'}
                              </button>
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {sembrando && (
        <Modal open onClose={() => setSembrando(null)} title="Sembrar correlativo" maxWidth={520}>
          <FormSembrar
            {...sembrando}
            actual={buscar(sembrando.config, sembrando.ambiente, sembrando.tipo) ?? null}
            onListo={() => { setSembrando(null); cargar() }}
            onCancelar={() => setSembrando(null)}
          />
        </Modal>
      )}
    </div>
  )
}

function FormSembrar({ config, ambiente, tipo, actual, onListo, onCancelar }: {
  config: ConfigFiscal
  ambiente: Ambiente
  tipo: TipoDte
  actual: Correlativo | null
  onListo: () => void
  onCancelar: () => void
}) {
  const [valor, setValor] = useState('')
  const [confirmacion, setConfirmacion] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const numero = /^\d{1,15}$/.test(valor) ? Number(valor) : null
  const minimo = actual?.seeded ? actual.last_minted : 0

  const problema = useMemo(() => {
    if (numero === null) return 'Escribí el último número emitido (0 si nunca se emitió este tipo)'
    if (numero < minimo) return `La secuencia ya va en ${minimo}: sólo puede subir`
    if (confirmacion !== valor) return 'Escribí el mismo número en la confirmación'
    return null
  }, [numero, minimo, confirmacion, valor])

  const sembrar = async () => {
    if (problema || numero === null) { setError(problema); return }
    setEnviando(true)
    setError(null)
    try {
      await sembrarCorrelativo({ branchId: config.branch_id, ambiente, tipo, ultimoEmitido: numero })
      toast.success(`Secuencia sembrada: el próximo será el ${numero + 1}`)
      onListo()
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo sembrar')
    }
    setEnviando(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
        <strong>{NOMBRE_TIPO[tipo]}</strong> · <AmbienteBadge ambiente={ambiente}/>
        <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
          Establecimiento {config.cod_estable} · Punto de venta {config.cod_punto_venta}
          {actual?.seeded && <> · Hoy va en <strong>{actual.last_minted}</strong></>}
        </div>
      </div>

      {ambiente === '01' && (
        <div className="alert-banner warning">
          <div className="alert-body"><div className="alert-desc">
            Esto fija la numeración real ante Hacienda y no se puede bajar después. Verificalo contra el último
            documento de este tipo que tenga sello de Hacienda.
          </div></div>
        </div>
      )}

      <Fila>
        <Campo label="Último número emitido" ancho="1 1 180px">
          <input className="corsa-input font-mono" value={valor} inputMode="numeric"
                 onChange={e => setValor(e.target.value.replace(/\D/g, ''))}/>
        </Campo>
        <Campo label="Confirmá el número" ancho="1 1 180px">
          <input className="corsa-input font-mono" value={confirmacion} inputMode="numeric"
                 onPaste={e => e.preventDefault()}
                 onChange={e => setConfirmacion(e.target.value.replace(/\D/g, ''))}/>
        </Campo>
      </Fila>

      {numero !== null && (
        <div style={{ background: 'var(--subtle-bg)', borderRadius: 12, padding: '10px 14px', fontSize: 13 }}>
          El próximo documento será{' '}
          <strong className="font-mono">{proximoNumeroControl(tipo, config.cod_estable, config.cod_punto_venta, numero)}</strong>
        </div>
      )}

      {error && (
        <div className="alert-banner danger"><div className="alert-body"><div className="alert-desc">{error}</div></div></div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn btn-ghost" onClick={onCancelar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-primary" onClick={sembrar} disabled={enviando || !!problema}>
          {enviando ? 'Sembrando…' : 'Sembrar'}
        </button>
      </div>
    </div>
  )
}
