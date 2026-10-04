/**
 * CORSA Carwash — Diálogo para anular una venta o cambiar su forma de pago.
 *
 * Si el usuario no tiene el permiso (sólo Super Admin y Administrador lo
 * tienen), pide el correo y la contraseña de un Super Admin, que autoriza en
 * ese momento. Ver services/ajustes-venta.service.ts.
 */

import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { fetchResponsableFijo } from '../services/fiscal.service'
import {
  autorizacionPropia, autorizarConSuperAdmin, cambiarFormaDePago, anularVenta, fetchFormasDePago,
  type FormaDePago,
} from '../services/ajustes-venta.service'

export type TipoAjuste = 'anular' | 'pago'

export interface VentaAjustable {
  order_id: string
  order_number: string
  total: number
  payment_method: string | null
  invoice_type: string | null
  fiscal_document_id: string | null
  dte_status: string
}

const campo: React.CSSProperties = {
  width: '100%', padding: '9px 11px', borderRadius: 10, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 14, boxSizing: 'border-box',
}
const etiqueta: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', margin: '12px 0 5px', display: 'block' }

export function AjusteVentaModal({ tipo, venta, tienePermiso, onCerrar, onHecho }: {
  tipo: TipoAjuste
  venta: VentaAjustable
  tienePermiso: boolean
  onCerrar: () => void
  onHecho: () => void
}) {
  const conDte = tipo === 'anular' && venta.dte_status === 'ACCEPTED'
  const [formas, setFormas] = useState<FormaDePago[]>([])
  const [codigo, setCodigo] = useState('')
  const [motivo, setMotivo] = useState('')
  const [correo, setCorreo] = useState('')
  const [contrasena, setContrasena] = useState('')
  const [enviando, setEnviando] = useState(false)

  const [responsable, setResponsable] = useState<{ nombre: string; tipoDocumento: string; numDocumento: string } | null | undefined>(undefined)
  useEffect(() => {
    if (!conDte) return
    fetchResponsableFijo().then(setResponsable).catch(() => setResponsable(null))
  }, [conDte])

  useEffect(() => {
    if (tipo !== 'pago') return
    fetchFormasDePago().then(setFormas).catch(() => toast.error('No se pudieron cargar las formas de pago'))
  }, [tipo])

  // La anulación la pide y la firma CORSA: el responsable fijo es también quien
  // la solicita. Sin responsable configurado no se puede invalidar.
  const responsableOk = !conDte || !!responsable
  const listo = !enviando && responsableOk && (tipo === 'anular' || !!codigo) &&
    (tienePermiso || (correo.trim() !== '' && contrasena !== ''))

  const confirmar = async () => {
    setEnviando(true)
    let aut = autorizacionPropia()
    try {
      if (!tienePermiso) aut = await autorizarConSuperAdmin(correo, contrasena)
      if (tipo === 'pago') {
        const r = await cambiarFormaDePago(aut, venta.order_id, codigo, motivo.trim() || null)
        toast.success(`Forma de pago de ${venta.order_number}: ${r.anterior} → ${r.nueva}`)
      } else {
        const espera = conDte ? toast.loading('Invalidando el DTE ante Hacienda (firma en la estación fiscal)…') : undefined
        try {
          const r = await anularVenta(aut,
            { orderId: venta.order_id, fiscalDocumentId: venta.fiscal_document_id, dteStatus: venta.dte_status },
            motivo.trim() || null)
          toast.success(`Venta ${venta.order_number} anulada${r.invalidado ? ' y DTE invalidado ante Hacienda' : ''}`, { id: espera })
        } catch (e) {
          if (espera) toast.dismiss(espera)
          throw e
        }
      }
      onHecho()
      onCerrar()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo completar', { duration: 10000 })
    } finally {
      setContrasena('')
      await aut.liberar()
      setEnviando(false)
    }
  }

  return (
    <div onClick={enviando ? undefined : onCerrar} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" style={{
        background: 'var(--surface)', borderRadius: 16, padding: 20, width: '100%', maxWidth: 440,
        maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--border)',
      }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 19 }}>
          {tipo === 'anular' ? 'Anular venta' : 'Cambiar forma de pago'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
          {venta.order_number} · ${Number(venta.total).toFixed(2)}{venta.payment_method ? ` · ${venta.payment_method}` : ''}
        </div>

        {tipo === 'anular' && (
          <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.55, padding: '10px 12px', borderRadius: 10,
                        background: conDte ? 'var(--color-danger-bg, #FBE7E7)' : 'var(--page-bg)',
                        color: conDte ? 'var(--color-danger-text)' : 'var(--text-secondary)' }}>
            {conDte
              ? 'Esta venta tiene DTE sellado. Se va a INVALIDAR ante Hacienda (se rescinde la operación), firmado en la estación fiscal de esta PC, y después se anula la venta. No se puede deshacer.'
              : 'La venta, su factura y su pago quedan anulados y salen de los totales. No se puede deshacer.'}
          </div>
        )}

        {tipo === 'pago' && (
          <>
            <label style={etiqueta}>Nueva forma de pago</label>
            <select value={codigo} onChange={e => setCodigo(e.target.value)} style={campo}>
              <option value="">Elegí…</option>
              {formas.filter(f => f.name !== venta.payment_method).map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
            </select>
          </>
        )}

        {conDte && (
          <>
            <label style={etiqueta}>Responsable ante Hacienda</label>
            <div style={{ fontSize: 13.5 }}>
              {responsable === undefined ? 'Cargando…'
                : responsable
                  ? <><strong>{responsable.nombre}</strong> · {responsable.tipoDocumento === '13' ? 'DUI' : 'Doc.'} {responsable.numDocumento}
                      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}> (fijo)</span></>
                  : <span style={{ color: 'var(--color-danger-text)' }}>Falta configurar el responsable fijo de las invalidaciones.</span>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
              Es también quien solicita la anulación ante Hacienda.
            </div>
          </>
        )}

        <label style={etiqueta}>Motivo (opcional)</label>
        <input style={campo} maxLength={250} value={motivo} onChange={e => setMotivo(e.target.value)}
               placeholder={tipo === 'anular' ? 'Ej.: el cliente no recibió el servicio' : 'Ej.: pagó con tarjeta, se marcó efectivo'}/>

        {!tienePermiso && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Autorización de Super Admin</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              Tu usuario no puede hacer esto por sí solo. Un Super Admin tiene que autorizarlo ahora.
            </div>
            <label style={etiqueta}>Correo del Super Admin</label>
            <input style={campo} type="email" autoComplete="off" value={correo} onChange={e => setCorreo(e.target.value)}/>
            <label style={etiqueta}>Contraseña</label>
            <input style={campo} type="password" autoComplete="new-password" value={contrasena}
                   onChange={e => setContrasena(e.target.value)}/>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCerrar} disabled={enviando}>Cancelar</button>
          <button className="btn btn-primary" style={{ flex: 1, ...(tipo === 'anular' ? { background: 'var(--color-danger-text, #c0392b)' } : {}) }}
                  onClick={confirmar} disabled={!listo}>
            {enviando ? 'Procesando…' : tipo === 'anular' ? 'Anular venta' : 'Cambiar forma de pago'}
          </button>
        </div>
      </div>
    </div>
  )
}
