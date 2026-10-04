/**
 * CORSA — el resumen de un turno de caja (0065), tal como lo devuelven
 * caja_resumen_datos / caja_reporte. Módulo puro: lo usan la app y el
 * servidor de correo.
 */
export interface MovimientoCaja {
  id: string
  tipo: 'cash_out' | 'deposit'
  monto: number
  motivo: string
  fecha: string
  registro: string
  autorizo: string | null
}

export interface ResumenCaja {
  session_id: string
  organization_id: string
  branch_id: string
  sucursal: string
  caja: string
  estado: 'open' | 'closed' | 'pending_approval'
  abierta_at: string
  abrio: string
  cerrada_at: string | null
  cerro: string | null
  efectivo_inicial: number
  ventas: { efectivo: number; tarjeta: number; transferencia: number; otros: number; total: number; cantidad: number }
  ingresos_efectivo: number
  egresos_efectivo: number
  remesa: number
  efectivo_disponible: number
  efectivo_final: number
  movimientos: MovimientoCaja[]
}

const num = (v: unknown) => Number(v ?? 0) || 0

/** Las cifras llegan de jsonb como texto o número: se normalizan una vez acá. */
export function normalizarResumen(r: any): ResumenCaja {
  return {
    ...r,
    efectivo_inicial: num(r.efectivo_inicial),
    ventas: {
      efectivo: num(r.ventas?.efectivo), tarjeta: num(r.ventas?.tarjeta), transferencia: num(r.ventas?.transferencia),
      otros: num(r.ventas?.otros), total: num(r.ventas?.total), cantidad: num(r.ventas?.cantidad),
    },
    ingresos_efectivo: num(r.ingresos_efectivo),
    egresos_efectivo: num(r.egresos_efectivo),
    remesa: num(r.remesa),
    efectivo_disponible: num(r.efectivo_disponible),
    efectivo_final: num(r.efectivo_final),
    movimientos: (r.movimientos ?? []).map((m: any) => ({ ...m, monto: num(m.monto) })),
  }
}

