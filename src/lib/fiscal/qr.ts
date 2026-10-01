/**
 * CORSA Carwash — QR de consulta pública del DTE
 *
 * El QR se dibuja acá, como SVG, en vez de pedírselo a un servicio externo:
 *
 *   - El código de generación no tiene por qué salir hacia un tercero cada vez
 *     que se imprime un ticket.
 *   - El ticket se imprime en el mostrador con la red que haya. Una imagen
 *     remota que no terminó de bajar cuando salta el diálogo de impresión sale
 *     como un hueco, y el cliente se va sin poder verificar su factura.
 *   - Un SVG de módulos cuadrados es negro puro: la térmica lo imprime nítido
 *     a cualquier tamaño, sin el gris del reescalado de un PNG.
 */

import QRCode from 'qrcode'

/**
 * El QR como `<svg>` en línea.
 *
 * Un solo `<path>` con todos los módulos: cientos de `<rect>` sueltos dejan
 * finas costuras blancas entre módulos vecinos al rasterizar. `crispEdges`
 * evita el antialias en los bordes, que en térmica sale como borde gris.
 */
export function qrSvg(texto: string, opts: { color?: string; margen?: number } = {}): string {
  const color = opts.color ?? '#000'
  const margen = opts.margen ?? 2
  // Nivel M: la URL entra en una versión chica y aguanta una mancha o un
  // pliegue del papel.
  const { modules } = QRCode.create(texto, { errorCorrectionLevel: 'M' })
  const n = modules.size
  const lado = n + margen * 2

  let d = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.get(y, x)) d += `M${x + margen} ${y + margen}h1v1h-1z`
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" `
    + `shape-rendering="crispEdges" role="img" aria-label="Código QR de verificación">`
    + `<rect width="${lado}" height="${lado}" fill="#fff"/>`
    + `<path d="${d}" fill="${color}"/></svg>`
}
