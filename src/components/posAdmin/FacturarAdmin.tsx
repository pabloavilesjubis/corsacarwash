/**
 * Pestaña «Facturar» del POS administrativo (0081): productos y servicios del
 * catálogo propio, a un cliente de la base, con FCF o CCF.
 *
 * Cobra como la caja: registra la venta (admin_sell_items), emite el DTE con
 * la firma local si la sucursal emite desde el POS, y manda el correo si
 * Hacienda lo selló. Si el DTE no sale, la venta queda y se emite desde Ventas.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../hooks/useAuth'
import { useEsMovil } from '../../hooks/useEsMovil'
import { BuscadorCliente } from './BuscadorCliente'
import { listarCatalogo, venderItems, type ItemCatalogo, type VentaAdminResult } from '../../lib/posAdmin/catalogo'
import { nombreCliente, type ClienteAdmin } from '../../lib/posAdmin/cliente'
import { ccfReceptorStatus, fcfReceptorStatus, preferredDocType } from '../../lib/fiscal/receptor'
import { emitirConFirmaLocal, posEmiteDte } from '../../services/fiscal.service'
import { enviarCorreoVenta } from '../../services/correo.service'

const money = (n: number) => 'US$' + (Number(n) || 0).toFixed(2)
const ESPERA_DTE_MS = 20_000

interface Linea {
  key: number
  item: ItemCatalogo
  cantidad: string
  precio: string
  descripcion: string
}

const num = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN }
const importeLinea = (l: Linea) => {
  const c = num(l.cantidad), p = num(l.precio)
  return c > 0 && p >= 0 ? Math.round(c * p * 100) / 100 : 0
}

export function FacturarAdmin() {
  const { currentBranch } = useAuth()
  const esMovil = useEsMovil()
  const branchId = (currentBranch as any)?.id ?? null

  const [catalogo, setCatalogo] = useState<ItemCatalogo[] | null>(null)
  const [cliente, setCliente] = useState<ClienteAdmin | null>(null)
  const [lineas, setLineas] = useState<Linea[]>([])
  const [agregar, setAgregar] = useState('')
  const [pago, setPago] = useState('efectivo')
  const [docType, setDocType] = useState<'ticket' | 'ccf'>('ticket')
  const [emiteDte, setEmiteDte] = useState(false)
  const [cobrando, setCobrando] = useState(false)
  const [resultado, setResultado] = useState<(VentaAdminResult & { estadoDte: string; mensaje?: string; cliente: string }) | null>(null)

  useEffect(() => {
    listarCatalogo(true).then(setCatalogo).catch(() => setCatalogo([]))
  }, [])
  useEffect(() => {
    if (!branchId) return
    let vivo = true
    posEmiteDte(branchId).then(v => { if (vivo) setEmiteDte(v) }).catch(() => { if (vivo) setEmiteDte(false) })
    return () => { vivo = false }
  }, [branchId])

  const elegirCliente = (c: ClienteAdmin | null) => {
    setCliente(c)
    // El documento arranca según el cliente: una empresa, CCF.
    if (c) setDocType(preferredDocType(c as any))
  }

  const agregarItem = (id: string) => {
    const item = catalogo?.find(i => i.id === id)
    if (!item) return
    setLineas(ls => [...ls, {
      key: Date.now() + Math.random(), item, cantidad: '1',
      precio: item.default_price != null ? item.default_price.toFixed(2) : '', descripcion: '',
    }])
    setAgregar('')
  }
  const cambiar = (key: number, campo: 'cantidad' | 'precio' | 'descripcion', valor: string) =>
    setLineas(ls => ls.map(l => (l.key === key ? { ...l, [campo]: valor } : l)))

  const total = lineas.reduce((s, l) => s + importeLinea(l), 0)

  const receptor = useMemo(() => {
    if (!cliente) return null
    return docType === 'ccf' ? ccfReceptorStatus(cliente as any) : fcfReceptorStatus(cliente as any, total)
  }, [cliente, docType, total])

  const falta = ((): string | null => {
    if (!branchId) return 'Elegí una sucursal'
    if (!cliente) return 'Elegí el cliente'
    if (lineas.length === 0) return 'Agregá un producto o servicio'
    for (const l of lineas) {
      if (!(num(l.cantidad) > 0)) return `Revisá la cantidad de ${l.item.name}`
      if (!(num(l.precio) >= 0) || l.precio.trim() === '') return `Revisá el precio de ${l.item.name}`
    }
    if (total <= 0) return 'La factura tiene que tener un importe'
    if (receptor && !receptor.ok) return `Faltan datos del cliente: ${receptor.missing.join(', ')}`
    return null
  })()

  const cobrar = async () => {
    if (falta || cobrando || !cliente || !branchId) return
    setCobrando(true)
    try {
      const venta = await venderItems({
        branchId, customerId: cliente.id, pago, docType,
        lineas: lineas.map(l => ({
          service_id: l.item.id, cantidad: num(l.cantidad), precio: num(l.precio),
          ...(l.descripcion.trim() ? { descripcion: l.descripcion.trim() } : {}),
        })),
      })

      let estadoDte = 'NO_EMITIDO'
      let mensaje: string | undefined
      if (emiteDte) {
        const espera = toast.loading('Firmando y emitiendo el DTE con Hacienda…')
        try {
          const r = await emitirConFirmaLocal(venta.invoice_id, { timeoutMs: ESPERA_DTE_MS })
          estadoDte = r.estado
          mensaje = r.mensaje ?? undefined
          if (r.estado === 'ACCEPTED') toast.success('DTE sellado por Hacienda', { id: espera })
          else toast.error(`DTE ${r.estado === 'REJECTED' ? 'rechazado' : 'pendiente'}: ${r.mensaje ?? 'revisalo en Ventas'}`, { id: espera, duration: 8000 })
        } catch (e) {
          estadoDte = 'ERROR'
          mensaje = e instanceof Error ? e.message : 'No se pudo emitir el DTE'
          toast.error(mensaje, { id: espera, duration: 8000 })
        }
      }
      if (estadoDte === 'ACCEPTED') {
        enviarCorreoVenta(venta.order_id).then(r => {
          if (!r.ok) toast.error(`El correo de ${venta.order_number} no salió: ${r.error ?? ''}`, { duration: 8000 })
        })
      }
      setResultado({ ...venta, estadoDte, mensaje, cliente: nombreCliente(cliente) })
      toast.success(`Venta ${venta.order_number} registrada ✓`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar la venta')
    }
    setCobrando(false)
  }

  const nuevaVenta = () => {
    setResultado(null); setCliente(null); setLineas([]); setPago('efectivo'); setDocType('ticket')
  }

  if (resultado) {
    const sellado = resultado.estadoDte === 'ACCEPTED'
    return (
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 20, maxWidth: 620 }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20 }}>Venta {resultado.order_number}</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
          {resultado.cliente} · {resultado.doc_type === 'ccf' ? 'Crédito fiscal' : 'Consumidor final'} · {money(resultado.total)}
        </div>
        <div style={{
          marginTop: 14, padding: '10px 14px', borderRadius: 12, fontSize: 13, lineHeight: 1.5,
          background: sellado ? 'var(--color-success-tint)' : 'var(--subtle-bg)',
          color: sellado ? 'var(--color-success-text)' : 'var(--text-primary)',
        }}>
          {sellado ? 'DTE sellado por Hacienda. El correo sale al cliente.'
            : resultado.estadoDte === 'NO_EMITIDO'
              ? 'La venta quedó registrada. Esta sucursal no emite el DTE al cobrar: emitilo desde Ventas.'
              : `La venta quedó registrada, pero el DTE no se selló${resultado.mensaje ? `: ${resultado.mensaje}` : ''}. Reintentalo desde Ventas.`}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={nuevaVenta}>Nueva venta</button>
          <Link className="btn btn-ghost" to="/sales">Ver en Ventas</Link>
        </div>
      </div>
    )
  }

  const disponibles = catalogo ?? []

  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 480px', minWidth: esMovil ? 0 : 400, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 18 }}>
        <div className="panel-section-label">Cliente</div>
        <BuscadorCliente cliente={cliente} onElegir={elegirCliente} conAlta/>

        <div className="panel-section-label">Productos y servicios</div>
        {catalogo === null ? (
          <div className="loading-center"><div className="spinner"/></div>
        ) : disponibles.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '6px 0 12px' }}>
            No hay productos ni servicios activos. Agregalos en la pestaña «Productos y servicios».
          </div>
        ) : (
          <select className="corsa-input" value={agregar} onChange={e => agregarItem(e.target.value)} style={{ marginBottom: 12 }}>
            <option value="">+ Agregar un producto o servicio…</option>
            {disponibles.map(i => (
              <option key={i.id} value={i.id}>
                {i.name}{i.default_price != null ? ` · ${money(i.default_price)}` : ''}{i.item_type === 'producto' ? ' (producto)' : ''}
              </option>
            ))}
          </select>
        )}

        {lineas.map(l => (
          <div key={l.key} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                {l.item.name}
                <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)', marginLeft: 6 }}>{l.item.item_type}</span>
              </div>
              <button onClick={() => setLineas(ls => ls.filter(x => x.key !== l.key))} aria-label={`Quitar ${l.item.name}`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>×</button>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: '0 0 90px' }}>
                <label>Cantidad</label>
                <input className="corsa-input" type="number" min="0" step="1" value={l.cantidad}
                       onChange={e => cambiar(l.key, 'cantidad', e.target.value)}/>
              </div>
              <div className="field" style={{ flex: '0 0 130px' }}>
                <label>Precio c/u (con IVA)</label>
                <input className="corsa-input" type="number" min="0" step="0.01" value={l.precio}
                       onChange={e => cambiar(l.key, 'precio', e.target.value)}/>
              </div>
              <div style={{ marginLeft: 'auto', fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 16, fontVariantNumeric: 'tabular-nums', paddingBottom: 8 }}>
                {money(importeLinea(l))}
              </div>
            </div>
            <div className="field" style={{ marginTop: 8 }}>
              <label>Descripción en la factura (opcional)</label>
              <input className="corsa-input" value={l.descripcion} maxLength={1000} placeholder={l.item.name}
                     onChange={e => cambiar(l.key, 'descripcion', e.target.value)}/>
            </div>
          </div>
        ))}

        <div className="panel-divider" style={{ margin: '16px 0' }}/>

        <div className="panel-section-label">Cobro</div>
        <div className="filter-pills" style={{ marginBottom: 10 }}>
          {[['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia']].map(([id, label]) => (
            <button key={id} className={`filter-pill${pago === id ? ' active' : ''}`} onClick={() => setPago(id)}>{label}</button>
          ))}
        </div>
        <div className="panel-section-label">Documento</div>
        <div className="filter-pills">
          {[['ticket', 'Consumidor final (FCF)'], ['ccf', 'Crédito fiscal (CCF)']].map(([id, label]) => (
            <button key={id} className={`filter-pill${docType === id ? ' active' : ''}`}
                    onClick={() => setDocType(id as 'ticket' | 'ccf')}>{label}</button>
          ))}
        </div>
        {cliente && receptor && !receptor.ok && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-danger-text)', background: 'var(--color-danger-bg, #FBE7E7)', padding: '8px 12px', borderRadius: 10 }}>
            Para emitir {docType === 'ccf' ? 'CCF' : 'esta FCF'} faltan datos del cliente: {receptor.missing.join(', ')}. Completalos en Clientes.
          </div>
        )}
      </div>

      <div style={{ flex: '0 1 280px', minWidth: esMovil ? 0 : 250, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 18 }}>
        <div className="panel-section-label">Resumen</div>
        {lineas.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Sin líneas todavía.</div>
        ) : lineas.map(l => (
          <div key={l.key} className="panel-row" style={{ marginBottom: 4 }}>
            <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {l.cantidad} × {l.descripcion.trim() || l.item.name}
            </span>
            <span style={{ fontWeight: 600, fontSize: 12.5, flexShrink: 0 }}>{money(importeLinea(l))}</span>
          </div>
        ))}
        <div className="panel-divider" style={{ margin: '10px 0' }}/>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>TOTAL</span>
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Precios con IVA incluido.</div>
        <button onClick={cobrar} disabled={!!falta || cobrando}
          style={{ width: '100%', marginTop: 14, textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: '#fff', background: !falta ? 'var(--corsa-green)' : 'var(--text-secondary)', borderRadius: 10, padding: 11, cursor: !falta ? 'pointer' : 'not-allowed', border: 'none', opacity: !falta ? 1 : 0.5 }}>
          {cobrando ? 'Cobrando…' : falta ?? `Cobrar y facturar ${docType === 'ccf' ? 'CCF' : 'FCF'}`}
        </button>
        {!emiteDte && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.5 }}>
            Esta sucursal no emite el DTE al cobrar: la venta queda registrada y se emite desde Ventas.
          </div>
        )}
      </div>
    </div>
  )
}
