/**
 * CORSA Carwash — Servicio facturado → programa de la máquina de lavado.
 *
 * El ticket no es sólo el comprobante fiscal: es la orden de trabajo que lee
 * el equipo en piso para saber qué programa activar. Por eso el número va
 * gigante en la cabecera, legible de un vistazo y sin desdoblar el papel.
 *
 * PENDIENTE: esto debería vivir en una columna de `services` (por ejemplo
 * `machine_program smallint`) para que se configure sin tocar código. Se deja
 * acá mientras se define el catálogo real de servicios: hoy la tabla sembrada
 * en 0009_services.sql trae LAV-BASIC / LAV-COMP / LAV-PREM, no estos tiers.
 */

export interface ServiceProgram {
  /** Número que el operario marca en la máquina. */
  program: 1 | 2 | 3
  /** Nombre comercial del tier, como se imprime debajo del número. */
  label: string
}

/** Clave normalizada (minúsculas, sin acentos) → programa. */
const PROGRAMS: Record<string, ServiceProgram> = {
  pro:       { program: 1, label: 'PRO' },
  elite:     { program: 2, label: 'ELITE' },
  signature: { program: 3, label: 'SIGNATURE' },
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * Resuelve el programa a partir del nombre o código del servicio.
 *
 * Busca el tier como palabra dentro del texto, así que tolera nombres reales
 * como "Lavado Elite" o "CORSA Signature". Devuelve null si no reconoce
 * ninguno — el ticket entonces omite el número en vez de inventar uno, que
 * sería peor: mandaría al operario a activar el programa equivocado.
 */
export function resolveServiceProgram(
  serviceNameOrCode: string | null | undefined
): ServiceProgram | null {
  if (!serviceNameOrCode) return null
  const text = normalize(serviceNameOrCode)
  for (const [key, program] of Object.entries(PROGRAMS)) {
    if (new RegExp(`\\b${key}\\b`).test(text)) return program
  }
  return null
}

/** Los tres tiers, para poblar selectores. */
export const ALL_PROGRAMS: ServiceProgram[] = Object.values(PROGRAMS)
  .sort((a, b) => a.program - b.program)
