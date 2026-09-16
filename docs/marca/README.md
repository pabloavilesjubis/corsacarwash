# Marca CORSA

## Los archivos

| | |
|---|---|
| `corsa-logo-completo.png` | El arte como llegó: símbolo + «CORSA» + «CARWASH» |
| `corsa-brandmark.svg` | Sólo el símbolo, vectorizado del anterior |
| `corsa-logo-completo.svg` | El bloque entero —símbolo + CORSA + CARWASH— vectorizado, huecos de las letras incluidos |
| `CORSA Brand Application Design.zip` | Bundle de diseño de pantallas. **No es la marca** — traía un boceto de dos píldoras que no corresponde |

## De dónde sale lo que ve el usuario

| Dónde aparece | De dónde sale |
|---|---|
| Favicon, iconos del PWA, badge de notificaciones, logo del riel | `src/brand/brandmark.ts` — sólo el símbolo |
| Pantalla de ingreso | `src/brand/logoCompleto.ts` — el bloque entero |

Están en archivos separados a propósito: el bloque completo pesa unos 32 KB de
path y sólo se usa para ingresar. La pantalla de ingreso se carga por separado,
así que ese peso no entra en el paquete principal.

```bash
npm i --no-save sharp
npm run icons
```

Eso regenera `public/favicon.svg` y `public/icons/*`. El logo de la interfaz
importa el mismo path desde TypeScript, así que no hay nada que regenerar ahí.

**No editar los iconos a mano.** Cada copia de un dibujo es una copia que puede
derivar, y ésta ya derivó: el favicon y el icono del PWA habían terminado
siendo dos marcas distintas, ninguna de las dos la real.

## Si cambia la marca

Reemplazar el arte acá, volver a vectorizar el símbolo, actualizar
`BRANDMARK_PATH` en `src/brand/brandmark.ts` y correr `npm run icons`.

## Tres reglas que no dependen del dibujo

**El badge de Android va sin fondo.** El sistema descarta el color y usa sólo
el canal alfa: pinta de blanco lo opaco. Con el mosaico verde se vería como un
cuadrado blanco sólido en la barra de estado.

**El enmascarable va a sangre**, sin esquinas redondeadas propias: Android pone
las suyas y puede recortar en círculo.

**El favicon lleva la marca más grande** que los iconos de la app. A 16 px, al
44.7% mediría 7 px de ancho: una mancha. Lo que se ajusta es el margen, nunca
el grosor del símbolo — engrosarlo es como la versión anterior perdió su forma.

## Un dato para quien instale la app

El icono de un PWA ya instalado **no se actualiza solo**. En iPhone hay que
borrarlo de la pantalla de inicio y volver a agregarlo; Safari captura el icono
al instalar y no lo vuelve a mirar. Android suele actualizarlo, pero puede
tardar días.
