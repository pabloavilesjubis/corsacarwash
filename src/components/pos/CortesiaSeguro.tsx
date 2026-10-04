/**
 * CORSA Carwash — seguro de lluvia de cortesía, sin orden
 *
 * El botón «Cortesía» del POS fuera de una orden abre esto: se elige al
 * cliente y el carro, se emite la póliza de cortesía (0053) y sale el ticket
 * de cortesía. Con una orden armada el mismo botón no abre nada: marca la
 * cortesía para que se agregue al cobrar.
 *
 * Pide lo mismo que el seguro vendido —cliente identificado y vehículo con
 * placa— porque es la misma obligación: sin titular ni placa no hay a quién
 * reconocerle el lavado.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '../../lib/supabase'
import { imprimirTicketEnSegundoPlano } from '../../lib/ticket/corsaTicket'
import { emisorParaTicket } from '../../lib/fiscal/emisor'
import { darCortesia } from '../../services/rain.service'
import { getCustomerVehicles } from '../../services/customers.service'
import { formatearFechaHora } from '../../utils/fecha'
import { Dialogo, ModalNuevoVehiculo, SelectorVehiculos, type VehiculoPos } from './AltaRapida'

interface Cliente {
  id: string
  customer_type: string
  first_name?: string; last_name?: string
  trade_name?: string; legal_name?: string
  phone?: string
  /** Si se encontró por placa, el carro de esa placa. */
  vehicle?: VehiculoPos | null
}

const COLUMNAS = 'id,customer_type,first_name,last_name,trade_name,legal_name,phone'

function nombre(c: Cliente): string {
  if (c.customer_type === 'individual') return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Cliente'
  return c.trade_name ?? c.legal_name ?? 'Cliente'
}

export function ModalCortesiaSeguro({ branchId, orgId, onCerrar }: {
  branchId: string
  orgId: string | null
  onCerrar: () => void
}) {
  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState<Cliente[]>([])
  const [buscando, setBuscando] = useState(false)
  const [cliente, setCliente] = useState<Cliente | null>(null)
  const [vehiculos, setVehiculos] = useState<VehiculoPos[]>([])
  const [vehiculo, setVehiculo] = useState<VehiculoPos | null>(null)
  const [altaVehiculo, setAltaVehiculo] = useState(false)
  const [guardando, setGuardando] = useState(false)

  // Por nombre o por placa, como el buscador de la caja.
  useEffect(() => {
    const q = query.replace(/[,()]/g, ' ').trim()
    if (q.length < 2) { setResultados([]); return }
    let vivo = true
    const t = setTimeout(async () => {
      setBuscando(true)
      try {
        const esPlaca = /^[a-zA-Z]\s?\d/.test(q)
        let filas: Cliente[] = []
        if (esPlaca) {
          const { data } = await (supabase as any)
            .from('vehicles').select(`id,plate,brand,model,color,customers(${COLUMNAS})`)
            .ilike('plate', `%${q.replace(/\s/g, '')}%`).limit(6)
          filas = (data ?? []).filter((v: any) => v.customers).map((v: any) => ({
            ...v.customers, vehicle: { id: v.id, plate: v.plate, brand: v.brand, model: v.model, color: v.color },
          }))
        } else {
          const { data } = await (supabase as any)
            .from('customers').select(COLUMNAS)
            .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,trade_name.ilike.%${q}%,legal_name.ilike.%${q}%`).limit(8)
          filas = data ?? []
        }
        if (vivo) setResultados(filas)
      } catch {
        if (vivo) setResultados([])
      }
      if (vivo) setBuscando(false)
    }, 350)
    return () => { vivo = false; clearTimeout(t) }
  }, [query])

  // Los carros del cliente elegido; el de la placa buscada queda preseleccionado.
  useEffect(() => {
    if (!cliente) { setVehiculos([]); setVehiculo(null); return }
    let vivo = true
    getCustomerVehicles(cliente.id)
      .then(vs => {
        if (!vivo) return
        const lista = (vs ?? []) as VehiculoPos[]
        setVehiculos(lista)
        setVehiculo(lista.find(v => v.id === cliente.vehicle?.id) ?? lista[0] ?? null)
      })
      .catch(() => { if (vivo) { setVehiculos([]); setVehiculo(null) } })
    return () => { vivo = false }
  }, [cliente])

  const listo = !!cliente && !!vehiculo?.plate && !guardando

  const generar = async () => {
    if (!cliente || !vehiculo) return
    setGuardando(true)
    try {
      const p = await darCortesia({ branchId, customerId: cliente.id, vehicleId: vehiculo.id })
      try {
        const emisor = await emisorParaTicket(branchId, false)
        await imprimirTicketEnSegundoPlano({
          emisor,
          venta: { id: p.id, fecha: p.issued_at, lineas: [], total: 0 },
          operacion: { servicio: '', aspirado: false, placa: p.plate },
          cortesia: { clienteNombre: p.customer_name, fecha: formatearFechaHora(p.issued_at) },
          seguroLluvia: { placa: p.plate, desde: p.issued_at, hasta: p.valid_until, cortesia: true },
        })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'La cortesía quedó registrada, pero no se pudo imprimir el ticket')
      }
      toast.success(`Cortesía registrada · seguro de lluvia ${p.plate}`)
      onCerrar()
    } catch (e: any) {
      toast.error(e?.message ?? 'No se pudo registrar la cortesía')
      setGuardando(false)
    }
  }

  return (
    <>
      <Dialogo titulo="Cortesía · seguro de lluvia" onCerrar={onCerrar}>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 12 }}>
          48 horas de cobertura sin costo: si llueve, el mismo vehículo vuelve por un PRO.
          Se registra en Seguros de lluvia como cortesía.
        </div>

        {cliente ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, border: '1.5px solid var(--corsa-green)', background: 'var(--subtle-bg)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{nombre(cliente)}</div>
              {cliente.phone && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{cliente.phone}</div>}
            </div>
            <button onClick={() => { setCliente(null); setQuery('') }} aria-label="Cambiar cliente"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>×</button>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 12, padding: '9px 12px', background: 'var(--page-bg)' }}>
              {buscando ? <div className="spinner" style={{ width: 14, height: 14 }}/> : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              )}
              <input id="cortesia-buscar" value={query} onChange={e => setQuery(e.target.value)} autoFocus
                placeholder="Nombre o placa del cliente…"
                style={{ border: 'none', outline: 'none', fontSize: 13.5, flex: 1, background: 'transparent', color: 'var(--text-primary)', fontFamily: 'var(--font-body)' }}/>
            </div>
            {query.trim().length >= 2 && !buscando && resultados.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                Ningún cliente coincide. Si no existe, créalo con «+ Nuevo cliente» en la caja.
              </div>
            )}
            {resultados.length > 0 && (
              <div style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', maxHeight: 240, overflowY: 'auto' }}>
                {resultados.map((c, i) => (
                  <button key={c.id + i} onClick={() => { setCliente(c); setResultados([]) }}
                    style={{ width: '100%', display: 'block', padding: '9px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', borderBottom: i < resultados.length - 1 ? '1px solid var(--border)' : 'none', fontFamily: 'var(--font-body)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{nombre(c)}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{c.vehicle?.plate ?? c.phone ?? ''}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {cliente && (
          <SelectorVehiculos vehiculos={vehiculos} elegido={vehiculo} onElegir={setVehiculo}
            onAgregar={() => setAltaVehiculo(true)}/>
        )}
        {cliente && vehiculo && !vehiculo.plate && (
          <div style={{ fontSize: 12, color: 'var(--color-warning-text)', marginTop: 6 }}>
            Ese vehículo no tiene placa: sin placa el seguro no se puede reclamar.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
          <button id="cortesia-generar" className="btn btn-primary" onClick={generar} disabled={!listo}>
            {guardando ? 'Generando…' : 'Generar ticket de cortesía'}
          </button>
        </div>
      </Dialogo>

      {altaVehiculo && orgId && cliente && (
        <ModalNuevoVehiculo orgId={orgId} clienteId={cliente.id}
          onCreado={v => { setVehiculos(vs => [v, ...vs]); setVehiculo(v); setAltaVehiculo(false) }}
          onCancelar={() => setAltaVehiculo(false)}/>
      )}
    </>
  )
}
