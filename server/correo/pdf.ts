/**
 * HTML → PDF con Chrome sin interfaz.
 *
 * La factura carta y el estado de cuenta ya existen como HTML (los mismos que
 * la app imprime): se renderizan acá para que el adjunto del correo sea
 * idéntico al papel. En Vercel el Chrome viene de @sparticuz/chromium; en una
 * máquina de desarrollo, de CHROME_PATH.
 */
import chromium from '@sparticuz/chromium'
import puppeteer, { type Browser } from 'puppeteer-core'

export async function abrirNavegador(): Promise<Browser> {
  const local = process.env.CHROME_PATH
  return puppeteer.launch({
    args: local ? ['--no-sandbox', '--disable-gpu'] : chromium.args,
    executablePath: local || await chromium.executablePath(),
    headless: true,
  })
}

/** Imprime el HTML a PDF tamaño carta, con fondos (la marca va en tinta). */
export async function htmlAPdf(navegador: Browser, html: string): Promise<Buffer> {
  const pagina = await navegador.newPage()
  try {
    // El HTML de la factura se auto-imprime al cargar; acá no hay diálogo.
    await pagina.evaluateOnNewDocument('window._corsaPreview = true; window.print = function () {};')
    await pagina.setContent(html, { waitUntil: 'load', timeout: 25_000 })
    await pagina.evaluate('document.fonts ? document.fonts.ready : null')
    const pdf = await pagina.pdf({ format: 'letter', printBackground: true, preferCSSPageSize: true })
    return Buffer.from(pdf)
  } finally {
    await pagina.close()
  }
}
