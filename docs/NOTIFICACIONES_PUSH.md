# Notificaciones Push

Cómo CORSA avisa al teléfono cuando una máquina termina un lavado, cuando falla
y cuando la operación del día terminó — con la app cerrada.

```
  PLC Máquina 1 / Máquina 2
        │ Modbus TCP (sólo lectura)
        ▼
  CORSA Local Gateway  (Surface, dentro del carwash)
        │ HTTPS
        ▼
  Cloud API / Edge Function
        │ service_role
        ▼
  Supabase  ── plc_wash_cycles, plc_machine_events, plc_machine_status
        │
        │ TRIGGERS  →  notification_events   (el motor de eventos)
        ▼
  Edge Function push-dispatch  ── cifra y manda
        │ Web Push (VAPID + aes128gcm)
        ▼
  FCM / Mozilla / Apple
        ▼
  PWA instalada del usuario
```

**El gateway no manda notificaciones.** Reporta hechos; la nube decide cuáles
merecen un aviso. Es la misma regla que ya gobierna la derivación de lavados, y
por el mismo motivo: si la Surface decidiera, habría que reinstalarla cada vez
que cambie una regla de negocio.

---

## 1. La regla que manda sobre todas

**Este módulo no detecta lavados. Los observa.**

La detección ya existe y vive en `plc_derive_from_event()` (migraciones 0036 a
0038). Escribir un segundo algoritmo que mire los mismos eventos crudos daría
dos respuestas para el mismo lavado, y el día que discrepen el push diría una
cosa y el tablero otra.

Por eso todo cuelga de **triggers sobre las tablas que ya son la verdad**:

| Hecho | Trigger sobre | Se dispara cuando |
|---|---|---|
| Lavado terminado | `plc_wash_cycles` | el ciclo queda en un estado que `corsa_cuenta_como_lavado()` acepta y tiene `completed_at` |
| Falla de máquina | `plc_machine_events` y `plc_machine_status` | llega `FAULT_STARTED` / `MACHINE_FAULT`, o el estado pasa a `FAULT` |
| Cierre del día | `plc_gateway_heartbeats` | cada latido, pasada la hora mínima |

Eso además resuelve algo que una llamada dentro de la derivación no resolvería:
hoy conviven **dos rutas de ingesta** —el Worker de Cloudflare, que llama
`plc_ingest_events()`, y la Edge Function `gateway-ingest`, que hace upsert
directo— y sólo la primera pasa por la derivación. Un trigger sobre la tabla
cubre las dos.

---

## 2. Idempotencia: por qué no se puede notificar dos veces

`notification_events.idempotency_key` es **UNIQUE**. La clave es la identidad
del hecho, no la del envío:

| Evento | Clave |
|---|---|
| `WASH_COMPLETED` | `wash-<uuid del ciclo>` |
| `MACHINE_ERROR` | `machine-error-<uuid del incidente>` |
| `DAILY_CLOSE` | `daily-close-YYYY-MM-DD` |

Ninguna de las tres depende de cuándo se procesó. Reiniciar el gateway,
reenviar un lote tras un corte de Internet, reprocesar el día, reinstalar el
servidor o recibir el mismo evento dos veces **no puede** generar un segundo
push: el `INSERT` choca contra la restricción y devuelve `null`.

Hay una segunda capa por dispositivo: `notification_deliveries` es UNIQUE sobre
`(evento, dispositivo)`, así que un despachador que se muere a mitad de tanda no
reenvía lo ya enviado al reiniciarse.

Y una tercera, la que evita la avalancha: **la ventana de frescura**. Un evento
más viejo que `ventana_frescura_minutos` (30 por defecto) no notifica. Sin ella,
correr `corsa_reclasificar_lavados()` —que reescribe hasta noventa días de
ciclos— mandaría miles de pushes de lavados de hace meses.

---

## 3. Los tres eventos

### 3.1 Lavado finalizado

```
🚗 CORSA — Máquina 2
Lavado Signature finalizado
Duración: 8m 42s
Hoy: 37 lavados
```

- El servicio sale de `corsa_servicio_de()`, la misma función que clasifica el
  ciclo. Se usan los nombres comerciales —Pro, Elite, Signature— nunca «corto»,
  «medio» o «largo», que son cómo se deducen y no cómo se venden.
- «Hoy» suma **todas las máquinas** y usa `corsa_inicio_del_dia()` /
  `corsa_fin_del_dia()`: el día de El Salvador, el mismo que el tablero. Nunca
  `current_date`, que en Postgres es UTC y haría que el día empezara a las 6 de
  la tarde.
- Toca → `/machines?maquina=<id>`.

### 3.2 Error de máquina

```
⚠️ CORSA — Máquina 1
ERROR DETECTADO
Código: E104
Sensor de entrada
Hora: 2:47 PM
```

Sin código ni descripción del PLC, el cuerpo dice `ERROR DETECTADO / Revisar
máquina.` — que es toda la acción que se puede tomar con ese dato.

La máquina de estados **no está escrita en código**: es un índice único.

```sql
create unique index uniq_incidente_abierto
  on machine_error_incidents(organization_id, machine_id)
  where resolved_at is null;
```

| Transición | Qué pasa |
|---|---|
| NORMAL → ERROR | se abre un incidente → **push** |
| ERROR → ERROR | el `INSERT` choca con el índice → **sin push** |
| ERROR → NORMAL | se cierra el incidente (no notifica: una recuperación no es una urgencia) |
| NORMAL → ERROR otra vez | incidente nuevo → **push** |

Cada incidente queda con `started_at`, `resolved_at` y `duration_seconds`: es la
base de las estadísticas de fallas y downtime.

### 3.3 Cierre del día

```
🌙 CORSA — Cierre del día
Máquina 1: 18 lavados · 2h 41m
Máquina 2: 21 lavados · 3h 08m
TOTAL: 39 lavados
```

El push es corto porque es lo que entra en una pantalla de bloqueo. El detalle
completo —servicios por máquina, horarios, interrupciones— está en
`/dashboard/cierre-diario?date=YYYY-MM-DD`, a donde lleva tocarlo.

---

## 4. Cómo se detecta el cierre del día

Esta es la parte delicada, y conviene tener escrito exactamente qué se decidió.

### El problema

«Se terminó la operación» no es un dato que exista en ninguna parte. Hay que
deducirlo, y la deducción ingenua —«dejaron de llegar datos, entonces
cerraron»— es falsa la primera vez que se cae el Internet a las tres de la
tarde. El resumen del día llegaría en plena hora pico, con la mitad de los
lavados, y a partir de ahí nadie volvería a creerle.

### La señal que sí sirve

El heartbeat del gateway llega cada 30 s y trae `machines`, donde el gateway
dice de cada máquina si logra hablarle por Modbus. **Eso separa las dos cosas
que se confunden:**

| Lo que se observa | Lo que significa |
|---|---|
| Gateway latiendo + máquina no responde | la máquina está **apagada** |
| Gateway sin latir | **no se sabe nada** de las máquinas |

No saber no es lo mismo que saber que están apagadas. Toda la lógica cuelga de
esa distinción.

`corsa_maquina_apagada_desde()` devuelve el primer latido que reportó a la
máquina apagada **después** del último que la reportó encendida. `null` = está
encendida, o nunca se supo de ella. Como respaldo usa
`plc_machine_status.status = 'OFFLINE'`, que escribe la derivación desde
`PLC_DISCONNECTED` / `MACHINE_OFFLINE`.

### Las dos formas de cerrar

**A · `MAQUINAS_APAGADAS` — el camino normal.** Requiere las cuatro:

1. el gateway está latiendo ahora (hay un observador vivo);
2. **todas** las máquinas activas están reportadas como apagadas;
3. lo están de forma sostenida desde hace `cierre_ventana_minutos` (**45**);
4. es más tarde que `cierre_hora_minima` (**14:00**).

La cuarta existe porque a las diez de la mañana dos máquinas apagadas son un
corte de luz, no un cierre.

**B · `HORA_TOPE` — la red de seguridad.** Para la noche en que el gateway se
apaga junto con el local y por lo tanto nunca llega a reportar las máquinas
apagadas. Requiere:

1. pasó `cierre_hora_tope` (**23:30**);
2. hubo lavados hoy;
3. hace `cierre_inactividad_minutos` (**90**) que no termina ninguno.

**Y la condición que gobierna las dos:** si hoy no hubo ningún lavado, no se
cierra nada. Un domingo sin operación no necesita un resumen que diga cero, y
además es indistinguible de un día en que el sistema estuvo caído.

### Lo que no se hace

No se cierra un día pasado automáticamente. Si toda la tarde el sistema estuvo
caído, ese día se queda sin cierre automático y se cierra a mano desde
`/dashboard/cierre-diario` (permiso `plc.manage`). Mandar el resumen de ayer a
las ocho de la mañana confunde más de lo que informa.

### Doble cierre

`daily_closes` tiene llave primaria `(organization_id, fecha_operativa)`. No hay
código que verifique nada: la base no deja que haya dos. Si a las once de la
noche alguien enciende una máquina por error, el día ya está cerrado y no se
vuelve a cerrar.

Queda registrado: fecha operativa, hora, motivo, detección en prosa, totales por
máquina, quién lo generó y `notification_sent_at`.

### Quién evalúa

- Un trigger sobre `plc_gateway_heartbeats`: cada latido, pasada la hora mínima.
  Es el momento en que llega evidencia nueva, así que es el momento de
  preguntárselo. Protegido con `pg_try_advisory_xact_lock`.
- El barrido del despachador, cada minuto, que es lo que cubre el caso B cuando
  el gateway dejó de latir.

Para ver en vivo por qué todavía no cerró:

```sql
select jsonb_pretty(public.corsa_estado_operativo(
  '00000000-0000-0000-0000-000000000001'));
```

La misma información está en `/dashboard/cierre-diario` sin abrir el SQL Editor.

### Ajustar los parámetros

```sql
update public.corsa_notification_config
   set cierre_ventana_minutos = 60,
       cierre_hora_minima     = '15:00',
       cierre_hora_tope       = '23:00';
```

---

## 5. Despliegue

> **Atajo.** Los pasos 5.2 a 5.4, más el `pg_net` y el
> `corsa_configurar_despacho()` del 5.5, los hace `./scripts/desplegar-push.sh`
> de una vez: genera el par VAPID **sólo si todavía no hay uno**, carga los
> secretos sin que la privada pase por la terminal ni por el disco, despliega la
> función y comprueba que `/vapid-public-key` responda 200. Se puede correr las
> veces que haga falta: si las claves ya están, no las toca.
>
> El `PUSH_DISPATCH_SECRET` sí lo rota cuando hace falta, y es a propósito:
> tiene que estar en la función **y** en la base, `secrets list` sólo muestra un
> digest, y un secreto ya cargado ya no se puede volver a leer. Rotarlo no
> cuesta nada —no está atado a ningún dispositivo, al revés que VAPID—.
>
> Antes hay que hacer `supabase login` a mano — abre el navegador y no se puede
> automatizar. El paso 5.1 (la migración) sigue siendo manual; el script avisa
> si la base se quedó atrás.

### 5.1 Correr la migración

`supabase/migrations/0042_notificaciones_push.sql` en el SQL Editor.

Crea `push_subscriptions`, `notification_events`, `notification_deliveries`,
`notification_rules`, `notification_reads`, `machine_error_incidents`,
`daily_closes`, `corsa_notification_config`, los triggers y las vistas
`v_corsa_notificaciones` / `v_corsa_dispositivos`.

No toca ninguna tabla existente y no crea permisos nuevos: reutiliza `plc.read`
(ver y recibir) y `plc.manage` (cerrar el día a mano, simular, configurar).

### 5.2 Generar las claves VAPID

```bash
node scripts/generar-vapid.mjs
```

VAPID identifica al servidor ante el servicio de push del navegador. La pública
viaja en cada suscripción; la privada firma.

> **Son un par.** Cambiar la pública invalida **todas** las suscripciones
> existentes: el navegador ata cada suscripción a la clave con la que se creó.
> Se generan una vez y se guardan.

### 5.3 Cargar los secretos

```bash
supabase secrets set \
  VAPID_PUBLIC_KEY=<la pública> \
  VAPID_PRIVATE_KEY=<la privada> \
  VAPID_SUBJECT=mailto:soporte@corsacarwash.com \
  PUSH_DISPATCH_SECRET=$(openssl rand -hex 32) \
  --project-ref zvbpkfuehnmqlqimyxcs
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta
Supabase sola.

**La privada no va al frontend, ni al repositorio, ni a un chat.** Con ella
cualquiera puede mandarle notificaciones a los teléfonos del equipo en nombre de
CORSA.

### 5.4 Desplegar la función

```bash
supabase functions deploy push-dispatch --project-ref zvbpkfuehnmqlqimyxcs
```

Verificar que responde:

```bash
curl https://zvbpkfuehnmqlqimyxcs.supabase.co/functions/v1/push-dispatch/vapid-public-key
# {"publicKey":"BK..."}
```

### 5.5 Despertar al despachador

La base no puede mandar un push: no habla HTTPS ni sabe cifrar para el
navegador. Hay que llamar a la función. Dos llamadores, **los dos opcionales**;
con cualquiera de los dos el sistema funciona.

Primero, guardar la URL y el secreto:

```sql
select public.corsa_configurar_despacho(
  'https://zvbpkfuehnmqlqimyxcs.supabase.co/functions/v1/push-dispatch/run',
  '<el mismo PUSH_DISPATCH_SECRET>');
```

**Inmediato (`pg_net`)** — el push llega en segundos en lugar de en el próximo
minuto:

```sql
create extension if not exists pg_net;
```

(Sin `with schema`: pg_net no es reubicable y siempre instala sus funciones en
el esquema `net`.)

Con eso alcanza: el trigger sobre `notification_events` ya está puesto y detecta
solo si la extensión existe. Sin ella no falla, sólo no dispara.

**Barrido (`pg_cron`)** — recoge lo que el inmediato no pudo y es lo que llama a
la evaluación de cierre por hora tope cuando el gateway dejó de latir:

```sql
create extension if not exists pg_cron;

select cron.schedule('corsa-push', '* * * * *', $$
  select net.http_post(
    url := (select url from public.corsa_dispatch_config where id = 1),
    body := '{"source":"cron"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Dispatch-Key', (select secret from public.corsa_dispatch_config where id = 1)));
$$);
```

Si no se quiere `pg_cron`, sirve igual cualquier cron externo que haga ese POST
cada minuto (un Cron Trigger de Cloudflare, por ejemplo).

### 5.6 Desplegar el frontend

`npm run build` y desplegar como siempre. Los archivos nuevos que tienen que
quedar servidos desde la raíz:

```
/manifest.webmanifest
/sw.js
/offline.html
/icons/corsa-192.png
/icons/corsa-512.png
/icons/corsa-maskable-512.png
/icons/apple-touch-icon.png
/icons/corsa-badge-96.png
```

Los iconos se regeneran con `python3 scripts/generar-iconos-pwa.py` (necesita
Pillow) si alguna vez cambia el brandmark.

> `/sw.js` tiene que servirse **desde la raíz**. Un Service Worker sólo controla
> su carpeta y las de abajo: servido desde `/assets/` no vería las navegaciones
> de la app y las notificaciones no funcionarían.

---

## 6. Variables de entorno

### Edge Function `push-dispatch` (secretos de Supabase)

| Variable | Qué es | Obligatoria |
|---|---|---|
| `VAPID_PUBLIC_KEY` | clave pública VAPID, base64url | sí |
| `VAPID_PRIVATE_KEY` | clave privada VAPID, base64url | sí |
| `VAPID_SUBJECT` | `mailto:` de contacto | recomendada |
| `PUSH_DISPATCH_SECRET` | la llave con la que el cron y la base llaman a `/run` | sí |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | las inyecta Supabase | — |

Sin `PUSH_DISPATCH_SECRET` la ruta `/run` responde 503 y no despacha nada: un
despachador sin llave sería un endpoint público para vaciar la cola.

### Frontend (`.env.local`)

| Variable | Qué es |
|---|---|
| `VITE_VAPID_PUBLIC_KEY` | **opcional.** La clave pública. Si no está, la app se la pide a la función al suscribirse. |

No hay ningún secreto nuevo en el frontend. La clave pública es pública por
definición: viaja en cada suscripción y en cada push.

---

## 7. Activar las notificaciones

### En iPhone / iPad

iOS **sólo** permite Web Push a las apps instaladas en la pantalla de inicio.
En una pestaña de Safari no funciona, y no es una limitación de CORSA.

1. Abrir CORSA en **Safari** (no Chrome: en iOS, Chrome usa el motor de Safari
   pero no puede instalar apps).
2. Botón **Compartir** (el cuadrado con la flecha) → **Agregar a pantalla de
   inicio** → **Agregar**.
3. Abrir CORSA **desde el icono nuevo**, no desde Safari.
4. Iniciar sesión.
5. Menú → **Configuración → Notificaciones**.
6. **🔔 Activar notificaciones** → **Permitir**.

Requisitos: iOS 16.4 o más nuevo.

Si la pantalla dice «Falta instalar CORSA en el iPhone», es que se abrió desde
Safari y no desde el icono.

> iOS entrega los pushes con la app cerrada, pero puede demorarlos si el
> teléfono está en modo de bajo consumo o si hace días que no se abre CORSA. No
> se pierden: llegan cuando el sistema decide despertar la app.

### En Android

1. Abrir CORSA en Chrome.
2. Menú ⋮ → **Instalar aplicación** (o el aviso que aparece solo).
3. Iniciar sesión → **Configuración → Notificaciones** → **🔔 Activar**.

En Android funciona también sin instalar, desde la pestaña. Instalada es mejor:
el icono queda en el cajón de apps y la notificación lleva el logo de CORSA.

### En computadora (Chrome, Edge, Safari de macOS)

**Configuración → Notificaciones → 🔔 Activar notificaciones**. Instalar no hace
falta, pero con la app cerrada el navegador tiene que seguir corriendo.

### Si alguien bloqueó por error

El bloqueo **no se puede levantar desde la página**: hay que habilitarlo en la
configuración del sitio del navegador (el candado junto a la dirección) y volver
a entrar. Por eso CORSA no pide permiso al abrir: un «Bloquear» apurado cuesta
el dispositivo para siempre.

---

## 8. Probar sin que el carwash esté trabajando

Hay **tres niveles**, y se distinguen por una sola cosa: cuánto tocan los datos
reales. Empezá por el primero.

| Nivel | Qué prueba | Qué escribe |
|---|---|---|
| **A · Push de prueba** | VAPID, suscripción, Service Worker, deep link | sólo `notification_events` |
| **B · Eventos simulados** | además, el texto exacto de cada tipo de aviso | sólo `notification_events` |
| **C · Pipeline completo** | además, la detección de lavados y fallas | **tablas de máquinas** |

Los niveles A y B **no crean lavados ni mueven ninguna estadística**. El C sí, y
por eso no va en producción.

### El cerrojo

A y B exigen `simulacion_habilitada`, que nace en `false`:

```sql
update public.corsa_notification_config set simulacion_habilitada = true;
```

**Apagarlo al terminar.** Es lo que impide que alguien dispare avisos falsos
desde la aplicación.

```sql
update public.corsa_notification_config set simulacion_habilitada = false;
```

---

### Nivel A y B · desde la computadora (el ciclo rápido)

```bash
npm run dev
```

`http://localhost:5173` es contexto seguro, así que el push funciona igual que
en producción: Chrome o Edge muestran la notificación del sistema con CORSA
cerrada, siempre que el navegador siga corriendo.

**Configuración → Notificaciones → 🔔 Activar** y después, en **Pruebas**:

- Enviar Push de prueba
- Simular lavado PRO / ELITE / SIGNATURE
- Simular error Máquina 1 / Máquina 2
- Simular cierre diario

Esos botones **sólo existen en desarrollo** (`import.meta.env.DEV`). En el CORSA
desplegado no se compilan.

---

### Nivel A y B · desde el teléfono (lo que de verdad hay que probar)

Acá hay un problema práctico: **iOS sólo permite Web Push a las apps instaladas
desde HTTPS**, y `localhost` no se puede instalar en el iPhone. O sea que para
probar en el teléfono hace falta el CORSA desplegado — donde los botones de
simulación no existen.

Ese hueco lo cierra el script:

```bash
./scripts/probar-push.sh <email> <contraseña> [evento]
```

Pide el evento desde afuera, con tu sesión, sin que exista ningún botón en la
aplicación. Eventos: `test` (por defecto), `pro`, `elite`, `signature`,
`error1`, `error2`, `cierre`.

```bash
./scripts/probar-push.sh pablo@corsa.com 'mi-clave' signature
```

El aviso llega **sólo a tus dispositivos** (`metadata.target_user_id`).

**La secuencia completa para validar un iPhone:**

1. Instalar CORSA en el iPhone (sección 7) e iniciar sesión.
2. **Configuración → Notificaciones → 🔔 Activar**. Esto **no** está detrás de
   ningún cerrojo: la activación funciona en producción con normalidad.
3. Habilitar la simulación con el SQL de arriba.
4. **Cerrar CORSA en el teléfono** — es el punto del ejercicio.
5. Desde la laptop: `./scripts/probar-push.sh … signature`
6. El teléfono suena. Tocarlo tiene que abrir `/machines` con la máquina.
7. Probar `cierre`: tocarlo abre `/dashboard/cierre-diario`.
8. Apagar la simulación.

---

### Nivel C · el pipeline completo, sin máquinas

Los niveles A y B prueban el **mensaje y la entrega**. Lo que no prueban es la
**detección**: que un ciclo real dispare el trigger. Para eso hay que meter
eventos de PLC, y eso **crea lavados que cuentan en las estadísticas**.

> **Nunca contra producción.** Un lavado inventado entra en el total del día, en
> el reporte por servicio y en el cierre. Usá un proyecto de Supabase aparte con
> las mismas migraciones.

Con `scripts/probar-ingesta.sh` ya se puede empujar un evento suelto. Para una
secuencia de lavado completa, directo en SQL:

```sql
-- Un lavado Signature en la Máquina 2, tal como lo dejaría la derivación.
insert into public.plc_wash_cycles
  (id, organization_id, gateway_id, machine_id, started_at, status, source)
values (gen_random_uuid(), '<org>', '<gateway>', 'machine-2',
        now() - interval '9 minutes', 'IN_PROGRESS', 'derived');

update public.plc_wash_cycles
   set completed_at = now(), duration_seconds = 522, status = 'COMPLETED'
 where machine_id = 'machine-2' and status = 'IN_PROGRESS';
```

El trigger dispara solo. Para la falla:

```sql
insert into public.plc_machine_events
  (id, organization_id, gateway_id, machine_id, event_type, event_timestamp, payload)
values (gen_random_uuid(), '<org>', '<gateway>', 'machine-1', 'FAULT_STARTED', now(),
        '{"data":{"error_code":"E104","error_description":"Sensor de entrada"}}'::jsonb);
```

Correr el segundo `insert` otra vez **no** manda un segundo aviso: es la regla
ERROR→ERROR. Para volver a probarla, primero `FAULT_CLEARED`.

---

### El cierre del día

Es el único que no se puede probar del todo sin telemetría real, y conviene
tener claro por qué: la detección lee el **historial de latidos del gateway**,
así que simularla es escribir latidos falsos — y un latido falso hace que
`corsa_maquina_apagada_desde()` mienta. En producción, no.

Lo que sí se puede hacer, en orden de menor a mayor alcance:

**1 · Ver los insumos de la decisión, en vivo y sin escribir nada.** Contesta
«¿por qué todavía no cerró?»:

```sql
select jsonb_pretty(public.corsa_estado_operativo('<org>'));
```

La misma información está en `/dashboard/cierre-diario` sin abrir el SQL Editor.

**2 · Probar el aviso** con `./scripts/probar-push.sh … cierre`, que arma el
resumen con los números reales del día pero no registra ningún cierre.

**3 · Cerrar de verdad**, desde `/dashboard/cierre-diario` → «Cerrar este día a
mano» (permiso `plc.manage`). Registra el cierre con motivo `MANUAL` y manda la
notificación real. Es el mismo camino que usa el cierre automático.

**4 · Probar la detección entera**, sólo en un proyecto aparte: escribir la
secuencia de latidos que la lógica espera —encendidas, después apagadas hace más
de `cierre_ventana_minutos`— y evaluar.

```sql
-- SÓLO en un proyecto de prueba.
update public.plc_gateways set last_seen_at = now();
insert into public.plc_gateway_heartbeats (organization_id, gateway_id, machines, reported_at)
values ('<org>','<gw>','[{"machine_id":"machine-1","online":true},
                         {"machine_id":"machine-2","online":true}]'::jsonb, now() - interval '5 hours'),
       ('<org>','<gw>','[{"machine_id":"machine-1","online":false},
                         {"machine_id":"machine-2","online":false}]'::jsonb, now() - interval '70 minutes'),
       ('<org>','<gw>','[{"machine_id":"machine-1","online":false},
                         {"machine_id":"machine-2","online":false}]'::jsonb, now());

select jsonb_pretty(public.corsa_evaluar_cierre_del_dia('<org>'));
```

Requiere que haya al menos un lavado ese día: sin operación no hay cierre.
Cambiando `70 minutes` por `5 minutes` se verifica lo contrario — que una caída
corta **no** cierra el día.

---

### «Failed to fetch» al tocar Activar

Es el fallo número uno, y el mensaje **miente sobre dónde está el problema**:
suena a que falla el teléfono y en realidad falta desplegar la Edge Function.

El mecanismo, que conviene tener escrito porque no es evidente:

1. Para obtener la clave VAPID, la app le pregunta a `push-dispatch`.
2. Si esa petición lleva la cabecera `apikey` —que no está en la lista blanca
   de CORS— el navegador manda primero un **preflight OPTIONS**.
3. Con la función sin desplegar, la pasarela de Supabase responde el preflight
   con **404**.
4. Un preflight que no devuelve 2xx es, para el navegador, un error de red:
   `fetch` rechaza con `TypeError: Failed to fetch` y **el 404 nunca se ve**.

Por eso esa petición va sin cabeceras: así es una petición simple, no hay
preflight, y el 404 llega como lo que es. La app ahora muestra la etapa, la URL
y el código HTTP en lugar del mensaje genérico.

**Comprobarlo desde la terminal, en un segundo:**

```bash
curl -i https://<ref>.supabase.co/functions/v1/push-dispatch/vapid-public-key
```

- `{"code":"NOT_FOUND"}` → falta desplegar:
  `supabase functions deploy push-dispatch`
- `{"error":"VAPID no está configurado"}` → faltan los secretos (paso 5.3).
- `{"publicKey":"B..."}` → esta etapa está bien.

**Desde el teléfono, sin cable:** Configuración → Notificaciones →
**Diagnóstico → Revisar este dispositivo**. Revisa las seis cosas de las que
depende una notificación —conexión segura, Service Worker, API de Push, clave
VAPID, sesión y base de datos— y dice cuál falla y qué hacer. No activa ni
escribe nada.

En la consola, cada intento deja el rastro completo:

```
[PUSH] capacidades {soportado: true, …}
[PUSH] permission granted
[PUSH] service worker ready {scope: "https://…/", activo: true}
[PUSH] vapid key {origen: "…", largo: 87}
[PUSH] subscription created {endpoint: "https://fcm.googleapis.com/…"}
[PUSH] sending subscription to backend {url: "…/rpc/corsa_registrar_dispositivo"}
[PUSH] backend response {ok: true, id: "…"}
[PUSH] subscription saved
```

La línea donde se corta es la etapa que falla. Si aparece
`subscription created` y el error viene después, el problema **no** es el
teléfono ni Web Push: es la API.

### Si no llega nada

En este orden:

```sql
-- ¿Se generó el evento?
select created_at, event_type, title, status, dispositivos, entregados, fallidos
  from public.v_corsa_notificaciones order by created_at desc limit 5;
```

- **No aparece** → no se emitió. Revisar `enabled` y `simulacion_habilitada` en
  `corsa_notification_config`, y la ventana de frescura si el hecho es viejo.
- **`SKIPPED`** → nadie a quién mandárselo: ningún dispositivo suscrito, o todos
  con ese tipo apagado.
- **`PENDING` y no avanza** → nadie está despertando al despachador (paso 5.5).
  Probarlo a mano:
  ```bash
  curl -X POST "$URL/functions/v1/push-dispatch/run" \
    -H "X-Dispatch-Key: $PUSH_DISPATCH_SECRET" -H "Content-Type: application/json" -d '{}'
  ```
- **`FAILED`** → el servicio de push rechazó. El motivo, por dispositivo:
  ```sql
  select s.device_name, d.status, d.http_status, d.provider_error
    from public.notification_deliveries d
    join public.push_subscriptions s on s.id = d.subscription_id
   order by d.created_at desc limit 10;
  ```
  `401` / `403` suele ser VAPID mal cargado; `410` es un dispositivo que ya no
  existe y se da de baja solo.
- **`SENT` pero el teléfono no suena** → llegó al servicio de push y el problema
  es del dispositivo: modo de bajo consumo, foco, o CORSA abierta en Safari en
  vez de instalada.

### Prueba del cifrado

```bash
node --test tests/
```

Verifica `webpush.ts` contra el vector oficial del **RFC 8291, apéndice A**: el
cuerpo cifrado tiene que coincidir byte a byte con el que publicó el IETF.

No es una prueba de ida y vuelta a propósito. Un cifrado mal derivado —las dos
claves públicas al revés dentro del `info`, un byte `0x00` de más— se descifra
perfectamente con el mismo código equivocado: la prueba pasaría y el teléfono no
mostraría nada, sin ningún error del lado del servidor.

## 9. Monitoreo

```sql
-- Qué se generó y a cuántos dispositivos llegó
select created_at, event_type, title, status, dispositivos, entregados, fallidos
  from public.v_corsa_notificaciones
 order by created_at desc limit 30;

-- Por qué falló un envío, dispositivo por dispositivo
select d.created_at, d.device_name, d.status, d.http_status, d.provider_error
  from public.notification_deliveries d
 where d.status in ('FAILED', 'EXPIRED')
 order by d.created_at desc limit 30;

-- Dispositivos suscritos
select usuario, device_name, platform, enabled, last_push_at, recibidas
  from public.v_corsa_dispositivos order by last_seen_at desc;

-- Fallas y downtime
select machine_id, started_at, resolved_at, duration_seconds, error_code
  from public.machine_error_incidents order by started_at desc limit 20;
```

Los dispositivos que el servicio de push declara muertos (**404** o **410**) se
desactivan solos, con el motivo en `invalidated_reason`. Seguir intentándolos
sería gastar una llamada por push por cada teléfono desinstalado, para siempre.
`corsa_limpiar_dispositivos_muertos()` borra los que llevan más de 90 días así.

### Interruptor general

```sql
update public.corsa_notification_config set enabled = false;
```

En `false` no se emite ningún evento. Es la salida de emergencia si algo empieza
a mandar pushes de más un domingo a la noche.

---

## 10. Agregar un tipo de notificación nuevo

La arquitectura es `evento → regla → destinatario → canal → entrega`, y agregar
un tipo **no toca la lógica que detecta los hechos**.

1. Insertar la regla:

```sql
insert into public.notification_rules
  (organization_id, event_type, channel, audience, required_permission)
values
  ('00000000-0000-0000-0000-000000000001', 'GATEWAY_OFFLINE', 'WEB_PUSH',
   'PERMISSION', 'plc.read');
```

2. Llamar a `corsa_emitir_notificacion()` desde donde ese hecho se detecte, con
   una clave idempotente que sea la identidad del hecho.

Eso es todo. `event_type` no tiene `CHECK` a propósito: agregar
`ABNORMAL_WASH_TIME` o `DAILY_TARGET_REACHED` no puede requerir una migración.

Para que el usuario pueda apagarlo por separado hace falta además una columna en
`push_subscriptions` y su nombre en `notification_rules.subscription_flag`. Una
regla sin `subscription_flag` va a todos los dispositivos habilitados.

**Un canal nuevo** (SMS, WhatsApp, correo) es un despachador nuevo que lee la
misma cola filtrando por `channel`. Nada de lo que detecta eventos cambia.

---

## 11. Archivos

| Archivo | Qué es |
|---|---|
| `supabase/migrations/0042_notificaciones_push.sql` | tablas, triggers, RLS, motor de eventos |
| `supabase/functions/push-dispatch/index.ts` | el despachador |
| `supabase/functions/push-dispatch/webpush.ts` | VAPID + cifrado, sobre Web Crypto |
| `public/sw.js` | Service Worker: `push`, `notificationclick`, `pushsubscriptionchange` |
| `public/manifest.webmanifest` | lo que hace a CORSA instalable |
| `public/offline.html` | la página de navegación sin red |
| `src/lib/push.ts` | capacidades del dispositivo, suscripción, baja |
| `src/services/notifications.service.ts` | consultas |
| `src/components/CentroNotificaciones.tsx` | la campana 🔔 |
| `src/components/PuenteNotificaciones.tsx` | sincroniza la suscripción y atiende el ruteo del SW |
| `src/pages/NotificacionesPage.tsx` | Configuración → Notificaciones |
| `src/pages/CierreDiarioPage.tsx` | `/dashboard/cierre-diario` |
| `scripts/generar-vapid.mjs` | genera el par VAPID |
| `scripts/probar-push.sh` | dispara avisos de prueba contra el CORSA desplegado |
| `scripts/generar-iconos-pwa.py` | genera los PNG del icono |
| `tests/webpush.test.mjs` | el vector del RFC 8291 |

### Lo que el Service Worker NO hace

**No cachea la aplicación.** Un Service Worker que guarda el JavaScript de la
app sirve una versión vieja después de cada despliegue, y el equipo termina
viendo precios o pantallas que ya se cambiaron sin forma de darse cuenta. Para
un sistema de caja eso es peor que no funcionar sin Internet. Lo único que se
guarda es `offline.html`.
