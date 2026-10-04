/**
 * Los vehículos de UN cliente, desde su ficha en Clientes.
 *
 * Muestra sólo los carros registrados a ese cliente y los agrega con el alta
 * general (la misma del POS): placa, tamaño —que es la tarifa—, marca, modelo
 * y color. Antes la ficha tenía una placa y una marca sueltas que creaban el
 * carro sin tamaño, y en caja había que corregirlo.
 *
 * Si la placa ya es de otro cliente, se ofrece transferirla: casi siempre es
 * un carro que cambió de dueño, y duplicarlo parte su historial en dos.
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import {
  getCustomerVehicles, transferVehicleOwnership, type TamanoVehiculo,
} from '../services/customers.service'
import { supabase } from '../lib/supabase'
import { Dialogo, ModalNuevoVehiculo } from './pos/AltaRapida'
import type { Vehicle } from '../types'

export function VehiculosClienteModal({ orgId, customerId, customerName, onCerrar, onCambio }: {
  orgId: string
  customerId: string
  customerName: string
  onCerrar: () => void
  /** Se agregó o transfirió un carro: la ficha de atrás se recarga. */
  onCambio: () => void
}) {
  const [vehiculos, setVehiculos] = useState<Vehicle[]>([])
  const [cargando, setCargando] = useState(true)
  const [tamanoDe, setTamanoDe] = useState<Record<string, TamanoVehiculo>>({})
  const [alta, setAlta] = useState(false)
  const [transferir, setTransferir] = useState<{ placa: string; vehicleId: string; dueno: string } | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    try { setVehiculos(await getCustomerVehicles(customerId)) } catch { setVehiculos([]) }
    setCargando(false)
  }, [customerId])

  useEffect(() => { cargar() }, [cargar])

  // Qué tarifa (S/M/L) es cada tipo de vehículo, para mostrarla en la lista.
  useEffect(() => {
    ;(async () => {
      const { data } = await (supabase as any).from('vehicle_types').select('id, size_category').eq('organization_id', orgId)
      const m: Record<string, TamanoVehiculo> = {}
      for (const t of data ?? []) m[t.id] = t.size_category === 'small' ? 'S' : t.size_category === 'medium' ? 'M' : 'L'
      setTamanoDe(m)
    })()
  }, [orgId])

  const confirmarTransferencia = async () => {
    if (!transferir) return
    try {
      await transferVehicleOwnership(transferir.vehicleId, customerId)
      toast.success(`${transferir.placa} transferido a ${customerName}`)
      setTransferir(null); setAlta(false)
      await cargar(); onCambio()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo transferir el vehículo')
    }
  }

  // Al body: la ficha vive en un panel lateral y el diálogo es pantalla completa.
  return createPortal(
    <>
      <Dialogo titulo={`Vehículos · ${customerName}`} onCerrar={onCerrar}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cargando && <div className="spinner" style={{ width: 18, height: 18 }}/>}
          {!cargando && vehiculos.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Este cliente todavía no tiene vehículos registrados.</div>
          )}
          {vehiculos.map(v => (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 12 }}>
              <span className="font-mono" style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: 0.5 }}>{v.plate ?? '—'}</span>
              {tamanoDe[v.vehicle_type_id] && (
                <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800, fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'var(--subtle-bg)', color: 'var(--text-secondary)' }}>
                  {tamanoDe[v.vehicle_type_id]}
                </span>
              )}
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[v.brand, v.model, v.color, v.year].filter(Boolean).join(' · ') || '—'}
              </span>
            </div>
          ))}
        </div>

        {transferir && (
          <div className="alert-banner danger" style={{ marginTop: 12 }}>
            <div className="alert-body">
              <div style={{ fontSize: 12.5 }}>La placa {transferir.placa} ya está registrada a nombre de {transferir.dueno}.</div>
              <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
                <a href="#" onClick={e => { e.preventDefault(); confirmarTransferencia() }} style={{ fontSize: 12.5, fontWeight: 600 }}>Transferir a este cliente</a>
                <a href="#" onClick={e => { e.preventDefault(); setTransferir(null) }} style={{ fontSize: 12.5 }}>Cancelar</a>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={onCerrar}>Cerrar</button>
          <button id="btn-vehiculo-nuevo" className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={() => setAlta(true)}>
            + Agregar vehículo
          </button>
        </div>
      </Dialogo>

      {alta && (
        <ModalNuevoVehiculo orgId={orgId} clienteId={customerId} textoGuardar="Agregar vehículo"
          onCancelar={() => setAlta(false)}
          onCreado={async () => { setAlta(false); await cargar(); onCambio() }}
          onPlacaDeOtro={async c => {
            const { data } = await (supabase as any).from('customers')
              .select('customer_type, first_name, last_name, trade_name, legal_name').eq('id', c.duenoId).maybeSingle()
            const dueno = !data ? 'otro cliente'
              : data.customer_type === 'individual' ? `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim()
              : (data.trade_name || data.legal_name || 'otro cliente')
            setAlta(false)
            setTransferir({ placa: c.placa.toUpperCase(), vehicleId: c.vehicleId, dueno })
          }}/>
      )}
    </>,
    document.body,
  )
}
