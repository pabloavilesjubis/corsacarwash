/**
 * CORSA Carwash — Banco de pruebas del ticket térmico
 *
 * Pantalla de desarrollo para iterar el diseño sin tener que facturar de
 * verdad ni ir a buscar una impresora. Cambiás los controles de la izquierda y
 * el ticket se re-renderiza a la derecha, al ancho real del papel (80 mm).
 *
 * Sólo se monta en desarrollo (ver App.tsx): no es una pantalla del sistema y
 * no debe llegar a producción, por eso tampoco pasa por el ScreenGuard.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  buildCorsaTicketPreviewHTML, printCorsaTicket, type TicketArgs,
} from '../lib/ticket/corsaTicket'
import { ALL_PROGRAMS } from '../lib/ticket/servicePrograms'
import { rotuloAmbiente } from '../lib/ticket/fromSale'
import { cargarEmisor, MARCA, type EstadoEmisor } from '../lib/fiscal/emisor'
import { useAuth } from '../hooks/useAuth'
import type { TicketEmisor } from '../lib/ticket/corsaTicket'
import { urlConsultaMh } from '../lib/fiscal/consultaMh'

/** 80 mm a 96 dpi ≈ 302 px: el ancho real del papel. */
const PAPER_PX = 302
/** Alto del lienzo de previsualización; el papel real es continuo. */
const PAPER_HEIGHT_PX = 1400

export function TicketPreviewPage() {
  const [servicio, setServicio] = useState('Elite')
  const [aspirado, setAspirado] = useState(true)
  const [placa, setPlaca] = useState('P123-456')
  const [vehiculo, setVehiculo] = useState('Toyota Corolla · Gris')
  const [orden, setOrden] = useState('00042')
  const [total, setTotal] = useState('18.00')
  const [aspiradoPrecioTxt, setAspiradoPrecioTxt] = useState('3.00')
  const [conDte, setConDte] = useState(true)
  const [esCcf, setEsCcf] = useState(false)
  const [zoom, setZoom] = useState(1.5)
  // El emisor real de la sucursal abierta: la vista previa tiene que mostrar
  // lo mismo que va a salir impreso.
  const { currentBranch } = useAuth()
  const [estadoEmisor, setEstadoEmisor] = useState<EstadoEmisor | null>(null)
  useEffect(() => {
    let vivo = true
    cargarEmisor((currentBranch as any)?.id)
      .then(e => { if (vivo) setEstadoEmisor(e) })
      .catch(() => { if (vivo) setEstadoEmisor({ completo: false, faltantes: ['no se pudo leer fiscal_issuer_config'] }) })
    return () => { vivo = false }
  }, [currentBranch])
  // Incompleta, la vista previa muestra lo que saldría sin DTE: la marca sola.
  const emisor: TicketEmisor = estadoEmisor?.completo ? estadoEmisor.emisor : MARCA

  const args: TicketArgs = useMemo(() => {
    const totalNum = Number(total) || 0
    const aspiradoPrecio = aspirado ? (Number(aspiradoPrecioTxt) || 0) : 0
    return {
      emisor: { ...emisor, ambiente: emisor.nit ? rotuloAmbiente(conDte ? { ambiente: '00' } : null) : 'SIN VALIDEZ FISCAL' },
      operacion: { servicio, aspirado, placa, vehiculo, ordenNumero: orden },
      venta: {
        id: 'preview',
        fecha: new Date().toISOString(),
        // El aspirado es una línea con su propio precio, no un "incluido" a
        // cero: el ticket tiene que mostrar el desglose real de la venta.
        lineas: [
          { nombre: `${servicio} M`, cantidad: 1, precioUnitario: totalNum - aspiradoPrecio, subtotal: totalNum - aspiradoPrecio },
          ...(aspirado
            ? [{ nombre: 'Aspirado de interiores', cantidad: 1, precioUnitario: aspiradoPrecio, subtotal: aspiradoPrecio }]
            : []),
        ],
        total: totalNum,
        metodoPago: 'Efectivo',
      },
      dte: conDte
        ? {
            tipoDte: esCcf ? '03' : '01',
            numeroControl: esCcf
              ? 'DTE-03-M001P001-000000000000042'
              : 'DTE-01-M001P001-000000000000042',
            codigoGeneracion: 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D',
            // El sello del MH: 40 caracteres, el año y 36 hexadecimales.
            selloRecibido: '2026A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8',
            qrUrl: urlConsultaMh({
              ambiente: '00',
              codigoGeneracion: 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D',
              fechaEmi: '2026-10-01',
            }),
            fhProcesamiento: new Date().toLocaleString('es-SV'),
          }
        : undefined,
      cliente: esCcf
        ? { nombre: 'ACME S.A. de C.V.', tipoDocumento: 'NIT', numeroDocumento: '0614-010101-101-5', nrc: '234567' }
        : { nombre: 'Consumidor Final' },
      atendio: 'Mauricio J.',
    }
  }, [servicio, aspirado, placa, vehiculo, orden, total, aspiradoPrecioTxt, conDte, esCcf, emisor])

  const html = useMemo(() => buildCorsaTicketPreviewHTML(args), [args])

  const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }
  const label: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }

  return (
    <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start', flexWrap: 'wrap', minHeight: '100vh', background: 'var(--bg, #f4f4f2)' }}>

      {/* ── Controles ── */}
      <div style={{ flex: '0 0 300px', background: 'var(--surface, #fff)', border: '1px solid var(--border, #ddd)', borderRadius: 16, padding: 18 }}>
        <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>Ticket térmico</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Banco de pruebas · sólo desarrollo
        </div>

        {estadoEmisor && !estadoEmisor.completo && (
          <div role="alert" style={{ fontSize: 12, lineHeight: 1.4, marginBottom: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--danger, #c0392b)', color: 'var(--danger, #c0392b)' }}>
            <strong>Configuración fiscal del emisor incompleta.</strong> Un ticket con DTE y la factura carta no
            se imprimen; sin DTE sale con la marca sola y sin validez fiscal.
            <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
              {estadoEmisor.faltantes.map(f => <li key={f}>{f}</li>)}
            </ul>
          </div>
        )}

        <div style={field}>
          <span style={label}>Servicio</span>
          <select className="corsa-input" value={servicio} onChange={e => setServicio(e.target.value)}>
            {ALL_PROGRAMS.map(p => (
              <option key={p.program} value={p.label}>{p.label} → programa {p.program}</option>
            ))}
            <option value="Lavado Básico">Lavado Básico (sin tier → “?”)</option>
          </select>
        </div>

        <div style={field}>
          <span style={label}>Aspirado</span>
          <div className="filter-pills">
            <button className={`filter-pill${aspirado ? ' active' : ''}`} onClick={() => setAspirado(true)}>Sí lleva</button>
            <button className={`filter-pill${!aspirado ? ' active' : ''}`} onClick={() => setAspirado(false)}>No lleva</button>
          </div>
        </div>

        <div style={field}>
          <span style={label}>Placa</span>
          <input className="corsa-input" value={placa} onChange={e => setPlaca(e.target.value)}/>
        </div>
        <div style={field}>
          <span style={label}>Vehículo</span>
          <input className="corsa-input" value={vehiculo} onChange={e => setVehiculo(e.target.value)}/>
        </div>
        <div style={field}>
          <span style={label}>N° de orden</span>
          <input className="corsa-input" value={orden} onChange={e => setOrden(e.target.value)}/>
        </div>
        <div style={field}>
          <span style={label}>Total</span>
          <input className="corsa-input" value={total} onChange={e => setTotal(e.target.value)}/>
        </div>
        {aspirado && (
          <div style={field}>
            <span style={label}>Precio del aspirado</span>
            <input className="corsa-input" value={aspiradoPrecioTxt}
                   onChange={e => setAspiradoPrecioTxt(e.target.value)}/>
          </div>
        )}

        <div style={field}>
          <span style={label}>Documento</span>
          <div className="filter-pills">
            <button className={`filter-pill${!esCcf ? ' active' : ''}`} onClick={() => setEsCcf(false)}>Consumidor final</button>
            <button className={`filter-pill${esCcf ? ' active' : ''}`} onClick={() => setEsCcf(true)}>Crédito fiscal</button>
          </div>
        </div>

        <div style={field}>
          <span style={label}>DTE emitido</span>
          <div className="filter-pills">
            <button className={`filter-pill${conDte ? ' active' : ''}`} onClick={() => setConDte(true)}>Con QR</button>
            <button className={`filter-pill${!conDte ? ' active' : ''}`} onClick={() => setConDte(false)}>Sin DTE</button>
          </div>
        </div>

        <div style={field}>
          <span style={label}>Zoom ({zoom}×)</span>
          <input type="range" min={1} max={3} step={0.25} value={zoom}
                 onChange={e => setZoom(Number(e.target.value))}/>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            A 1× el ancho es el real del papel (80 mm ≈ {PAPER_PX} px).
          </div>
        </div>

        <button
          onClick={() => printCorsaTicket(args)}
          style={{ width: '100%', textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: '#fff', background: 'var(--corsa-green, #157A52)', borderRadius: 10, padding: 10, cursor: 'pointer', border: 'none', marginTop: 6 }}
        >
          Imprimir prueba
        </button>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
          Abre el diálogo del navegador. Para ver el resultado real elegí
          «Guardar como PDF» con márgenes en cero.
        </div>
      </div>

      {/* ── Papel ── */}
      <div style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'center' }}>
        {/* El iframe se escala con transform, que NO afecta el flujo: hay que
            darle al contenedor las medidas ya escaladas o el ticket se desborda. */}
        <div style={{
          width: PAPER_PX * zoom,
          height: PAPER_HEIGHT_PX * zoom,
          background: '#fff',
          boxShadow: '0 2px 18px rgba(0,0,0,0.18)',
          overflow: 'hidden',
        }}>
          <iframe
            srcDoc={html}
            title="Vista previa del ticket"
            style={{
              width: PAPER_PX,
              height: PAPER_HEIGHT_PX,
              border: 'none',
              background: '#fff',
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              display: 'block',
            }}
          />
        </div>
      </div>
    </div>
  )
}
