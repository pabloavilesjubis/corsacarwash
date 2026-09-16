/**
 * Genera los iconos de CORSA desde el brandmark oficial.
 *
 *   npm run icons     (necesita: npm i --no-save sharp)
 *
 * UNA SOLA FUENTE
 * Todos los tamaños salen de src/brand/brandmark.ts, que es el arte
 * vectorizado. Antes cada icono tenía su propia copia del dibujo y habían
 * derivado entre sí; ésa es exactamente la falla que esto evita.
 */
import sharp from 'sharp'
import { writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

// Se lee el .ts con una expresión regular en lugar de importarlo: así el
// script corre con node pelado, sin necesidad de compilar TypeScript.
const fuente = await readFile(join(raiz, 'src/brand/brandmark.ts'), 'utf8')
const leer = (nombre) => fuente.match(new RegExp(`${nombre} = '([^']+)'`))[1]
const PATH = leer('BRANDMARK_PATH')
const VERDE_CLARO = leer('CORSA_TILE_CLARO')
const VERDE_OSCURO = leer('CORSA_TILE_OSCURO')
const VB = JSON.parse(
  fuente.match(/BRANDMARK_VIEWBOX = (\{[^}]+\})/)[1].replace(/(\w+):/g, '"$1":'))

/**
 * Cuánto del ancho del icono ocupa la marca.
 *
 * 0.447 sale de medir el icono que definió la marca: 67 px de marca en un
 * cuadro de 150. No se sube «para que se vea más»: el aire alrededor del
 * símbolo es parte de cómo está construido, y además es lo que recomiendan
 * tanto Apple como Google para que el icono no se sienta apretado.
 */
const OCUPACION = 0.447

/**
 * Compone la marca centrada en un lienzo cuadrado.
 *
 * `fondo` en false deja el símbolo sobre transparente, que es lo que necesita
 * el badge de Android.
 */
function lienzo({ size, ocupacion = OCUPACION, radio = 0, fondo = true, color = '#FFFFFF' }) {
  const ancho = size * ocupacion
  const escala = ancho / VB.ancho
  const alto = VB.alto * escala

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="t" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${VERDE_OSCURO}"/>
      <stop offset="1" stop-color="${VERDE_CLARO}"/>
    </linearGradient>
  </defs>
  ${fondo ? `<rect width="${size}" height="${size}" rx="${radio}" fill="url(#t)"/>` : ''}
  <g transform="translate(${(size - ancho) / 2} ${(size - alto) / 2}) scale(${escala})">
    <path fill="${color}" fill-rule="evenodd" d="${PATH}"/>
  </g>
</svg>`
}

const png = (svg, archivo) =>
  sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(join(raiz, 'public', archivo))

const tareas = [
  // Iconos normales: el sistema los muestra tal cual, así que llevan sus
  // propias esquinas redondeadas.
  ['icons/corsa-192.png', lienzo({ size: 192, radio: 42 })],
  ['icons/corsa-512.png', lienzo({ size: 512, radio: 112 })],

  // Enmascarable: SIN esquinas propias —las pone Android, y puede recortar en
  // círculo—. La marca ya queda dentro de la zona segura: con 44.7% de ancho,
  // su diagonal mide bastante menos que el círculo del 80% central.
  ['icons/corsa-maskable-512.png', lienzo({ size: 512, radio: 0 })],

  // iOS pone sus propias esquinas y no admite transparencia.
  ['icons/apple-touch-icon.png', lienzo({ size: 180, radio: 0 })],
]

for (const [archivo, svg] of tareas) {
  await png(svg, archivo)
  console.log('  ✓', archivo)
}

/**
 * El badge de Android va sin fondo y más grande.
 *
 * El sistema descarta el color y usa SÓLO el canal alfa: pinta de blanco lo
 * opaco. Con el mosaico verde se vería como un cuadrado blanco sólido en la
 * barra de estado. Y se muestra a unos 24 px, donde 44.7% sería un rayón.
 */
await png(lienzo({ size: 96, ocupacion: 0.88, fondo: false }), 'icons/corsa-badge-96.png')
console.log('  ✓ icons/corsa-badge-96.png (silueta, sin fondo)')

/**
 * El favicon ocupa más del cuadro que los iconos de la app.
 *
 * A 16 px —el tamaño real de una pestaña— la marca al 44.7% mediría 7 px de
 * ancho y 2 de alto: una mancha. El símbolo no se modifica; lo que cede es el
 * margen, que no es parte de la marca.
 */
await writeFile(join(raiz, 'public/favicon.svg'),
  lienzo({ size: 64, ocupacion: 0.86, radio: 14 })
    .replace('<svg ', '<svg role="img" aria-label="CORSA" ')
    .replace('<defs>', `<!--
    Generado por scripts/generar-iconos.mjs desde src/brand/brandmark.ts.
    No editar a mano: si hay que cambiar la marca, se cambia allá y se
    regenera todo junto.
  -->
  <defs>`) + '\n')
console.log('  ✓ favicon.svg')
