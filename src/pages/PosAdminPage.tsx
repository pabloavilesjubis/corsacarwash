/**
 * CORSA Carwash — POS Administrativo
 *
 * Venta de cupones prepagados. Separado del POS de caja a propósito: el cajero
 * puede canjear cupones pero no emitirlos, porque emitirlos es cobrar por
 * adelantado un servicio que todavía no se prestó.
 *
 * La venta sigue la misma lógica fiscal que una venta normal (FCF o CCF), ya
 * que el ingreso se realiza el día del cobro.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { sellVouchers, fetchBatchVouchers, type SellVouchersResult } from '../services/vouchers.service'
import { printVouchers } from '../lib/vouchers/voucherDocument'
import { ccfReceptorStatus, preferredDocType } from '../lib/fiscal/receptor'

const SERVICIOS = [
  { code: 'PRO', name: 'PRO', prices: { S: 9, M: 11, L: 12 } },
  { code: 'ELITE', name: 'ÉLITE', prices: { S: 12, M: 14, L: 15 } },
  { code: 'SIGNATURE', name: 'SIGNATURE', prices: { S: 15, M: 17, L: 18 } },
] as const
const TAMANOS = ['S', 'M', 'L'] as const
const ASPIRADO_LISTA = 3

interface Cliente {
  id: string
  customer_type: string
  first_name: string | null
  last_name: string | null
  trade_name: string | null
  legal_name: string | null
  nit: string | null
  nrc: string | null
  dui: string | null
  email: string | null
  phone: string | null
  fiscal_document_type: string | null
  cod_actividad: string | null
  desc_actividad: string | null
  fiscal_departamento: string | null
  fiscal_municipio: string | null
  fiscal_complemento: string | null
  billing_email: string | null
}

function nombreCliente(c: Cliente): string {
  if (c.customer_type === 'company') return c.legal_name || c.trade_name || '—'
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
}

function money(n: number) { return 'US$' + (Number(n) || 0).toFixed(2) }

export function PosAdminPage() {
  const { currentBranch, hasPermission } = useAuth()
  const branchId = (currentBranch as any)?.id ?? null
  const puedeVender = hasPermission('vouchers.sell')

  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState<Cliente[]>([])
  const [cliente, setCliente] = useState<Cliente | null>(null)

  const [servicio, setServicio] = useState<string>('ELITE')
  const [tamano, setTamano] = useState<'S' | 'M' | 'L'>('M')
  const [cantidad, setCantidad] = useState('10')
  const [precioServicio, setPrecioServicio] = useState('14.00')
  const [conAspirado, setConAspirado] = useState(false)
  const [precioAspirado, setPrecioAspirado] = useState(String(ASPIRADO_LISTA.toFixed(2)))
  const [pago, setPago] = useState('efectivo')
  const [docType, setDocType] = useState<'ticket' | 'ccf'>('ticket')
  // Regalía: se entregan sin cobro. No hay cliente titular ni documento fiscal,
  // porque no hubo hecho generador que documentar.
  const [esRegalia, setEsRegalia] = useState(false)
  const [vendiendo, setVendiendo] = useState(false)
  const [resultado, setResultado] = useState<SellVouchersResult | null>(null)

  // Al cambiar servicio o tamaño se sugiere el precio de lista; el usuario
  // puede pisarlo, que es el caso de una regalía o un precio negociado.
  useEffect(() => {
    const s = SERVICIOS.find(x => x.code === servicio)
    if (s) setPrecioServicio(s.prices[tamano].toFixed(2))
  }, [servicio, tamano])

  useEffect(() => {
    if (query.trim().length < 2 || cliente) { setResultados([]); return }
    const t = setTimeout(async () => {
      const term = query.trim()
      const { data } = await (supabase as any)
        .from('customers')
        .select('id, customer_type, first_name, last_name, trade_name, legal_name, nit, nrc, dui, email, phone, fiscal_document_type, cod_actividad, desc_actividad, fiscal_departamento, fiscal_municipio, fiscal_complemento, billing_email')
        .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,trade_name.ilike.%${term}%,legal_name.ilike.%${term}%,nit.ilike.%${term}%`)
        .eq('active', true)
        .limit(8)
      setResultados(data ?? [])
    }, 300)
    return () => clearTimeout(t)
  }, [query, cliente])

  // El documento arranca según lo que el cliente tenga configurado.
  useEffect(() => {
    if (cliente) setDocType(preferredDocType(cliente as any))
  }, [cliente])

  const cant = Math.max(0, parseInt(cantidad) || 0)
  const unitario = esRegalia
    ? 0
    : (parseFloat(precioServicio) || 0) + (conAspirado ? (parseFloat(precioAspirado) || 0) : 0)
  const total = unitario * cant

  // Un CCF necesita el receptor completo; si falta algo se avisa antes de cobrar.
  const ccfStatus = useMemo(
    () => (!esRegalia && cliente && docType === 'ccf' ? ccfReceptorStatus(cliente as any) : null),
    [cliente, docType, esRegalia]
  )

  const puedeCobrar = Boolean(
    branchId && cant > 0 && !vendiendo && (
      esRegalia
        // Una regalía no necesita cliente ni precio.
        ? true
        : cliente && unitario > 0 && (docType !== 'ccf' || ccfStatus?.ok)
    )
  )

  const vender = useCallback(async () => {
    if (!branchId || (!esRegalia && !cliente)) return
    setVendiendo(true)
    try {
      const r = await sellVouchers({
        branchId,
        customerId: esRegalia ? null : cliente!.id,
        serviceCode: servicio,
        size: tamano,
        quantity: cant,
        unitPriceService: parseFloat(precioServicio) || 0,
        includesAspirado: conAspirado,
        unitPriceAspirado: conAspirado ? (parseFloat(precioAspirado) || 0) : 0,
        paymentMethod: pago,
        docType,
        isGift: esRegalia,
      })
      setResultado(r)
      toast.success(`${r.quantity} cupones ${esRegalia ? 'de regalía ' : ''}emitidos`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudieron emitir los cupones')
    }
    setVendiendo(false)
  }, [branchId, cliente, servicio, tamano, cant, precioServicio, conAspirado, precioAspirado, pago, docType, esRegalia])

  const descargarPdf = async (batchId: string) => {
    try {
      printVouchers(await fetchBatchVouchers(batchId))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo generar el PDF')
    }
  }

  const copiarNumeros = () => {
    if (!resultado) return
    const texto = resultado.vouchers.map(v => v.code).join('\n')
    navigator.clipboard.writeText(texto)
      .then(() => toast.success(`${resultado.vouchers.length} números copiados`))
      .catch(() => toast.error('No se pudo copiar'))
  }

  const nuevaVenta = () => {
    setResultado(null); setCliente(null); setQuery(''); setCantidad('10')
    setConAspirado(false)
  }

  if (!puedeVender) {
    return (
      <div className="page-inner">
        <div className="empty-state">
          <div className="empty-state-title">No tenés acceso al POS Administrativo</div>
          <div className="empty-state-sub">
            La emisión de cupones requiere el permiso <strong>vouchers.sell</strong>.
            En caja se pueden canjear, pero no emitir.
          </div>
        </div>
      </div>
    )
  }

  // ── Comprobante de la venta recién hecha ──
  if (resultado) {
    // El rango se expresa por correlativo: los números de cupón son al azar,
    // así que "113959 – 898973" no describiría ningún rango.
    const desde = resultado.vouchers[0]?.sequence
    const hasta = resultado.vouchers[resultado.vouchers.length - 1]?.sequence
    return (
      <div className="page-inner">
        <div className="page-header">
          <div className="page-header-left">
            <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 26 }}>Cupones emitidos</h1>
            <div className="page-header-sub">
              Orden {resultado.order_number}
              {resultado.is_gift && ' · Regalía, sin documento fiscal'}
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 20, maxWidth: 620 }}>
          <div className="kpi-grid" style={{ marginBottom: 18 }}>
            {[
              { label: 'Cupones', value: String(resultado.quantity) },
              { label: 'Correlativos', value: `${String(desde ?? '').padStart(6, '0')} – ${String(hasta ?? '').padStart(6, '0')}` },
              { label: 'Valor unitario', value: resultado.is_gift ? 'Regalía' : money(resultado.unit_total) },
              { label: resultado.is_gift ? 'Cobro' : 'Total cobrado', value: resultado.is_gift ? 'Sin cobro' : money(resultado.total) },
            ].map(k => (
              <div key={k.label} className="kpi-card">
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value" style={{ fontSize: 18 }}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* Los números a la vista: son lo que el cajero teclea al canjear, y
              tenerlos acá evita abrir el PDF sólo para consultarlos o para
              dictárselos al cliente por teléfono. */}
          <div className="panel-section-label">Números de cupón emitidos</div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))',
            gap: 6, margin: '8px 0 14px',
          }}>
            {resultado.vouchers.map(v => (
              <div key={v.id} style={{
                border: '1px solid var(--border)', borderRadius: 5,
                padding: '6px 8px', textAlign: 'center', background: 'var(--page-bg)',
              }}>
                <div className="font-mono" style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1 }}>
                  {v.code}
                </div>
                <div className="font-mono" style={{ fontSize: 9.5, color: 'var(--text-secondary)' }}>
                  corr. {String(v.sequence).padStart(6, '0')}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => descargarPdf(resultado.batch_id)}>
              Descargar los {resultado.quantity} cupones (PDF)
            </button>
            <button className="btn btn-ghost" onClick={copiarNumeros}>Copiar números</button>
            <button className="btn btn-ghost" onClick={nuevaVenta}>Nueva venta</button>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12, lineHeight: 1.55 }}>
            El PDF trae 3 cupones por hoja tamaño carta. Cada uno lleva su
            número de validación (6 dígitos al azar), su correlativo y el QR.
            Se puede reimprimir después desde la pantalla de Cupones.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-inner">
      <div className="page-header">
        <div className="page-header-left">
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 26 }}>POS Administrativo</h1>
          <div className="page-header-sub">Venta de cupones prepagados</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── Configuración ── */}
        <div style={{ flex: '1 1 480px', minWidth: 400, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 18 }}>

          {/* Naturaleza de la emisión: define si hay cobro y documento fiscal. */}
          <div className="panel-section-label">Tipo de emisión</div>
          <div className="filter-pills" style={{ marginBottom: 14 }}>
            <button className={`filter-pill${!esRegalia ? ' active' : ''}`}
                    onClick={() => setEsRegalia(false)}>Venta</button>
            <button className={`filter-pill${esRegalia ? ' active' : ''}`}
                    onClick={() => { setEsRegalia(true); setCliente(null); setQuery('') }}>
              Regalía
            </button>
          </div>
          {esRegalia && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--subtle-bg)', padding: '9px 12px', borderRadius: 6, marginBottom: 14, lineHeight: 1.5 }}>
              Se emiten sin cobro y sin documento fiscal. Los cupones salen a
              nombre de <strong>Cliente General</strong> y con el costo rotulado
              como <strong>Regalía</strong>. Toman el mismo correlativo que las ventas.
            </div>
          )}

          {!esRegalia && <div className="panel-section-label">Cliente</div>}
          {esRegalia ? null : cliente ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 7, border: '1.5px solid var(--corsa-green)', background: 'rgba(2,53,48,0.05)', marginBottom: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{nombreCliente(cliente)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {[cliente.nit ? `NIT ${cliente.nit}` : cliente.dui ? `DUI ${cliente.dui}` : null, cliente.email]
                    .filter(Boolean).join(' · ') || 'Sin datos de contacto'}
                </div>
              </div>
              <button onClick={() => { setCliente(null); setQuery('') }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>×</button>
            </div>
          ) : (
            <div style={{ position: 'relative', marginBottom: 14 }}>
              <input className="corsa-input" value={query} onChange={e => setQuery(e.target.value)}
                     placeholder="Buscá por nombre, razón social o NIT…" autoFocus/>
              {resultados.length > 0 && (
                <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.14)', maxHeight: 220, overflowY: 'auto' }}>
                  {resultados.map(c => (
                    <button key={c.id} onClick={() => { setCliente(c); setResultados([]) }}
                      style={{ width: '100%', textAlign: 'left', padding: '9px 13px', border: 'none', background: 'transparent', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{nombreCliente(c)}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                        {c.nit ? `NIT ${c.nit}` : c.customer_type === 'company' ? 'Empresa' : 'Persona'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="panel-section-label">Servicio</div>
          <div className="filter-pills" style={{ marginBottom: 10 }}>
            {SERVICIOS.map(s => (
              <button key={s.code} className={`filter-pill${servicio === s.code ? ' active' : ''}`}
                      onClick={() => setServicio(s.code)}>{s.name}</button>
            ))}
          </div>
          <div className="filter-pills" style={{ marginBottom: 14 }}>
            {TAMANOS.map(t => (
              <button key={t} className={`filter-pill${tamano === t ? ' active' : ''}`}
                      onClick={() => setTamano(t)}>{t}</button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Cantidad de cupones</label>
              <input className="corsa-input" type="number" min="1" max="500"
                     value={cantidad} onChange={e => setCantidad(e.target.value)}/>
            </div>
            {!esRegalia && (
              <div className="field">
                <label>Valor unitario del lavado</label>
                <input className="corsa-input" type="number" step="0.50" min="0"
                       value={precioServicio} onChange={e => setPrecioServicio(e.target.value)}/>
              </div>
            )}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '6px 0 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={conAspirado} onChange={e => setConAspirado(e.target.checked)}
                   style={{ accentColor: 'var(--corsa-green)' }}/>
            <span style={{ fontSize: 13, fontWeight: 600 }}>El cupón incluye aspirado de interiores</span>
          </label>
          {conAspirado && !esRegalia && (
            <div className="field" style={{ marginTop: 10, maxWidth: 220 }}>
              <label>Valor unitario del aspirado</label>
              <input className="corsa-input" type="number" step="0.50" min="0"
                     value={precioAspirado} onChange={e => setPrecioAspirado(e.target.value)}/>
            </div>
          )}

          {!esRegalia && <>
          <div className="panel-divider" style={{ margin: '16px 0' }}/>

          <div className="panel-section-label">Cobro</div>
          <div className="filter-pills" style={{ marginBottom: 10 }}>
            {[['efectivo','Efectivo'],['tarjeta','Tarjeta'],['transferencia','Transferencia']].map(([id, label]) => (
              <button key={id} className={`filter-pill${pago === id ? ' active' : ''}`}
                      onClick={() => setPago(id)}>{label}</button>
            ))}
          </div>
          <div className="filter-pills">
            {[['ticket','Consumidor final'],['ccf','Crédito fiscal']].map(([id, label]) => (
              <button key={id} className={`filter-pill${docType === id ? ' active' : ''}`}
                      onClick={() => setDocType(id as 'ticket' | 'ccf')}>{label}</button>
            ))}
          </div>

          {ccfStatus && !ccfStatus.ok && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-danger-text)', background: 'var(--color-danger-bg, #FBE7E7)', padding: '8px 12px', borderRadius: 5 }}>
              Para emitir CCF faltan datos del cliente: {ccfStatus.missing.join(', ')}.
              Completalos en Clientes.
            </div>
          )}
          </>}
        </div>

        {/* ── Resumen ── */}
        <div style={{ flex: '0 1 280px', minWidth: 250, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 18 }}>
          <div className="panel-section-label">Resumen</div>
          <div className="panel-row"><span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Servicio</span>
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>{SERVICIOS.find(s => s.code === servicio)?.name} {tamano}</span></div>
          <div className="panel-row"><span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Aspirado</span>
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>{conAspirado ? 'Incluido' : 'No incluye'}</span></div>
          <div className="panel-row"><span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Valor unitario</span>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>{esRegalia ? 'Regalía' : money(unitario)}</span></div>
          <div className="panel-row"><span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Cantidad</span>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>{cant}</span></div>

          <div className="panel-divider"/>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{esRegalia ? 'SIN COBRO' : 'TOTAL'}</span>
            <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>
              {esRegalia ? '—' : money(total)}
            </span>
          </div>

          <button
            onClick={vender}
            disabled={!puedeCobrar}
            style={{ width: '100%', marginTop: 14, textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: '#fff', background: puedeCobrar ? 'var(--corsa-green)' : 'var(--text-secondary)', borderRadius: 5, padding: 11, cursor: puedeCobrar ? 'pointer' : 'not-allowed', border: 'none', opacity: puedeCobrar ? 1 : 0.5 }}
          >
            {vendiendo ? 'Emitiendo…' : esRegalia ? `Emitir ${cant || 0} cupones de regalía` : `Cobrar y emitir ${cant || 0} cupones`}
          </button>

          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.5 }}>
            Los correlativos los asigna el sistema: continúan desde el último
            cupón emitido y no se pueden editar.
          </div>
        </div>
      </div>
    </div>
  )
}
