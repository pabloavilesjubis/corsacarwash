/**
 * CORSA Carwash — el día, en hora del carwash.
 *
 * Todo lo que en este sistema significa «hoy» es el día de El Salvador, no el
 * día UTC ni el del reloj de la computadora que abrió el tablero.
 *
 * Por qué existe este archivo: `new Date().toISOString().slice(0, 10)` devuelve
 * la fecha UTC. El Salvador es UTC−6, así que a partir de las 6 de la tarde —
 * en plena hora pico del carwash — esa expresión ya devuelve MAÑANA. Las
 * consultas que la usaban pedían las ventas de un día que todavía no empieza y
 * el tablero mostraba US$0.00 con el local lleno de carros.
 *
 * El otro lado del mismo error es usar la zona del navegador. Es correcta
 * mientras la máquina esté en el local y tenga bien la zona, y deja de serlo en
 * cuanto alguien abre el tablero desde afuera del país o con la zona mal
 * configurada: el turno se partiría en dos días distintos según quién mire.
 * Acá la zona del negocio está fija y no depende del dispositivo.
 *
 * El Salvador no tiene horario de verano, pero nada de esto lo da por sentado:
 * el desfase se pregunta con Intl, que conoce la base de datos de zonas.
 */

/** La zona del negocio. Un solo lugar donde cambiarla si algún día hay sucursal afuera. */
export const ZONA_CORSA = 'America/El_Salvador'

/** en-CA formatea como YYYY-MM-DD, que es justo lo que espera Postgres en una columna `date`. */
const FMT_ISO = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_CORSA,
  year: 'numeric', month: '2-digit', day: '2-digit',
})

const FMT_PARTES = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA_CORSA,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/**
 * Cuántos minutos adelanta la hora del carwash respecto de UTC en ese instante.
 * Negativo acá (−360). Se lee el reloj de pared de la zona y se lo interpreta
 * como si fuera UTC: la diferencia contra el instante real es el desfase.
 */
function desfaseMinutos(instante: Date): number {
  const p = FMT_PARTES.formatToParts(instante)
  const v = (tipo: string) => Number(p.find(x => x.type === tipo)?.value ?? 0)
  const comoSiFueraUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'))
  // Los milisegundos del instante no participan del desfase; se descartan para
  // que la resta dé un múltiplo exacto de minuto.
  return (comoSiFueraUtc - Math.floor(instante.getTime() / 1000) * 1000) / 60000
}

/** La fecha del carwash (YYYY-MM-DD) en la que cae ese instante. */
export function fechaLocalDe(instante: Date = new Date()): string {
  return FMT_ISO.format(instante)
}

/** Hoy en el carwash, como YYYY-MM-DD. Esto es lo que va en cualquier columna `date`. */
export function hoyLocal(): string {
  return fechaLocalDe()
}

/**
 * Suma (o resta) días de calendario a una fecha YYYY-MM-DD.
 *
 * La cuenta se hace en UTC a propósito: sobre una fecha sin hora, UTC no tiene
 * saltos que puedan comerse un día. Sumarle 86.400.000 ms a un instante sí los
 * tiene en zonas con horario de verano.
 */
export function sumarDias(fecha: string, dias: number): string {
  const [a, m, d] = fecha.split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10)
}

/**
 * El lunes de la semana en la que cae esa fecha, como YYYY-MM-DD.
 *
 * La semana del carwash arranca en lunes porque así la lee el equipo de piso, y
 * porque es también donde `date_trunc('week', …)` corta en Postgres — los dos
 * lados coinciden sin tener que acordarse.
 *
 * La cuenta va en UTC, igual que `sumarDias`: sobre una fecha sin hora no hay
 * saltos de horario de verano que puedan comerse un día. `getUTCDay()` devuelve
 * 0 para domingo, así que el domingo retrocede seis días y no uno — si no, el
 * domingo abriría una semana nueva él solo.
 */
export function inicioDeSemanaLocal(fecha: string = hoyLocal()): string {
  const [a, m, d] = fecha.split('-').map(Number)
  const dia = new Date(Date.UTC(a!, m! - 1, d!)).getUTCDay()
  return sumarDias(fecha, -(dia === 0 ? 6 : dia - 1))
}

/**
 * El instante exacto en que empieza ese día en el carwash, en ISO.
 *
 * Es lo que hay que comparar contra una columna `timestamptz` (created_at,
 * started_at). Mandar `'2026-09-14T00:00:00'` sin zona deja que el servidor
 * decida cuál medianoche es, y el servidor piensa en UTC: seis horas de
 * diferencia, que son las seis horas de más trabajo del día.
 */
export function inicioDelDiaISO(fecha: string = hoyLocal()): string {
  const [a, m, d] = fecha.split('-').map(Number)
  const medianocheDePared = Date.UTC(a, m - 1, d, 0, 0, 0)
  // Dos pasadas: la primera estima el desfase con un instante aproximado, la
  // segunda lo confirma con el instante ya corregido. Importa sólo en zonas
  // donde el cambio de horario cae de madrugada; acá es gratis y evita tener
  // que recordar que El Salvador es la excepción.
  const aprox = new Date(medianocheDePared - desfaseMinutos(new Date(medianocheDePared)) * 60000)
  return new Date(medianocheDePared - desfaseMinutos(aprox) * 60000).toISOString()
}

/** El instante en que empieza el día siguiente: el límite superior, exclusivo. */
export function finDelDiaISO(fecha: string = hoyLocal()): string {
  return inicioDelDiaISO(sumarDias(fecha, 1))
}

/** Fecha legible (13 sep 2026). Siempre en hora del carwash, mire quien mire. */
export function formatearFecha(
  iso: string | Date,
  opciones: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' },
): string {
  return new Date(iso).toLocaleDateString('es-SV', { timeZone: ZONA_CORSA, ...opciones })
}

/** Fecha y hora legibles. Siempre en hora del carwash. */
export function formatearFechaHora(
  iso: string | Date,
  opciones: Intl.DateTimeFormatOptions = {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  },
): string {
  return new Date(iso).toLocaleString('es-SV', { timeZone: ZONA_CORSA, ...opciones })
}
