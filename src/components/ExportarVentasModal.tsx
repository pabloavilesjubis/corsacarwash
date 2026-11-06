/**
 * «Exportar ventas» (0082): para los contadores, dos descargas del mismo rango.
 *   · Resumen: qué ventas (contribuyentes o consumidores) y el formato; baja un
 *     solo archivo con una sola pestaña.
 *   · Documentos: un ZIP con el JSON y el PDF de cada DTE del rango, CCF y FCF
 *     juntos, nombrados por número de control.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { dateRange } from '../services/sales.service'
import {
  armarHoja, descargarCsv, descargarExcel, fetchDtesParaContadores, resumenHoja, type TipoVentas,
} from '../lib/ventas/exportarContadores'
import { descargarDocumentosZip, type Progreso, type ResultadoZip } from '../lib/ventas/descargarDocumentos'

const money = (n: number) => 'US$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const megas = (b: number) => (b / 1024 / 1024).toLocaleString('es-SV', { maximumFractionDigits: 1 }) + ' MB'

export function ExportarVentasModal({ desdeInicial, hastaInicial, onCerrar }: {
  desdeInicial: string; hastaInicial: string; onCerrar: () => void
}) {
  const [desde, setDesde] = useState(desdeInicial || dateRange('mes').from)
  const [hasta, setHasta] = useState(hastaInicial || dateRange('mes').to)
  const [que, setQue] = useState<'resumen' | 'documentos'>('resumen')
  const [tipo, setTipo] = useState<TipoVentas>('ccf')
  const [formato, setFormato] = useState<'xlsx' | 'csv'>('xlsx')
  const [exportando, setExportando] = useState(false)
  const [hecho, setHecho] = useState<ReturnType<typeof resumenHoja> | null>(null)
  const [progreso, setProgreso] = useState<Progreso | null>(null)
  const [zipHecho, setZipHecho] = useState<ResultadoZip | null>(null)
  const abortar = useRef<AbortController | null>(null)

  // Cerrar el modal corta la descarga de documentos que esté en curso.
  const cerrar = () => {
    if (abortar.current && !confirm('Se está armando el ZIP de documentos. ¿Cancelar la descarga?')) return
    abortar.current?.abort()
    onCerrar()
  }
  useEffect(() => () => abortar.current?.abort(), [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') cerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  })

  const limpiar = () => { setHecho(null); setZipHecho(null) }

  const rapido = (p: 'mes' | 'mes_pasado') => {
    const r = dateRange(p)
    setDesde(r.from); setHasta(r.to); limpiar()
  }

  const exportar = async () => {
    if (!desde || !hasta) { toast.error('Elegí las dos fechas'); return }
    if (hasta < desde) { toast.error('La fecha final es anterior a la inicial'); return }
    if (que === 'documentos') return exportarDocumentos()
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

  const exportarDocumentos = async () => {
    const ctl = new AbortController()
    abortar.current = ctl
    setExportando(true); setZipHecho(null); setProgreso(null)
    try {
      const r = await descargarDocumentosZip(desde, hasta, { signal: ctl.signal, onProgreso: setProgreso })
      if (!r) toast.error('No hay documentos emitidos en ese rango')
      else {
        setZipHecho(r)
        if (r.incompletos.length) toast.error(`${r.incompletos.length} documentos quedaron incompletos: ver el LEEME del ZIP`)
      }
    } catch (err: any) {
      if (!ctl.signal.aborted) toast.error(err?.message ?? 'No se pudieron descargar los documentos')
    }
    abortar.current = null
    setProgreso(null)
    setExportando(false)
  }

  return createPortal(
    <div onClick={e => { if (e.target === e.currentTarget) cerrar() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18 }}>Exportar ventas</div>
          <button onClick={cerrar} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 22 }}>×</button>
        </div>

        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="panel-section-label">Qué descargar</div>
            <div className="filter-pills">
              <button type="button" className={`filter-pill${que === 'resumen' ? ' active' : ''}`} disabled={exportando}
                      onClick={() => { setQue('resumen'); limpiar() }}>
                Resumen de ventas
              </button>
              <button type="button" className={`filter-pill${que === 'documentos' ? ' active' : ''}`} disabled={exportando}
                      onClick={() => { setQue('documentos'); limpiar() }}>
                Documentos (JSON y PDF)
              </button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 8 }}>
              {que === 'resumen'
                ? 'Los DTE emitidos en el rango, por fecha de emisión, con sello de recepción, datos del cliente y montos.'
                : 'Un ZIP con el JSON y el PDF de cada DTE del rango, créditos fiscales y facturas juntos, en orden de número de control.'}
            </div>
          </div>

          {que === 'resumen' && <div>
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
          </div>}

          <div>
            <div className="panel-section-label">Rango de fechas</div>
            <div className="filter-pills" style={{ marginBottom: 8 }}>
              <button type="button" className="filter-pill" onClick={() => rapido('mes')}>Este mes</button>
              <button type="button" className="filter-pill" onClick={() => rapido('mes_pasado')}>Mes pasado</button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="date" className="corsa-input" style={{ flex: '1 1 0', width: 0 }} value={desde}
                     disabled={exportando} onChange={e => { setDesde(e.target.value); limpiar() }} aria-label="Desde"/>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>a</span>
              <input type="date" className="corsa-input" style={{ flex: '1 1 0', width: 0 }} value={hasta}
                     disabled={exportando} onChange={e => { setHasta(e.target.value); limpiar() }} aria-label="Hasta"/>
            </div>
          </div>

          {que === 'resumen' && <div>
            <div className="panel-section-label">Formato</div>
            <div className="filter-pills">
              <button type="button" className={`filter-pill${formato === 'xlsx' ? ' active' : ''}`} onClick={() => setFormato('xlsx')}>
                Excel
              </button>
              <button type="button" className={`filter-pill${formato === 'csv' ? ' active' : ''}`} onClick={() => setFormato('csv')}>
                CSV
              </button>
            </div>
          </div>}

          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            {que === 'resumen'
              ? 'Los DTE invalidados se incluyen rotulados como «Invalidado» y no suman en los totales. Los que todavía no tienen sello de Hacienda no se incluyen.'
              : 'Incluye los invalidados (su PDF lo indica). Los que todavía no tienen sello de Hacienda no se incluyen. Un mes completo tarda unos minutos: no cierres esta ventana.'}
          </div>

          {progreso && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 6 }}>
                <span>Generando documentos…</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{progreso.listos} de {progreso.total}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progreso.total ? (100 * progreso.listos) / progreso.total : 0}%`,
                              background: 'var(--accent, #0E3B36)', transition: 'width .3s' }}/>
              </div>
            </div>
          )}

          {zipHecho && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5,
                          display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span>
                Descargado: <strong>{zipHecho.documentos}</strong> documentos
                {zipHecho.incompletos.length > 0 && <span style={{ color: 'var(--text-secondary)' }}> ({zipHecho.incompletos.length} incompletos)</span>}
              </span>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{megas(zipHecho.bytes)}</strong>
            </div>
          )}

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
          <button onClick={cerrar} className="btn btn-ghost">{hecho || zipHecho ? 'Cerrar' : 'Cancelar'}</button>
          <button onClick={exportar} className="btn btn-primary" disabled={exportando}>
            {exportando ? 'Exportando…' : hecho || zipHecho ? 'Exportar de nuevo' : que === 'documentos' ? 'Descargar ZIP' : 'Exportar'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
