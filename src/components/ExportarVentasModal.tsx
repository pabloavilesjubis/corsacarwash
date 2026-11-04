/**
 * «Exportar ventas» (0082): el resumen para los contadores. Pide qué ventas
 * (contribuyentes o consumidores), el rango y el formato, y baja un solo
 * archivo con una sola pestaña.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { dateRange } from '../services/sales.service'
import {
  armarHoja, descargarCsv, descargarExcel, fetchDtesParaContadores, resumenHoja, type TipoVentas,
} from '../lib/ventas/exportarContadores'

const money = (n: number) => 'US$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function ExportarVentasModal({ desdeInicial, hastaInicial, onCerrar }: {
  desdeInicial: string; hastaInicial: string; onCerrar: () => void
}) {
  const [desde, setDesde] = useState(desdeInicial || dateRange('mes').from)
  const [hasta, setHasta] = useState(hastaInicial || dateRange('mes').to)
  const [tipo, setTipo] = useState<TipoVentas>('ccf')
  const [formato, setFormato] = useState<'xlsx' | 'csv'>('xlsx')
  const [exportando, setExportando] = useState(false)
  const [hecho, setHecho] = useState<ReturnType<typeof resumenHoja> | null>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar])

  const rapido = (p: 'mes' | 'mes_pasado') => {
    const r = dateRange(p)
    setDesde(r.from); setHasta(r.to); setHecho(null)
  }

  const exportar = async () => {
    if (!desde || !hasta) { toast.error('Elegí las dos fechas'); return }
    if (hasta < desde) { toast.error('La fecha final es anterior a la inicial'); return }
    setExportando(true)
    try {
      const dtes = await fetchDtesParaContadores(desde, hasta, tipo)
      if (dtes.length === 0) {
        toast.error(`No hay ${tipo === 'ccf' ? 'créditos fiscales' : 'facturas de consumidor final'} en ese rango`)
        setExportando(false)
        return
      }
      const hoja = armarHoja(dtes, tipo)
      const nombre = `ventas-${tipo === 'ccf' ? 'contribuyentes' : 'consumidores'}-${desde}_${hasta}`
      if (formato === 'xlsx') await descargarExcel(hoja, `${nombre}.xlsx`)
      else descargarCsv(hoja, `${nombre}.csv`)
      setHecho(resumenHoja(hoja))
    } catch (err: any) {
      toast.error(err?.message ?? 'No se pudo exportar')
    }
    setExportando(false)
  }

  return createPortal(
    <div onClick={e => { if (e.target === e.currentTarget) onCerrar() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>Exportar ventas</div>
          <button onClick={onCerrar} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Resumen para contabilidad: los DTE emitidos en el rango, por fecha de emisión, con sello de
            recepción, datos del cliente y montos.
          </div>

          <div>
            <div className="panel-section-label">Ventas a exportar</div>
            <div className="filter-pills">
              <button type="button" className={`filter-pill${tipo === 'ccf' ? ' active' : ''}`}
                      onClick={() => { setTipo('ccf'); setHecho(null) }}>
                Contribuyentes (CCF)
              </button>
              <button type="button" className={`filter-pill${tipo === 'fcf' ? ' active' : ''}`}
                      onClick={() => { setTipo('fcf'); setHecho(null) }}>
                Consumidores (FCF)
              </button>
            </div>
          </div>

          <div>
            <div className="panel-section-label">Rango de fechas</div>
            <div className="filter-pills" style={{ marginBottom: 8 }}>
              <button type="button" className="filter-pill" onClick={() => rapido('mes')}>Este mes</button>
              <button type="button" className="filter-pill" onClick={() => rapido('mes_pasado')}>Mes pasado</button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="date" className="corsa-input" style={{ flex: '1 1 0', width: 0 }} value={desde}
                     onChange={e => { setDesde(e.target.value); setHecho(null) }} aria-label="Desde"/>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>a</span>
              <input type="date" className="corsa-input" style={{ flex: '1 1 0', width: 0 }} value={hasta}
                     onChange={e => { setHasta(e.target.value); setHecho(null) }} aria-label="Hasta"/>
            </div>
          </div>

          <div>
            <div className="panel-section-label">Formato</div>
            <div className="filter-pills">
              <button type="button" className={`filter-pill${formato === 'xlsx' ? ' active' : ''}`} onClick={() => setFormato('xlsx')}>
                Excel
              </button>
              <button type="button" className={`filter-pill${formato === 'csv' ? ' active' : ''}`} onClick={() => setFormato('csv')}>
                CSV
              </button>
            </div>
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            Los DTE invalidados se incluyen rotulados como «Invalidado» y no suman en los totales. Los que todavía no
            tienen sello de Hacienda no se incluyen.
          </div>

          {hecho && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5,
                          display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span>
                Descargado: <strong>{hecho.documentos}</strong> documentos
                {hecho.invalidados > 0 && <span style={{ color: 'var(--text-secondary)' }}> ({hecho.invalidados} invalidados)</span>}
              </span>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{money(hecho.total)}</strong>
            </div>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCerrar} className="btn btn-ghost">{hecho ? 'Cerrar' : 'Cancelar'}</button>
          <button onClick={exportar} className="btn btn-primary" disabled={exportando}>
            {exportando ? 'Exportando…' : hecho ? 'Exportar de nuevo' : 'Exportar'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
