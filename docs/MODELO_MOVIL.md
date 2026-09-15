# Modelo móvil

Cómo está armado el teléfono en CORSA y cómo se le agregan pantallas.

## La regla

**La vista de computadora no se toca.** Arriba de 820 px de ancho la app
renderiza exactamente el mismo árbol de componentes que antes de que existiera
`src/mobile/`. Esto no es una aspiración: es una propiedad que se sostiene con
tres decisiones concretas.

1. **Una sola bifurcación.** `AppShell` pregunta `useEsMovil()` y elige cáscara:
   `Sidebar` o `MovilShell`. No hay ninguna otra rama en la app.
2. **Componentes separados, no condicionales adentro.** La versión de teléfono
   de una pantalla es un archivo nuevo en `src/mobile/`. No se le agregan `if`
   ni `media queries` a la pantalla de escritorio — apenas se empieza a hacer
   eso, cada cambio de teléfono pasa a ser un riesgo para la computadora.
3. **CSS bajo `.corsa-movil`.** Toda regla de `src/mobile/movil.css` cuelga de
   esa clase. Una regla que no empiece así está mal escrita, por más obvia que
   parezca.

El corte está en 820 px (`CORTE_MOVIL`) y no en 768: la Surface del local y las
tablets en horizontal trabajan bien con el layout de escritorio.

## El diseñador

```
npm run dev
http://localhost:5173/dev/disenador
```

Monta la aplicación real —con la sesión y los datos reales— dentro de marcos
del tamaño exacto de cada dispositivo. Permite cambiar de pantalla, rotar,
comparar contra el escritorio lado a lado y forzar una vista sin cambiar el
tamaño de la ventana.

Es una herramienta de taller: la ruta existe sólo con `import.meta.env.DEV` y
no se despliega. En producción, además, la CSP (`frame-ancestors 'none'`)
impediría el marco.

La lista de pantallas del panel marca cuáles tienen versión de teléfono y
cuáles siguen pendientes. Sale del mismo registro que usa el ruteo, así que no
puede quedar desactualizada.

## Agregar una pantalla al modelo móvil

Tres pasos, y ninguno toca la pantalla de escritorio:

1. Crear el componente en `src/mobile/`, por ejemplo `POSMovil.tsx`.
2. Anotarlo en `src/mobile/registro.tsx`:
   ```ts
   export const PANTALLAS_MOVIL = {
     dashboard: lazy(() => import('./DashboardMovil')...),
     pos:       lazy(() => import('./POSMovil')...),
   }
   ```
3. Envolver su ruta en `src/App.tsx`:
   ```tsx
   const Pos = adaptativa('pos', POSPage)
   ...
   <Route path="/pos" element={<ScreenGuard permission="screens.pos"><Pos/></ScreenGuard>}/>
   ```

`adaptativa()` va **por dentro** del `ScreenGuard`: el permiso se verifica una
sola vez, arriba, y ninguna de las dos versiones puede quedarse fuera de esa
verificación por olvido.

Mientras una pantalla no esté en el registro, en el teléfono se muestra la
versión de computadora dentro de la cáscara móvil, con un aviso y scroll
horizontal propio. Se ve apretada, pero se puede usar: es preferible a
esconderla, porque el equipo la necesita hoy.

## Qué no es el modelo móvil

No es el tablero de escritorio encogido. `DashboardMovil` es la referencia:
en la computadora alguien se sienta a analizar el día; en el teléfono alguien
está parado en el local y quiere saber cuánto se lleva vendido, si las máquinas
trabajan y qué se está lavando. El mapa de calor, el desglose por servicio
vendido y los últimos 7 días se quedan en la computadora a propósito.

Los blancos táctiles no bajan de 52 px de alto. Esto se usa de pie, con una
mano y a veces mojada.

## Datos

Las consultas del teléfono viven en servicios (`src/services/plc.service.ts`),
no dentro de las pantallas: los dos modelos muestran los mismos números, y si
cada uno los pidiera a su manera terminarían diciendo cosas distintas sobre lo
mismo.

Pendiente a propósito: el tablero de escritorio todavía tiene sus consultas en
línea, porque tocarlo era justamente lo que había que evitar en esta tanda.
Cuando haya que cambiar una de esas consultas, conviene mudarla a
`plc.service.ts` en lugar de editarla donde está.
