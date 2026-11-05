/**
 * CORSA — Cuponera Digital de demostración (/dev/cuponera).
 *
 * La misma interfaz que el portal real (PortalApi) con datos en memoria: sirve
 * para ver y probar el portal sin base, sin sesión y sin mandar correos. Sólo
 * se monta en desarrollo.
 */
import type {
  CuponPortal, EntregaCuponera, EntregarInput, PortalApi, ResumenPortal, TipoCupon,
} from '../services/cuponera.service'

const EMPRESA = 'Distribuidora La Ceiba, S.A. de C.V.'
const PERSONAS = [
  ['María López', 'maria.lopez@laceiba.com.sv'], ['José Hernández', 'jose.hernandez@laceiba.com.sv'],
  ['Ana Martínez', 'ana.martinez@laceiba.com.sv'], ['Carlos Rivera', 'carlos.rivera@laceiba.com.sv'],
  ['Lucía Flores', null], ['Roberto Pérez', 'roberto.perez@laceiba.com.sv'],
] as const

const espera = (ms = 350) => new Promise(r => setTimeout(r, ms))

export function crearDemo(opciones: { conSesion?: boolean } = {}): PortalApi {
  let sesion = opciones.conSesion ?? false
  let debeCambiar = false
  const cupones: CuponPortal[] = []
  const entregas: EntregaCuponera[] = []
  let seq = 4120

  const lote = (n: number, service_code: string, service_name: string, size: string, aspirado: boolean, valor: number, dias: number) => {
    const batch = crypto.randomUUID()
    for (let i = 0; i < n; i++) {
      seq++
      cupones.push({
        id: crypto.randomUUID(), code: String(100000 + ((seq * 7919) % 900000)), sequence_number: seq,
        validation_token: crypto.randomUUID(), status: 'active', estado: 'pendiente',
        service_code, service_name, size, includes_aspirado: aspirado, is_gift: false, unit_value: valor,
        created_at: new Date(Date.now() - dias * 864e5).toISOString(), redeemed_at: null,
        batch_id: batch, batch_quantity: n, customer_name: EMPRESA,
        entrega_id: null, entregado_a: null, entregado_correo: null, entregado_at: null,
      })
    }
  }
  lote(300, 'ELITE', 'ÉLITE', 'M', false, 14, 40)
  lote(150, 'SIGNATURE', 'SIGNATURE', 'L', true, 21, 12)

  const entregarInterno = (i: EntregarInput, dias = 0): EntregaCuponera => {
    const libres = cupones.filter(c => c.estado === 'pendiente' && c.service_code === i.tipo.service_code
      && c.size === i.tipo.size && c.includes_aspirado === i.tipo.includes_aspirado).slice(0, i.cantidad)
    if (libres.length < i.cantidad) throw new Error(libres.length ? `Sólo quedan ${libres.length} cupones pendientes de ese tipo` : 'No quedan cupones pendientes de ese tipo')
    const e: EntregaCuponera = {
      id: crypto.randomUUID(), destinatario_nombre: i.nombre, destinatario_correo: i.correo, nota: i.nota ?? null,
      cantidad: i.cantidad, created_at: new Date(Date.now() - dias * 864e5).toISOString(), entregado_por: 'Andrea Castillo',
      codigos: libres.map(c => c.code),
      servicios: `${libres[0].service_name} ${libres[0].size}${libres[0].includes_aspirado ? ' + aspirado' : ''}`,
      redimidos: 0, correo_estado: i.correo ? 'sent' : null, correo_at: i.correo ? new Date().toISOString() : null,
      correo_error: null, correos_enviados: i.correo ? 1 : 0,
    }
    for (const c of libres) {
      Object.assign(c, { estado: 'entregado', entrega_id: e.id, entregado_a: i.nombre, entregado_correo: i.correo, entregado_at: e.created_at })
    }
    entregas.unshift(e)
    return e
  }

  // Historia: 6 entregas de los últimos días, algunas ya canjeadas.
  PERSONAS.forEach(([nombre, correo], k) => {
    const elite = k % 3 !== 2
    const e = entregarInterno({
      nombre, correo, cantidad: elite ? 4 + k * 3 : 2,
      tipo: elite ? { service_code: 'ELITE', size: 'M', includes_aspirado: false } : { service_code: 'SIGNATURE', size: 'L', includes_aspirado: true },
    }, 9 - k)
    const usados = cupones.filter(c => c.entrega_id === e.id).slice(0, Math.ceil(e.cantidad * 0.6))
    for (const c of usados) Object.assign(c, { status: 'redeemed', estado: 'redimido', redeemed_at: new Date(Date.now() - (6 - k) * 864e5).toISOString() })
    e.redimidos = usados.length
  })

  const resumen = (): ResumenPortal => {
    const vivos = cupones.filter(c => c.estado !== 'anulado')
    const tipos = new Map<string, TipoCupon>()
    for (const c of cupones) {
      const k = `${c.service_code}|${c.size}|${c.includes_aspirado}`
      const t = tipos.get(k) ?? { service_code: c.service_code, service_name: c.service_name, size: c.size, includes_aspirado: c.includes_aspirado, comprados: 0, pendientes: 0 }
      t.comprados++
      if (c.estado === 'pendiente') t.pendientes++
      tipos.set(k, t)
    }
    return {
      usuario: { nombre: 'Andrea Castillo', correo: 'andrea.castillo@laceiba.com.sv', debe_cambiar_clave: debeCambiar },
      cliente: { nombre: EMPRESA },
      totales: {
        comprados: vivos.length,
        entregados: vivos.filter(c => c.entrega_id).length,
        pendientes: cupones.filter(c => c.estado === 'pendiente').length,
        redimidos: cupones.filter(c => c.estado === 'redimido').length,
        anulados: cupones.filter(c => c.estado === 'anulado').length,
      },
      tipos: [...tipos.values()],
    }
  }

  return {
    async haySesion() { return sesion },
    async ingresar(correo, clave) {
      await espera()
      if (!correo || clave.length < 4) return 'Correo o contraseña incorrectos'
      sesion = true
      return null
    },
    async salir() { sesion = false },
    async resumen() { await espera(150); return resumen() },
    async cupones(estado, buscar) {
      await espera(150)
      const q = buscar?.trim().toLowerCase()
      return cupones.filter(c => (estado === null || c.estado === estado || (estado === 'entregado' && c.entrega_id && c.estado !== 'anulado'))
        && (!q || c.code.includes(q) || c.entregado_a?.toLowerCase().includes(q) || c.entregado_correo?.toLowerCase().includes(q)))
    },
    async cuponesDeEntrega(id) { return cupones.filter(c => c.entrega_id === id) },
    async entregas() { await espera(150); return [...entregas] },
    async entregar(i) {
      await espera()
      const e = entregarInterno(i)
      e.correo_estado = null; e.correo_at = null; e.correos_enviados = 0
      return { entrega_id: e.id, cupones: cupones.filter(c => c.entrega_id === e.id) }
    },
    async enviarCorreo(id) {
      await espera(900)
      const e = entregas.find(x => x.id === id)
      if (e) { e.correo_estado = 'sent'; e.correo_at = new Date().toISOString(); e.correos_enviados++ }
      return { ok: true, estado: 'sent', destinatarios: e?.destinatario_correo ? [e.destinatario_correo] : [] }
    },
    async cambiarClave() { await espera(); debeCambiar = false; return null },
  }
}
