#!/usr/bin/env python3
"""
CORSA — genera los iconos PNG de la PWA desde el brandmark.

    python3 scripts/generar-iconos-pwa.py

POR QUÉ PNG Y NO EL SVG QUE YA EXISTE
El manifiesto acepta SVG y Chrome lo usa sin problema, pero iOS no: el icono
de una app instalada en iPhone sale del apple-touch-icon, y ahí Safari sólo
entiende PNG. Sin estos archivos, CORSA instalada en un iPhone queda con una
captura borrosa de la pantalla como icono — y ese mismo icono es el que
aparece en cada notificación.

El dibujo es el mismo de public/favicon.svg y de CorsaLogo: el fondo verde en
degradado y las dos píldoras inclinadas entrelazadas. Se redibuja acá en vez
de rasterizar el SVG para no depender de tener instalado un conversor.
"""
from pathlib import Path
from PIL import Image, ImageDraw

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "public" / "icons"

# Los mismos colores del favicon.
VERDE_CLARO = (18, 86, 74)
VERDE_OSCURO = (6, 50, 42)
BLANCO = (255, 255, 255)

# Se dibuja grande y se reduce: es el antialiasing del pobre, y para formas
# geométricas da un resultado indistinguible del de un rasterizador de SVG.
SUPER = 4


def fondo(lado, radio, con_fondo=True):
    """Cuadrado redondeado con el degradado de la marca."""
    img = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
    if not con_fondo:
        return img

    # Degradado en diagonal, como el linearGradient del SVG (0,0 → 1,1).
    grad = Image.new("RGB", (lado, lado))
    px = grad.load()
    for y in range(lado):
        for x in range(lado):
            t = (x + y) / (2 * (lado - 1))
            px[x, y] = tuple(
                round(a + (b - a) * t) for a, b in zip(VERDE_CLARO, VERDE_OSCURO))

    mascara = Image.new("L", (lado, lado), 0)
    ImageDraw.Draw(mascara).rounded_rectangle([0, 0, lado - 1, lado - 1], radius=radio, fill=255)
    img.paste(grad, (0, 0), mascara)
    return img


def pildora(lienzo, centro, ancho, alto, trazo, color, grados):
    """
    Una de las dos píldoras del brandmark, hueca e inclinada.

    Se dibuja en su propio lienzo y después se rota entero: PIL no sabe
    dibujar un rectángulo redondeado girado, pero sí rotar una imagen, y el
    resultado es el mismo con el antialiasing del supermuestreo.
    """
    capa = Image.new("RGBA", (lienzo, lienzo), (0, 0, 0, 0))
    cx, cy = centro
    ImageDraw.Draw(capa).rounded_rectangle(
        [cx - ancho / 2, cy - alto / 2, cx + ancho / 2, cy + alto / 2],
        radius=alto / 2, outline=color, width=trazo)
    # PIL rota en sentido antihorario, igual que un rotate() negativo de SVG.
    return capa.rotate(grados, resample=Image.BICUBIC, center=centro)


def marca(lado, con_fondo=True, escala_marca=1.0):
    """
    El icono completo.

    La geometría sale de public/favicon.svg, resuelta a coordenadas de un
    lienzo de 64 para no tener que aplicar la transformación del grupo:

        translate(5.6 15.8) scale(1.36) sobre rect(x, 4, 20, 16, rx=8)

    da dos píldoras de 27.2 × 21.76 con centros en (20.56, 32.12) y
    (45.04, 32.12), trazo 5.44, inclinadas −18°. Se solapan entre x=31.4 y
    x=34.2: ese entrelazado ES la marca, y separarlas la convierte en otra.
    """
    l = lado * SUPER
    img = fondo(l, radio=int(l * 14 / 64), con_fondo=con_fondo)

    u = l / 64                      # de unidades del SVG a píxeles del lienzo
    e = escala_marca
    ancho, alto = 27.2 * u * e, 21.76 * u * e
    trazo = max(2, round(5.44 * u * e))
    medio = l / 2

    # Los centros, medidos desde el centro del lienzo para que escalar la
    # marca no la corra de lugar.
    for dx in (20.56 - 32.8, 45.04 - 32.8):
        img.alpha_composite(
            pildora(l, (medio + dx * u * e, medio + (32.12 - 32) * u * e),
                    ancho, alto, trazo, BLANCO, 18))

    return img.resize((lado, lado), Image.LANCZOS)


def guardar(img, nombre):
    DESTINO.mkdir(parents=True, exist_ok=True)
    ruta = DESTINO / nombre
    img.save(ruta, "PNG", optimize=True)
    print(f"  ✓ {ruta.relative_to(RAIZ)}  ({ruta.stat().st_size // 1024} KB)")


def main():
    print("Generando iconos de la PWA…")

    # Los dos tamaños que pide el manifiesto para ser instalable.
    guardar(marca(192), "corsa-192.png")
    guardar(marca(512), "corsa-512.png")

    # iOS. 180 es el tamaño que Safari pide para la pantalla de inicio, y es
    # también el icono que acompaña a cada notificación en iPhone.
    guardar(marca(180), "apple-touch-icon.png")

    # Maskable: Android recorta el icono con la forma que tenga el launcher
    # —círculo, cuadrado, gota— y sólo respeta el 80% central. La marca va más
    # chica para que ningún recorte se la coma.
    guardar(marca(512, escala_marca=0.72), "corsa-maskable-512.png")

    # El badge de Android: la silueta monocroma que aparece en la barra de
    # estado. Va sin fondo porque el sistema la pinta de su color.
    guardar(marca(96, con_fondo=False), "corsa-badge-96.png")

    print("Listo.")


if __name__ == "__main__":
    main()
