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

import { useMemo, useState } from 'react'
import {
  buildCorsaTicketPreviewHTML, printCorsaTicket, type TicketArgs,
} from '../lib/ticket/corsaTicket'
import { ALL_PROGRAMS } from '../lib/ticket/servicePrograms'

/** 80 mm a 96 dpi ≈ 302 px: el ancho real del papel. */
const PAPER_PX = 302
/** Alto del lienzo de previsualización; el papel real es continuo. */
const PAPER_HEIGHT_PX = 1400

const EMISOR = {
  nombreComercial: 'CORSA',
  razonSocial: 'CORSA Carwash S.A. de C.V.',
  nit: '0614-010101-000-0',
  nrc: '123456',
  direccion: 'Colonia Escalón, San Salvador, El Salvador',
  telefono: '+503 2222-1111',
  ambiente: 'AMBIENTE DE PRUEBA',
}

export function TicketPreviewPage() {
  const [servicio, setServicio] = useState('Elite')
  const [aspirado, setAspirado] = useState(true)
  const [placa, setPlaca] = useState('P123-456')
  const [vehiculo, setVehiculo] = useState('Toyota Corolla · Gris')
  const [orden, setOrden] = useState('00042')
  const [total, setTotal] = useState('18.00')
  const [conDte, setConDte] = useState(true)
  const [esCcf, setEsCcf] = useState(false)
  const [zoom, setZoom] = useState(1.5)

  const args: TicketArgs = useMemo(() => {
    const totalNum = Number(total) || 0
    return {
      emisor: EMISOR,
      operacion: { servicio, aspirado, placa, vehiculo, ordenNumero: orden },
      venta: {
        id: 'preview',
        fecha: new Date().toISOString(),
        lineas: [
          { nombre: `Lavado ${servicio}`, cantidad: 1, precioUnitario: totalNum, subtotal: totalNum },
          ...(aspirado
            ? [{ nombre: 'Aspirado incluido', cantidad: 1, precioUnitario: 0, subtotal: 0 }]
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
            selloRecibido: '2025A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4',
            qrUrl: 'https://admin.factura.gob.sv/consultaPublica?ambiente=00&codGen=A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D&fechaEmi=2026-09-08',
            fhProcesamiento: new Date().toLocaleString('es-SV'),
          }
        : undefined,
      cliente: esCcf
        ? { nombre: 'ACME S.A. de C.V.', tipoDocumento: 'NIT', numeroDocumento: '0614-010101-101-5', nrc: '234567' }
        : { nombre: 'Consumidor Final' },
      atendio: 'Mauricio J.',
    }
  }, [servicio, aspirado, placa, vehiculo, orden, total, conDte, esCcf])

  const html = useMemo(() => buildCorsaTicketPreviewHTML(args), [args])

  const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }
  const label: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }

  return (
    <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start', flexWrap: 'wrap', minHeight: '100vh', background: 'var(--bg, #f4f4f2)' }}>

      {/* ── Controles ── */}
      <div style={{ flex: '0 0 300px', background: 'var(--surface, #fff)', border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 18 }}>
        <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>Ticket térmico</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Banco de pruebas · sólo desarrollo
        </div>

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
          style={{ width: '100%', textAlign: 'center', fontSize: 13.5, fontWeight: 700, color: '#fff', background: 'var(--corsa-green, #157A52)', borderRadius: 5, padding: 10, cursor: 'pointer', border: 'none', marginTop: 6 }}
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
