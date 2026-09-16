/**
 * Genera los iconos de CORSA desde el brandmark.
 *
 * UNA SOLA FUENTE
 * Todos los tamaños salen del mismo dibujo, definido acá abajo una vez. Los
 * iconos anteriores se habían hecho por separado y habían derivado: el favicon
 * tenía las dos píldoras blancas y el trazo engrosado, así que a tamaño de
 * pestaña se leía como un «∞» y no como la marca. Un brandmark que cambia
 * según dónde aparezca deja de ser un brandmark.
 *
 *   node scripts/generar-iconos.mjs
 *
 * Necesita sharp: npm i --no-save sharp
 */
import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const salida = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

// ─── El brandmark ────────────────────────────────────────────
// Tal como viene del bundle de marca: dos píldoras inclinadas que se
// entrelazan, la primera blanca y la segunda en el naranja de CORSA.
const BLANCO = '#FFFFFF'
const NARANJA = '#FF6A28'
const VERDE_CLARO = '#12564A'
const VERDE_OSCURO = '#06322A'

/**
 * El dibujo, en su sistema de coordenadas propio.
 *
 * El viewBox lleva holgura porque las píldoras rotan −18° y su caja real es
 * más ancha que el 40×24 nominal. Sin ese margen, los extremos quedan
 * recortados justo en las curvas, que es donde más se nota.
 */
const VB = { x: -3, y: -1, w: 46, h: 26 }

function marca({ segunda = NARANJA, primera = BLANCO, grosor = 2.4 } = {}) {
  return `
    <g fill="none" stroke-width="${grosor}" stroke-linejoin="round">
      <rect x="1"  y="4" width="20" height="16" rx="8"
            transform="rotate(-18 11 12)" stroke="${primera}"/>
      <rect x="19" y="4" width="20" height="16" rx="8"
            transform="rotate(-18 29 12)" stroke="${segunda}"/>
    </g>`
}

/**
 * Compone el brandmark centrado en un lienzo cuadrado.
 *
 * `ocupacion` es qué fracción del ancho toma la marca. Importa sobre todo en
 * el icono enmascarable: Android puede recortarlo en círculo, y lo que quede
 * fuera del 80% central se pierde.
 */
function lienzo({ size, ocupacion, radio, fondo = true, ...opciones }) {
  const anchoMarca = size * ocupacion
  const escala = anchoMarca / VB.w
  const x = (size - anchoMarca) / 2
  const y = (size - VB.h * escala) / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${VERDE_CLARO}"/>
      <stop offset="1" stop-color="${VERDE_OSCURO}"/>
    </linearGradient>
  </defs>
  ${fondo ? `<rect width="${size}" height="${size}" rx="${radio}" fill="url(#g)"/>` : ''}
  <g transform="translate(${x} ${y}) scale(${escala}) translate(${-VB.x} ${-VB.y})">
    ${marca(opciones)}
  </g>
</svg>`
}

const png = (svg, archivo) =>
  sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(join(salida, archivo))

// ─── Los archivos ────────────────────────────────────────────
const tareas = [
  // Icono normal del PWA. Esquinas redondeadas propias, porque acá el sistema
  // lo muestra tal cual.
  ['icons/corsa-192.png', lienzo({ size: 192, ocupacion: 0.74, radio: 42 })],
  ['icons/corsa-512.png', lienzo({ size: 512, ocupacion: 0.74, radio: 112 })],

  // Enmascarable: SIN esquinas redondeadas —las pone el sistema— y con la
  // marca más chica. Android recorta en círculo y todo lo que sobresalga del
  // 80% central desaparece; con la ocupación del icono normal, las puntas de
  // las píldoras se cortarían.
  ['icons/corsa-maskable-512.png', lienzo({ size: 512, ocupacion: 0.56, radio: 0 })],

  // iOS pone sus propias esquinas y no admite transparencia: fondo completo.
  ['icons/apple-touch-icon.png', lienzo({ size: 180, ocupacion: 0.74, radio: 0 })],
]

/**
 * El badge de Android es un caso aparte.
 *
 * El sistema descarta el color y usa SÓLO el canal alfa: pinta de blanco lo
 * opaco y deja pasar lo transparente. Un badge con el fondo verde se vería
 * como un cuadrado blanco sólido en la barra de estado — sin marca, sin nada.
 *
 * Por eso va sin fondo, y con el trazo más grueso: se muestra a unos 24 px y
 * el grosor nominal desaparecería.
 */
const badge = lienzo({
  size: 96, ocupacion: 0.9, radio: 0, fondo: false,
  primera: '#FFFFFF', segunda: '#FFFFFF', grosor: 3.4,
})

// ─── Escribir ────────────────────────────────────────────────
for (const [archivo, svg] of tareas) {
  await png(svg, archivo)
  console.log('  ✓', archivo)
}
await png(badge, 'icons/corsa-badge-96.png')
console.log('  ✓ icons/corsa-badge-96.png (silueta, sin fondo)')

// El favicon va en SVG: una sola definición que sirve para 16 px y para la
// pantalla de un monitor 5K.
//
// Ocupa más del lienzo que los iconos del PWA (0.95 contra 0.74) y eso no es
// un descuido. A 16 px —el tamaño real de una pestaña— el trazo del brandmark
// cae por debajo de un píxel y las dos píldoras se funden en una mancha. La
// salida NO es engrosar el trazo: eso deja de ser el brandmark, y es
// exactamente como el favicon anterior terminó con las dos píldoras blancas y
// sin el naranja. Lo que se ajusta es el margen, que no es parte de la marca.
await writeFile(join(salida, 'favicon.svg'),
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"
     role="img" aria-label="CORSA">
  <!--
    El brandmark de CORSA, tal como está definido en el bundle de marca: dos
    píldoras inclinadas que se entrelazan, la segunda en el naranja.

    Generado por scripts/generar-iconos.mjs junto con los iconos del PWA y el
    badge de las notificaciones. Si hay que cambiar la marca, se cambia ahí y
    se regenera todo: que cada icono tenga su propia copia del dibujo es
    exactamente como el favicon terminó con las dos píldoras blancas.
  -->
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${VERDE_CLARO}"/>
      <stop offset="1" stop-color="${VERDE_OSCURO}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <g transform="translate(${(64 - 64 * 0.95) / 2} ${(64 - VB.h * (64 * 0.95 / VB.w)) / 2}) scale(${64 * 0.95 / VB.w}) translate(${-VB.x} ${-VB.y})">${marca()}
  </g>
</svg>
`)
console.log('  ✓ favicon.svg')
