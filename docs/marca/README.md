# Marca CORSA

## Los archivos

| | |
|---|---|
| `corsa-logo-completo.png` | El arte como llegó: símbolo + «CORSA» + «CARWASH» |
| `corsa-brandmark.svg` | Sólo el símbolo, vectorizado del anterior |
| `CORSA Brand Application Design.zip` | Bundle de diseño de pantallas. **No es la marca** — traía un boceto de dos píldoras que no corresponde |

## De dónde sale lo que ve el usuario

Todo —el favicon, los cinco iconos del PWA, el badge de las notificaciones y
el logo del riel lateral— sale de **`src/brand/brandmark.ts`**, que contiene el
path vectorizado.

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
