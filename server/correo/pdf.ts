/**
 * HTML → PDF con Chrome sin interfaz.
 *
 * La factura carta y el estado de cuenta ya existen como HTML (los mismos que
 * la app imprime): se renderizan acá para que el adjunto del correo sea
 * idéntico al papel. En Vercel el Chrome viene de @sparticuz/chromium; en una
 * máquina de desarrollo, de CHROME_PATH.
 *
 * PESO: una factura salía de 204 KB y ahora de ~65 KB, con el mismo aspecto.
 *   · Google Fonts le sirve a Chrome las fuentes *variables* (un archivo para
 *     todos los pesos), y Chrome las incrusta en el PDF como Type3: cada letra
 *     un objeto aparte. Las mismas familias en TTF estáticos (lo que Google
 *     sirve a un cliente que no es navegador) se incrustan como TrueType
 *     recortado a las letras usadas.
 *   · Sin PDF etiquetado (árbol de accesibilidad), que nadie usa en una factura.
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

const LINK_GOOGLE_FONTS = /<link\b[^>]*href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"[^>]*>/g

/** El CSS de cada URL de Google Fonts, ya con los TTF estáticos. Vive lo que la función. */
const cssEstatico = new Map<string, Promise<string | null>>()

function pedirCssEstatico(url: string): Promise<string | null> {
  let p = cssEstatico.get(url)
  if (!p) {
    // fetch de Node no se presenta como navegador: Google responde con TTF estáticos.
    p = fetch(url.replace(/&amp;/g, '&'), { signal: AbortSignal.timeout(5_000) })
      .then(r => (r.ok ? r.text() : null))
      .then(css => (css && /format\('truetype'\)/.test(css) ? css : null))
      .catch(() => null)
    p.then(css => { if (!css) cssEstatico.delete(url) })
    cssEstatico.set(url, p)
  }
  return p
}

/** Cambia los <link> de Google Fonts por su CSS de fuentes estáticas. Si falla, queda el link. */
async function conFuentesEstaticas(html: string): Promise<string> {
  const urls = [...new Set([...html.matchAll(LINK_GOOGLE_FONTS)].map(m => m[1]))]
  if (urls.length === 0) return html
  const css = new Map(await Promise.all(urls.map(async u => [u, await pedirCssEstatico(u)] as const)))
  return html.replace(LINK_GOOGLE_FONTS, (tag, url) => {
    const c = css.get(url)
    return c ? `<style>${c}</style>` : tag
  })
}

/** Imprime el HTML a PDF tamaño carta, con fondos (la marca va en tinta). */
export async function htmlAPdf(navegador: Browser, html: string): Promise<Buffer> {
  const contenido = await conFuentesEstaticas(html)
  const pagina = await navegador.newPage()
  try {
    // El HTML de la factura se auto-imprime al cargar; acá no hay diálogo.
    await pagina.evaluateOnNewDocument('window._corsaPreview = true; window.print = function () {};')
    await pagina.setContent(contenido, { waitUntil: 'load', timeout: 25_000 })
    await pagina.evaluate('document.fonts ? document.fonts.ready : null')
    const pdf = await pagina.pdf({ format: 'letter', printBackground: true, preferCSSPageSize: true, tagged: false, outline: false })
    return Buffer.from(pdf)
  } finally {
    await pagina.close()
  }
}
