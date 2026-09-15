/**
 * CORSA Carwash — alta rápida desde la caja
 *
 * Dar de alta un cliente o un vehículo sin salir del POS. Existe por una razón
 * concreta: el cliente está parado enfrente esperando. Mandar al cajero a la
 * pantalla de Clientes significa perder la orden a medio armar y volver a
 * empezar, y significa también que nadie va a registrar al cliente — se cobra
 * como genérico y el carro nunca queda en el sistema.
 *
 * Por eso pide lo MÍNIMO para que la venta sea correcta: quién es y qué carro
 * trae. Todo lo demás —dirección, actividad económica, datos de CCF— se
 * completa después en la pantalla de Clientes, que es donde hay tiempo. Un
 * formulario de alta completo en caja se salta igual: se llena con cualquier
 * cosa para poder cobrar.
 *
 * Los dos diálogos son hoja en teléfono y modal en computadora. La diferencia
 * es sólo de presentación: los campos y las validaciones son los mismos.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useEsMovil } from '../../hooks/useEsMovil'
import {
  createCustomer, addVehicleToCustomer, fetchVehicleTypes, checkPlateConflict,
} from '../../services/customers.service'

export interface VehiculoPos {
  id: string
  plate: string
  brand?: string | null
  model?: string | null
  color?: string | null
  vehicle_type_id?: string | null
}

export interface ClientePos {
  id: string
  customer_type: string
  first_name?: string
  last_name?: string
  legal_name?: string
  trade_name?: string
  dui?: string
  nit?: string
  nrc?: string
  phone?: string
  email?: string
  vehicle?: VehiculoPos | null
}

// ─── Envoltorio: hoja en teléfono, modal en computadora ───────

function Dialogo({ titulo, children, onCerrar }: {
  titulo: string; children: React.ReactNode; onCerrar: () => void
}) {
  const esMovil = useEsMovil()

  // Escape cierra en los dos: en computadora es el reflejo de cualquiera.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCerrar])

  const cabecera = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16 }}>{titulo}</div>
      <button onClick={onCerrar} aria-label="Cerrar"
        style={{ background: 'none', border: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: 'var(--text-secondary)' }}>
        ×
      </button>
    </div>
  )

  if (esMovil) {
    return (
      <>
        <div onClick={onCerrar} style={{ position: 'fixed', inset: 0, background: 'rgba(2,20,18,0.5)', zIndex: 320 }}/>
        <div style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 321,
          background: 'var(--surface)', borderRadius: '14px 14px 0 0',
          maxHeight: '92dvh', overflowY: 'auto',
          padding: '10px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
          boxShadow: '0 -12px 40px rgba(0,0,0,0.22)',
        }}>
          <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--border)', margin: '2px auto 12px' }}/>
          {cabecera}
          {children}
        </div>
      </>
    )
  }

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onCerrar() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 320, padding: 20 }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', padding: 20,
        boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
      }}>
        {cabecera}
        {children}
      </div>
    </div>
  )
}

function Campo({ label, children, ancho }: { label: string; children: React.ReactNode; ancho?: string }) {
  return (
    <label className="field" style={{ flex: ancho ?? '1 1 100%', minWidth: 0 }}>
      <span>{label}</span>
      {children}
    </label>
  )
}

// ─── Alta de cliente ──────────────────────────────────────────

export function ModalNuevoCliente({ orgId, onCreado, onCancelar }: {
  orgId: string
  onCreado: (cliente: ClientePos) => void
  onCancelar: () => void
}) {
  const [tipo, setTipo] = useState<'individual' | 'company'>('individual')
  const [nombre, setNombre] = useState('')
  const [apellido, setApellido] = useState('')
  const [razon, setRazon] = useState('')
  const [comercial, setComercial] = useState('')
  const [doc, setDoc] = useState('')       // DUI o NIT según el tipo
  const [nrc, setNrc] = useState('')
  const [tel, setTel] = useState('')
  const [placa, setPlaca] = useState('')
  const [marca, setMarca] = useState('')
  const [modelo, setModelo] = useState('')
  const [tipoVehiculo, setTipoVehiculo] = useState('')
  const [tipos, setTipos] = useState<{ id: string; name: string }[]>([])
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    fetchVehicleTypes(orgId)
      .then(t => { setTipos(t); setTipoVehiculo(t[0]?.id ?? '') })
      .catch(() => setTipos([]))
  }, [orgId])

  const esEmpresa = tipo === 'company'
  const nombreOk = esEmpresa ? razon.trim() || comercial.trim() : nombre.trim()

  const guardar = async () => {
    if (!nombreOk) {
      toast.error(esEmpresa ? 'Ingresá la razón social o el nombre comercial' : 'Ingresá el nombre')
      return
    }
    setGuardando(true)
    try {
      const cliente = await createCustomer({
        organization_id: orgId,
        customer_type: tipo,
        first_name: esEmpresa ? null : nombre.trim(),
        last_name: esEmpresa ? null : (apellido.trim() || null),
        legal_name: esEmpresa ? (razon.trim() || comercial.trim()) : null,
        trade_name: esEmpresa ? (comercial.trim() || null) : null,
        dui: !esEmpresa && doc.trim() ? doc.trim() : null,
        nit: esEmpresa && doc.trim() ? doc.trim() : null,
        nrc: esEmpresa && nrc.trim() ? nrc.trim() : null,
        phone: tel.trim() || null,
        // Una empresa que da NIT y NRC factura con crédito fiscal; una persona,
        // consumidor final. Se deduce acá para no preguntar algo que el cajero
        // no tiene por qué decidir.
        fiscal_document_type: esEmpresa && doc.trim() && nrc.trim() ? 'ccf' : 'fcf',
      })

      let vehiculo: VehiculoPos | null = null
      if (placa.trim()) {
        const v = await addVehicleToCustomer({
          customer_id: cliente.id,
          organization_id: orgId,
          plate: placa,
          brand: marca.trim() || null,
          model: modelo.trim() || null,
          vehicle_type_id: tipoVehiculo || undefined,
        })
        vehiculo = v as VehiculoPos
      }

      toast.success('Cliente registrado')
      onCreado({ ...cliente, vehicle: vehiculo })
    } catch (e: any) {
      toast.error(e?.message ?? 'No se pudo registrar el cliente')
    }
    setGuardando(false)
  }

  return (
    <Dialogo titulo="Nuevo cliente" onCerrar={onCancelar}>
      {/* Persona o empresa: cambia qué se pide y con qué documento se factura. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
        {([
          { id: 'individual' as const, label: 'Persona natural' },
          { id: 'company' as const, label: 'Empresa' },
        ]).map(o => (
          <button key={o.id} onClick={() => setTipo(o.id)}
            style={{
              padding: '11px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 13.5, fontWeight: 600,
              border: `2px solid ${tipo === o.id ? 'var(--corsa-green)' : 'var(--border)'}`,
              background: tipo === o.id ? 'rgba(2,53,48,0.06)' : 'var(--surface)',
              color: 'var(--text-primary)', fontFamily: 'var(--font-body)',
            }}>
            {o.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {esEmpresa ? (
          <>
            <Campo label="Razón social">
              <input className="corsa-input" value={razon} onChange={e => setRazon(e.target.value)}
                     placeholder="Nombre legal de la empresa" autoFocus/>
            </Campo>
            <Campo label="Nombre comercial">
              <input className="corsa-input" value={comercial} onChange={e => setComercial(e.target.value)}
                     placeholder="Como se la conoce"/>
            </Campo>
            <Campo label="NIT" ancho="1 1 48%">
              <input className="corsa-input" value={doc} onChange={e => setDoc(e.target.value)} inputMode="numeric"/>
            </Campo>
            <Campo label="NRC" ancho="1 1 48%">
              <input className="corsa-input" value={nrc} onChange={e => setNrc(e.target.value)} inputMode="numeric"/>
            </Campo>
          </>
        ) : (
          <>
            <Campo label="Nombre" ancho="1 1 48%">
              <input className="corsa-input" value={nombre} onChange={e => setNombre(e.target.value)} autoFocus/>
            </Campo>
            <Campo label="Apellido" ancho="1 1 48%">
              <input className="corsa-input" value={apellido} onChange={e => setApellido(e.target.value)}/>
            </Campo>
            <Campo label="DUI" ancho="1 1 48%">
              <input className="corsa-input" value={doc} onChange={e => setDoc(e.target.value)} inputMode="numeric"/>
            </Campo>
          </>
        )}
        <Campo label="Teléfono" ancho="1 1 48%">
          <input className="corsa-input" value={tel} onChange={e => setTel(e.target.value)} inputMode="tel"/>
        </Campo>
      </div>

      {/* El vehículo es opcional acá, pero es lo que habilita el seguro de
          lluvia y lo que permite volver a encontrar al cliente por placa. */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div className="panel-section-label">Vehículo (opcional)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Campo label="Placa" ancho="1 1 48%">
            <input className="corsa-input font-mono" value={placa}
                   onChange={e => setPlaca(e.target.value.toUpperCase())}
                   placeholder="P123-456" style={{ textTransform: 'uppercase' }}/>
          </Campo>
          <Campo label="Tipo" ancho="1 1 48%">
            <select className="corsa-input" value={tipoVehiculo} onChange={e => setTipoVehiculo(e.target.value)}>
              {tipos.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Campo>
          <Campo label="Marca" ancho="1 1 48%">
            <input className="corsa-input" value={marca} onChange={e => setMarca(e.target.value)}/>
          </Campo>
          <Campo label="Modelo" ancho="1 1 48%">
            <input className="corsa-input" value={modelo} onChange={e => setModelo(e.target.value)}/>
          </Campo>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onCancelar}>
          Cancelar
        </button>
        <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}
                onClick={guardar} disabled={guardando}>
          {guardando ? 'Guardando…' : 'Registrar y usar'}
        </button>
      </div>
    </Dialogo>
  )
}

// ─── Alta de vehículo para un cliente existente ───────────────

export function ModalNuevoVehiculo({ orgId, clienteId, onCreado, onCancelar }: {
  orgId: string
  clienteId: string
  onCreado: (vehiculo: VehiculoPos) => void
  onCancelar: () => void
}) {
  const [placa, setPlaca] = useState('')
  const [marca, setMarca] = useState('')
  const [modelo, setModelo] = useState('')
  const [color, setColor] = useState('')
  const [tipoVehiculo, setTipoVehiculo] = useState('')
  const [tipos, setTipos] = useState<{ id: string; name: string }[]>([])
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    fetchVehicleTypes(orgId)
      .then(t => { setTipos(t); setTipoVehiculo(t[0]?.id ?? '') })
      .catch(() => setTipos([]))
  }, [orgId])

  const guardar = async () => {
    if (!placa.trim()) { toast.error('Ingresá la placa'); return }
    setGuardando(true)
    try {
      // Una placa repetida casi siempre es un carro que cambió de dueño, no un
      // error de tipeo. Se avisa y no se crea el duplicado: dos vehículos con
      // la misma placa dejan el historial partido en dos para siempre.
      const conflicto = await checkPlateConflict(placa, clienteId)
      if (conflicto) {
        toast.error('Esa placa ya está registrada con otro cliente. Transferila desde la pantalla de Clientes.')
        setGuardando(false)
        return
      }

      const v = await addVehicleToCustomer({
        customer_id: clienteId,
        organization_id: orgId,
        plate: placa,
        brand: marca.trim() || null,
        model: modelo.trim() || null,
        color: color.trim() || null,
        vehicle_type_id: tipoVehiculo || undefined,
      })
      toast.success('Vehículo agregado')
      onCreado(v as VehiculoPos)
    } catch (e: any) {
      toast.error(e?.message ?? 'No se pudo agregar el vehículo')
    }
    setGuardando(false)
  }

  return (
    <Dialogo titulo="Agregar vehículo" onCerrar={onCancelar}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <Campo label="Placa" ancho="1 1 48%">
          <input className="corsa-input font-mono" value={placa} autoFocus
                 onChange={e => setPlaca(e.target.value.toUpperCase())}
                 placeholder="P123-456" style={{ textTransform: 'uppercase' }}/>
        </Campo>
        <Campo label="Tipo" ancho="1 1 48%">
          <select className="corsa-input" value={tipoVehiculo} onChange={e => setTipoVehiculo(e.target.value)}>
            {tipos.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Campo>
        <Campo label="Marca" ancho="1 1 48%">
          <input className="corsa-input" value={marca} onChange={e => setMarca(e.target.value)}/>
        </Campo>
        <Campo label="Modelo" ancho="1 1 48%">
          <input className="corsa-input" value={modelo} onChange={e => setModelo(e.target.value)}/>
        </Campo>
        <Campo label="Color" ancho="1 1 48%">
          <input className="corsa-input" value={color} onChange={e => setColor(e.target.value)}/>
        </Campo>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onCancelar}>
          Cancelar
        </button>
        <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}
                onClick={guardar} disabled={guardando}>
          {guardando ? 'Guardando…' : 'Agregar y usar'}
        </button>
      </div>
    </Dialogo>
  )
}

// ─── Selector de vehículos del cliente ────────────────────────

/**
 * Los carros del cliente, para elegir con cuál entra.
 *
 * Un cliente con tres carros cobrados siempre sobre el primero es un historial
 * inservible —y, con seguro de lluvia, una póliza emitida sobre la placa
 * equivocada—. Por eso se muestran todos y se elige, en vez de asumir.
 */
export function SelectorVehiculos({ vehiculos, elegido, onElegir, onAgregar }: {
  vehiculos: VehiculoPos[]
  elegido: VehiculoPos | null
  onElegir: (v: VehiculoPos) => void
  onAgregar: () => void
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="panel-section-label" style={{ marginBottom: 6 }}>
        {vehiculos.length === 0 ? 'Sin vehículos registrados' : 'Vehículo'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {vehiculos.map(v => {
          const sel = elegido?.id === v.id
          return (
            <button key={v.id} onClick={() => onElegir(v)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                padding: '7px 11px', borderRadius: 6, cursor: 'pointer', minHeight: 44,
                border: `2px solid ${sel ? 'var(--corsa-green)' : 'var(--border)'}`,
                background: sel ? 'rgba(2,53,48,0.06)' : 'var(--surface)',
                fontFamily: 'var(--font-body)', textAlign: 'left',
              }}>
              <span className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                {v.plate}
              </span>
              {(v.brand || v.model) && (
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {[v.brand, v.model].filter(Boolean).join(' ')}
                </span>
              )}
            </button>
          )
        })}

        <button onClick={onAgregar}
          style={{
            padding: '7px 11px', borderRadius: 6, cursor: 'pointer', minHeight: 44,
            border: '1.5px dashed var(--border)', background: 'transparent',
            color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600,
            fontFamily: 'var(--font-body)',
          }}>
          + Agregar vehículo
        </button>
      </div>
    </div>
  )
}
