/**
 * CORSA Carwash — Consulta pública del DTE en el portal del MH
 *
 * Aparte de qr.ts a propósito: armar la URL no necesita la librería de QR, y
 * quien sólo la arma (el servicio de ventas) no tiene por qué cargarla.
 */

/** Portal donde cualquiera verifica un DTE con su código de generación. */
const CONSULTA_MH = 'https://admin.factura.gob.sv/consultaPublica'

/**
 * URL de consulta pública del MH.
 *
 * `fechaEmi` va en AAAA-MM-DD, la fecha de emisión del documento —no la del
 * sello—: con otra fecha el portal responde que el documento no existe.
 */
export function urlConsultaMh(d: {
  ambiente: string
  codigoGeneracion: string
  fechaEmi: string
}): string {
  const q = new URLSearchParams({
    ambiente: d.ambiente,
    codGen: d.codigoGeneracion,
    fechaEmi: d.fechaEmi,
  })
  return `${CONSULTA_MH}?${q.toString()}`
}
