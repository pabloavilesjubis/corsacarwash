# Motor fiscal DTE — CORSA Carwash

Documentación técnica del motor de facturación electrónica de CORSA: cómo emite
Documentos Tributarios Electrónicos contra el Ministerio de Hacienda de El
Salvador **desde Cloudflare, sin ningún servidor físico**.

**Alcance:** DTE `01` (Factura de Consumidor Final) y `03` (Comprobante de
Crédito Fiscal).

**El criterio que manda:** si mañana el Ubuntu de ERP-PAAJ se apaga, CORSA tiene
que poder vender, firmar, transmitir y recibir sello sin enterarse. ERP-PAAJ fue
**referencia de lectura** durante el diseño y nada más. Ningún componente de
CORSA llama a su API, a su base ni a su firmador.

> **Este documento no contiene secretos.** Ni llaves privadas, ni contraseñas,
> ni tokens. Los secretos viven cifrados en Cloudflare y se cargan con
> `wrangler secret put`.

---

## 0. Estado de validación

Esto va primero a propósito. Las pruebas automatizadas son buenas y numerosas,
**y no sustituyen una emisión real contra Hacienda**.

| Componente | Estado | Cómo se validó |
|---|---|---|
| **Firmador RS512** | ✅ **Validado criptográficamente** | Header y firma contrastados contra 113 DTE reales sellados por el MH; ejecución verificada dentro de workerd |
| **Builder FCF (01)** | ✅ **Validado contra schema** | El documento construido pasa `fe-fc-v1.json`, el schema oficial del MH |
| **Correlativos** | ✅ **Validados contra PostgreSQL** | 50 reservas simultáneas con pgbench, más idempotencia y concurrencia |
| **Circuito interno** | ✅ **Validado con dobles** | 14 pruebas de punta a punta con Supabase y MH simulados |
| **Integración con el MH** | ❌ **NO VALIDADA** | El cliente compila y tiene pruebas de forma, pero **nunca habló con Hacienda** |
| **Motor DTE de punta a punta** | ❌ **NO VALIDADO** | Falta el hito: un DTE aceptado con `selloRecibido` real |

**El motor no está terminado hasta obtener esto:**

```
CORSA → Cloudflare → Supabase → DTE 01 → firma RS512 → MH → ACEPTADO
                                                    → selloRecibido guardado
```

Ese estado **sólo cambia con un sello real del ambiente correspondiente del MH.**

---

## 1. Arquitectura

```
POS CORSA (app web)
    │  POST /v1/dte/emit · Bearer FISCAL_API_KEY
    ▼
corsa-fiscal-api  ── Cloudflare Worker, repositorio aparte
    │
    ├─► Supabase  ── reservar correlativo + crear fiscal_document (RPC atómica)
    ├─► construir DTE
    ├─► validar contra el schema oficial del MH
    ├─► firmar JWS RS512 (WebCrypto)
    ├─► Supabase  ── marcar firmado
    ├─► Ministerio de Hacienda ── transmitir
    └─► Supabase  ── guardar desenlace y estado
```

### Por qué el Worker vive aparte de `corsa-cloud-api`

`corsa-cloud-api` autentica los gateways del PLC, que corren en una Surface
físicamente accesible dentro del local. En `corsa-fiscal-api` está la llave
privada con la que CORSA firma documentos tributarios. Son dos superficies de
riesgo distintas, con despliegues y rollbacks independientes: un bug en la
ingesta de máquinas no puede tumbar la facturación, y al revés.

### Dónde vive cada cosa

| Cosa | Dónde | Por qué |
|---|---|---|
| Llave privada, contraseñas, service role | Secretos de Cloudflare | Cifrados; no se pueden leer de vuelta ni desde la propia cuenta |
| Numeración fiscal | Postgres (Supabase) | El único lugar con transacciones reales; los Workers no tienen estado compartido |
| Datos públicos del emisor | Supabase, `fiscal_issuer_config` | Viajan dentro del documento de todos modos |
| Documentos y auditoría | Supabase | Fuente de verdad fiscal |

---

## 2. El firmador — por qué no hace falta el contenedor Java

Hacienda entrega un firmador que es una aplicación **Java 8 / Spring Boot**
(`svfe/svfe-api-firmador`). Un Worker corre V8, no una JVM, y eso parecía
obligar a tener un servidor.

No obliga. **El firmador de Hacienda no hace criptografía propietaria: compara
un hash de contraseña y produce un JWS RS512 estándar.**

### Evidencia

Medido contra los DTE reales que el MH selló en la instancia de ERP-PAAJ
(113 documentos, leídos sin modificar nada):

```
DTE analizados                         : 113
headers JWS distintos encontrados      : 1
    {"alg":"RS512"}        b64url: eyJhbGciOiJSUzUxMiJ9
firma verifica como RS512 puro         : 113 | fallan: 0
    (RSASSA-PKCS1-v1_5 + SHA-512, contra la llave pública del certificado)
partes: 3 · padding "=": no · firma: 256 bytes
```

Sin `typ`, sin `x5c`, sin `kid`. Firmando con `crypto.subtle` el header sale
**idéntico byte por byte**.

### Formato del certificado

El `.crt` del MH es un XML `<CertificadoMH>`, no un PKCS#12:

| Campo | Valor |
|---|---|
| `privateKey.format` | **PKCS#8 sin cifrar** — ASN.1 `30 82 xx xx 02 01 00`, sin OID PBES |
| `privateKey.algorithm` | RSA 2048 |
| `privateKey.clave` | **SHA-512 en hex del `passwordPri`** |
| `publicKey.format` | X.509 SPKI |

La llave está **en claro** dentro del XML; la contraseña sólo es un portón.
`crypto.subtle.importKey('pkcs8', …)` la carga directo, con
`extractable: false` para que ni nuestro propio código pueda volver a sacarla.

### Serialización del payload

El firmador Java re-serializa el JSON con indentación antes de firmar. Se
comparó en detalle: la diferencia es **sólo espacios en blanco** — no reordena
claves, no elimina `null`, no escapa a `\uXXXX`.

CORSA serializa compacto, porque el MH parsea el payload. Lo que sí hay que
respetar: **los campos nulos van como `null` explícito, nunca ausentes**. Los
schemas usan `additionalProperties: false` y exigen los nullable presentes; un
`undefined` desaparece al serializar y el DTE se rechaza.

---

## 3. Autenticación con Hacienda

| Uso | URL |
|---|---|
| Sandbox | `https://apitest.dtes.mh.gob.sv` |
| Producción | `https://api.dtes.mh.gob.sv` |
| Login | `POST /seguridad/auth` |
| Recepción | `POST /fesv/recepciondte` |
| Anulación | `POST /fesv/anulardte` |

**El login va en `application/x-www-form-urlencoded`, no en JSON.** Es el error
más fácil de cometer y el mensaje de vuelta no lo dice:

```
user=<NIT 14 dígitos>&pwd=<password del portal>
→ { status: "OK", body: { token } }
```

El token puede venir con o sin el prefijo `Bearer `; se normaliza. Dura 24 h y
se renueva a las 12 h por margen de reloj. Ante un `401`: limpiar cache,
renovar y reintentar **una sola vez**.

**Campo `ambiente`:** `00` sandbox, `01` producción. Viaja dentro del DTE y
también en el sobre del envío.

### El cache del token en un Worker

ERP-PAAJ guarda el token en una variable de módulo. Eso funciona en un proceso
Node que vive semanas; en Cloudflare los isolates son efímeros y hay muchos en
paralelo, así que esa variable acierta a veces. El cache de CORSA es un
parámetro con interfaz propia (`CacheDeToken`): hoy entra el de memoria, y
cuando el volumen lo pida entra uno sobre KV sin tocar el resto.

---

## 4. Numeración

### `numeroControl` — 31 caracteres

```
DTE-NN-EEEEPPPP-NNNNNNNNNNNNNNN
 │   │     │           └── correlativo, 15 dígitos, ceros a la izquierda
 │   │     └── establecimiento (4) + punto de venta (4), [A-Z0-9]
 │   └── tipo de DTE, 2 dígitos
 └── prefijo fijo
```

### `codigoGeneracion`

UUID v4 **en MAYÚSCULAS**. El schema exige `[A-F0-9]` y rechaza el UUID en
minúsculas, que es como lo devuelve `crypto.randomUUID()`.

Son dos identificadores distintos y se guardan en columnas separadas, cada una
con su UNIQUE.

### Códigos de establecimiento

El MH distingue `codEstable` (el que define el contribuyente, y que entra al
`numeroControl`) de `codEstableMH` (el que asigna Hacienda en el portal), y lo
mismo con `codPuntoVenta` / `codPuntoVentaMH`. Si no coinciden con lo dado de
alta para el NIT, el MH rechaza y el mensaje no explica por qué.

---

## 5. Correlativos

### La regla

**Un correlativo reservado no se recicla nunca.** Si Hacienda rechaza el 126,
ese número queda quemado: el documento conserva su correlativo, `numeroControl`,
`codigoGeneracion`, el motivo del rechazo y la respuesta del MH, y la venta
siguiente toma el 127.

```
126  REJECTED   ← queda el hueco, con el documento entero para explicarlo
127  ACCEPTED
128  ACCEPTED
129  siguiente
```

### Por qué no se recicla

Reciclar sólo funciona si la clasificación `REJECTED` es siempre correcta. Si
alguna vez marcamos como rechazado algo que el MH sí recibió, entregar ese
número a otra venta produce **dos documentos con el mismo `numeroControl` ante
Hacienda**. Quemar el número hace ese error imposible, y cuesta un hueco.

Lo que se pudo verificar: el schema del MH **no exige continuidad** —
`numeroControl` sólo tiene formato y largo fijo, sin `minimum` ni regla de
secuencia— y `recepciondte` recibe un documento a la vez, sin el anterior, así
que el MH no puede verificar contigüidad al recibir. El texto normativo no está
en estos repositorios, así que esto describe lo que muestra el schema y no es
una afirmación sobre la ley.

ERP-PAAJ documenta esta misma postura («devolver libera la reservación, queda
como gap, MH tolera») pero su implementación no la cumple: como calcula desde
`ultimo_consumido`, recicla cuando el número devuelto es el más alto y deja
hueco cuando no. Nadie eligió ese comportamiento; sale de la aritmética.

### Alcance de la secuencia

`UNIQUE (organization_id, dte_type, establishment_code, pos_code)`.

La organización entra porque los códigos de establecimiento los asigna Hacienda
**por NIT**: dos organizaciones son dos contribuyentes y no pueden compartir
secuencia. ERP-PAAJ indexa sólo por tipo de DTE porque es un único punto de
venta; CORSA tiene sucursales.

### La reserva

Ocurre **entera dentro de Postgres**, en una sentencia:

```sql
update public.fiscal_correlatives
   set last_minted = last_minted + 1, updated_at = now()
 where organization_id = … and dte_type = … and establishment_code = …
   and pos_code = … and seeded
returning last_minted;
```

El `update` bloquea e incrementa en el mismo paso: las transacciones
concurrentes se serializan solas, sin `select … for update` previo y sin
ventana entre leer y escribir. Es posible justamente porque los números no se
reciclan — siempre es el siguiente, nunca hay que elegir.

**Nunca** `select` → volver al Worker → sumar → `update`: dos Workers
concurrentes leerían el mismo valor.

### Sembrado

Antes de operar hay que decir en qué número va el contribuyente.
`fiscal_seed_correlative` sube pero **nunca baja**, y cada llamada queda en
`fiscal_audit_events`. Arrancar en 1 cuando CORSA ya emitió documentos por otro
medio duplicaría numeración ante Hacienda, y eso no se arregla después.

---

## 6. Idempotencia

**Una venta → un `fiscal_document` → un correlativo → un `numeroControl` → un
`codigoGeneracion`.**

Ante timeout, reintento, doble clic, error de red o MH lento: se retoma **el
mismo documento**. Nunca se pide numeración nueva.

La llave es `SALE:{invoice_id}:DTE:{tipo}`, con UNIQUE. Y no depende del cuidado
de quien escriba el frontend: `fiscal_open_document` **reserva el correlativo y
crea el documento en la misma operación atómica**.

```
1. insert … on conflict (idempotency_key) do nothing   ← sólo una transacción gana
2. si no ganamos → esperamos su bloqueo y devolvemos SU documento
                   (no se toca el correlativo)
3. si ganamos    → recién ahí se reserva el número y se completa la fila
```

Si fueran dos llamadas separadas, entre una y otra cabría un timeout y el
reintento pediría un correlativo nuevo para una venta que ya tenía uno.

**El builder no inventa identificadores.** Recibe el `numeroControl` y el
`codigoGeneracion` que asignó la base; si generara los suyos, un reintento
produciría un `codigoGeneracion` nuevo y se perdería la idempotencia justo en el
caso que la necesita.

---

## 7. Estados y desenlaces

```
CREATED        correlativo reservado, documento aún sin construir
VALIDATED      pasa el schema oficial del MH
SIGNED         JWS RS512 generado
SUBMITTED      enviado, sin respuesta concluyente
ACCEPTED       PROCESADO y con sello
REJECTED       el MH lo leyó y dijo que no: hay que corregirlo
RETRY_PENDING  el MH no contestó: se reintenta EL MISMO
CONTINGENCY    emitido en contingencia, pendiente de transmitir
INVALIDATED    anulado ante Hacienda con evento firmado
```

### La distinción que más importa

| Desenlace | Qué pasó | Qué se hace con el correlativo |
|---|---|---|
| **ACEPTADO** | `PROCESADO` **y** vino `selloRecibido` | Consumido |
| **RECHAZADO** | El MH leyó el DTE y dijo que no | **Quemado**, con toda su trazabilidad |
| **TRANSITORIO** | El MH no contestó, o 5xx | **Sigue reservado** — el documento pudo haber entrado |

Confundir los dos últimos es el error caro. Tratar un «no contestó» como un
«dijo que no» quemaría el número por algo que quizá sí existe en Hacienda.

Un `PROCESADO` **sin sello** no es una emisión: se trata como no concluyente.

### Reintentos

`fiscal_mark_retry` incrementa `attempt_count` y **no toca la numeración**. El
reintento reprocesa el mismo documento, con el mismo `codigoGeneracion` y el
mismo `numeroControl`.

El cliente HTTP reintenta los 5xx y 429 con espera exponencial más ruido. El
ruido no es adorno: sin él, veinte Workers que fallaron al mismo tiempo le
pegan a Hacienda en manada justo cuando ya está en problemas. Los 4xx no se
reintentan.

---

## 8. Modelo de datos

Migración: [`0043_motor_fiscal_dte.sql`](../supabase/migrations/0043_motor_fiscal_dte.sql)

### `fiscal_issuer_config`
Datos del emisor que viajan dentro del DTE, por sucursal. **Sin secretos.**
NIT, NRC, nombre, `cod_actividad`/`desc_actividad`, `tipo_establecimiento`,
departamento/municipio/complemento, correo, y los cuatro códigos de
establecimiento y punto de venta.

### `fiscal_correlatives`
`last_minted` (sólo sube), más el sembrado. **No hay columnas de «en vuelo» ni
de «liberados»**: qué documentos están en camino lo dice
`fiscal_documents.status`, que es la única fuente de verdad. Duplicarlo daría
dos lugares que pueden discrepar.

### `fiscal_documents`
`idempotency_key` UNIQUE, `correlative`, `numero_control` UNIQUE,
`codigo_generacion` UNIQUE, `json_original`, `signed_jws`, `sello_recepcion`,
`mh_response`, `attempt_count`, `last_error` y las marcas de tiempo de cada
transición.

### `fiscal_audit_events`
Una fila por transición. **Nunca secretos.**

### `v_fiscal_correlative_ledger`
Qué pasó con cada número: a qué venta fue, en qué estado quedó, con qué sello y
—si fue rechazado— por qué. Sin reciclaje un hueco es normal, y quien audite
tiene que poder ver la razón sin abrir otra consulta.

### RPC

| Función | Qué hace |
|---|---|
| `fiscal_seed_correlative` | Fija el punto de arranque. Sube, nunca baja. |
| `fiscal_open_document` | **Reserva el correlativo y crea el documento, atómico e idempotente.** |
| `fiscal_mark_signed` | Guarda el JWS y el JSON firmado, antes de transmitir. |
| `fiscal_mark_accepted` | Guarda el sello y la respuesta del MH. |
| `fiscal_mark_rejected` | Quema el correlativo, guarda motivo y respuesta. |
| `fiscal_mark_retry` | Cuenta el intento. **No toca la numeración.** |

### RLS

Las tablas se **leen** desde la app con el JWT del usuario, filtradas por
organización. Se **escriben** sólo desde el Worker con el service role. **No hay
política de insert/update para `authenticated`, y las RPC están revocadas de ese
rol**: si el navegador pudiera tocar un correlativo o marcar un documento como
aceptado, toda la integridad fiscal dependería del frontend.

---

## 9. El Worker

Repositorio: `corsa-fiscal-api`

```
src/
  signing/     codificacion.ts · certificate.ts · signer.ts
  validation/  validate.ts · schemas/ · generated/
  numbering/   control-number.ts
  mh/          client.ts · auth.ts · submit.ts
  builders/    fcf.ts
  services/    fiscal-service.ts     ← el circuito completo
  supabase.ts  cliente PostgREST mínimo
  fecha.ts · dinero.ts · types/
```

### Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/health` | Estado. Sin autenticación. |
| `POST` | `/v1/dte/emit` | **La ruta real.** Circuito completo. |
| `POST` | `/v1/prueba/firmar` | Firma un payload. No toca Hacienda. |
| `POST` | `/v1/prueba/validar` | Valida contra el schema. No firma ni transmite. |
| `POST` | `/v1/prueba/emitir` | Emisión sin base, para diagnóstico. |
| `POST` | `/v1/prueba/certificado` | Lee un `.crt`. Nunca la llave privada. |

Todos los `POST` piden `Authorization: Bearer <FISCAL_API_KEY>`, comparado en
tiempo constante: con `===`, el tiempo de respuesta filtraría cuántos caracteres
acertó quien prueba.

`/v1/dte/emit` devuelve **200** si Hacienda aceptó y **202** en cualquier otro
desenlace ya guardado (rechazo, pendiente). El POS mira `estado`, no el código
HTTP: un rechazo de Hacienda no es un fallo de este servicio.

### El candado de producción

Mientras `MH_ENV=production`, las rutas `/v1/prueba/*` responden **403**. Está
en el código, no en la disciplina de quien despliega.

---

## 10. Validación contra los schemas del MH

Todo DTE se valida contra el schema oficial **antes de firmarse**. Es la
comprobación más barata que hay, y el MH contesta con un mensaje genérico
mientras que AJV dice `/resumen/totalPagar` y qué regla se rompió.

**Los validadores están precompilados.** AJV genera su función con
`new Function()`, que los Workers prohíben — un `ajv.compile()` en caliente pasa
las pruebas en Node y revienta en producción. `npm run schemas:compilar` los
emite como módulos y se commitean, para que un despliegue de emergencia no
dependa de que alguien corra un script.

Escribir esta capa encontró dos cosas:

- **Arriba de US$1,095.00 la FCF exige receptor identificado**
  (`fe-fc-v1.json`, `allOf[0]`: `tipoDocumento`, `numDocumento`, `nombre`).
  El builder lo impide con un mensaje que se entiende.
- **AJV daba falsos positivos en los importes.** Los schemas marcan los montos
  con `multipleOf` y AJV lo comprueba dividiendo: `1.15 / 0.01` da
  `114.99999999999999`. Se corrige con `multipleOfPrecision: 3`, medido para
  quedar entre el ruido de la división (peor caso `1.5e-5`) y la señal de una
  violación real (menor caso `1.0e-1`).

---

## 11. FCF — DTE 01, versión 1

- `precioUni` y `ventaGravada` **incluyen IVA**: son lo que paga el cliente
- `ivaItem = ventaGravada × 0.13 / 1.13` — el IVA se **extrae**, no se suma
- `totalIva` en el resumen es informativo
- Receptor **opcional** — la venta de mostrador puede ser anónima
- `totalPagar = subTotal`
- Arriba de US$1,095.00, receptor obligatorio

### Dinero

Todo se suma en **centavos enteros** y se vuelve a decimal una sola vez, al
final. `0.1 + 0.2` no da `0.3`, y en una factura larga eso descuadra el subtotal
contra la suma de ítems — que es justo lo que el MH cuadra. ERP-PAAJ suma en
flotante y redondea al final.

### Fecha y hora

Se convierten con `Intl` a `America/El_Salvador`. **Los Workers corren siempre
en UTC y no se puede cambiar.** Copiar el enfoque de ERP-PAAJ —confiar en la
zona del proceso— fecharía en el día siguiente a partir de las 18:00 de El
Salvador, que es la mitad ocupada del día en un carwash.

### Monto en letras

`QUINCE 50/100 DÓLARES`. La implementación de ERP-PAAJ está declarada
placeholder en su propio código y devuelve `15 00/50 DÓLARES`; el MH no valida
el contenido —por eso pasó 113 veces— pero sale impreso en cada factura.

---

## 12. CCF — DTE 03, versión 3

**Pendiente de construir.**

- `precioUni` y `ventaGravada` van **sin IVA**
- El IVA se lista en `resumen.tributos`, código `'20'`
- Receptor **obligatorio y completo**: `nit`, `nrc`, `nombre`, `codActividad`,
  `descActividad`, `direccion{departamento, municipio, complemento}`, `correo`
- `montoTotalOperacion = subTotal + IVA + percepción − retenciones`
- El sistema debe **impedir** emitir si falta cualquier campo del receptor

> **ERP-PAAJ nunca emitió un CCF.** Sus 113 documentos son todos tipo `01`, y su
> correlativo del `03` está desactivado (`03.json.bak`). Su `buildCcf` existe y
> se ve correcto pero **nunca pasó por Hacienda**. Para CORSA el CCF es
> desarrollo nuevo, basado en el schema oficial y los catálogos, no en una
> referencia probada. No es «una FCF con datos fiscales adicionales».

---

## 13. Invalidación y contingencia

**Pendientes. No son mejoras, son obligaciones.**

- **Invalidación** (`anulacion-schema-v2.json`, `POST /fesv/anulardte`). Una
  factura mal emitida no se borra: se invalida ante el MH con un evento
  firmado. Sin esto, un error de cajero no tiene arreglo.
- **Contingencia** (`contingencia-schema-v3.json`). Cuando el MH está caído, la
  ley permite emitir en contingencia y transmitir después. Los campos
  `tipoContingencia` y `motivoContin` ya existen en el tipo, en `null`.

---

## 14. Representación gráfica

**La representación gráfica no es el DTE.** El orden es: construir → firmar →
transmitir → **sello del MH** → recién ahí, PDF.

Un error generando el PDF **no puede** hacer fallar una emisión ya aceptada. Si
resulta incómodo dentro del Worker —`pdfkit` es Node puro y no corre ahí— va a
un servicio aparte o a la app web.

CORSA ya tiene [`facturaDocument.ts`](../src/lib/fiscal/facturaDocument.ts), que
hoy marca los campos fiscales como «Pendiente de transmisión». Cuando exista el
DTE se llenan con `numeroControl`, `codigoGeneracion`, sello y QR.

---

## 15. Secrets y configuración

### Secretos (`wrangler secret put`)

| Nombre | Qué es |
|---|---|
| `CERT_PKCS8_B64` | Llave privada del certificado, PKCS#8 en base64 |
| `CERT_PASSWORD` | `passwordPri` del certificado (portón SHA-512) |
| `MH_NIT` | NIT del emisor, 14 dígitos sin guiones |
| `MH_PASSWORD` | Contraseña del portal de Hacienda — distinta de la anterior |
| `FISCAL_API_KEY` | Clave que habilita las rutas del Worker |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role. Vive únicamente en el Worker. |

### Variables (`wrangler.jsonc`, versionadas)

`MH_ENV` (`sandbox` / `production`), `SUPABASE_URL`, `ENVIRONMENT`.

### Preparar el certificado

```bash
npm run cert:preparar -- ruta/al/NIT.crt
```

Comprueba que la llave firma de verdad, que la contraseña corresponde al
certificado, e imprime el `CERT_PKCS8_B64`. **No lo escribe en ningún archivo.**
Pide la contraseña por entrada interactiva y no por argumento: lo que va en la
línea de comandos queda en el historial del shell y en la lista de procesos.

El `.crt` **nunca entra a un repositorio** — `*.crt` está en `.gitignore`.

### Lo que el frontend nunca puede hacer

Firmar, ver la llave privada, ver credenciales del MH, o generar correlativos.
Todo eso ocurre del lado del servidor. No hay ruta que devuelva la llave, y se
importa con `extractable: false`.

---

## 16. Pruebas

### Worker — 83 pruebas

```bash
cd corsa-fiscal-api && npm test && npm run typecheck
```

| Archivo | Cubre |
|---|---|
| `firmador.test.ts` | Header literal `eyJhbGciOiJSUzUxMiJ9`, firma, codificación, certificado |
| `numeracion.test.ts` | `numeroControl`, `codigoGeneracion`, **zona horaria** |
| `dinero.test.ts` | Centavos enteros, monto en letras |
| `fcf.test.ts` | Construcción, IVA extraído, nulls explícitos |
| `validacion.test.ts` | Contra el schema oficial, umbral de $1,095, `multipleOf` |
| `circuito.test.ts` | **Punta a punta**: idempotencia, rechazo, MH caído |

Las pruebas generan su propio par de llaves. No hay ni debe haber un certificado
real en el repositorio.

### Base de datos

```bash
docker run -d --rm --name corsa-fiscal-test -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=corsa_test -p 55433:5432 postgres:16-alpine

psql … -f supabase/tests/0043_prereq.sql
psql … -f supabase/migrations/0043_motor_fiscal_dte.sql
psql … -f supabase/tests/0043_datos.sql
psql … -f supabase/tests/0043_motor_fiscal_dte.test.sql

pgbench … -c 50 -j 8 -t 1 -n -f supabase/tests/0043_concurrencia.sql
```

Resultado esperado: 50 simultáneas dan **exacto 101..150**, sin duplicados ni
saltos.

---

## 17. Plan de prueba contra el MH

El hito que falta. **No considerar terminado el motor hasta completarlo.**

1. Cargar los secrets con los datos reales de CORSA.
2. Cargar `fiscal_issuer_config` con los códigos del portal del MH.
3. Sembrar la secuencia con `fiscal_seed_correlative`.
4. `MH_ENV=sandbox`. Login → token. *(Gate: `status:"OK"`)*
5. FCF mínima por `/v1/dte/emit`. Comparar el header contra
   `eyJhbGciOiJSUzUxMiJ9`.
6. **Gate real: `estado:"ACCEPTED"` con `selloRecepcion` guardado en
   `fiscal_documents`.**
7. Recién entonces, el CCF.

Cuando lleguen los secrets y los datos fiscales, **el desarrollo de features
nuevas se detiene** hasta completar esta prueba.

---

## 18. Orden de trabajo

Después del primer FCF aceptado:

1. CCF (DTE 03)
2. Cola y reintentos
3. Invalidación
4. Contingencia
5. PDF + QR
6. Envío por correo
7. Catálogos restantes (CAT-011, 014, 017, 018)
8. Integración con el POS
9. Rate limiting
10. Hardening y despliegue

---

## 19. Decisiones tomadas

| # | Decisión | Razón |
|---|---|---|
| 1 | Worker aparte de `corsa-cloud-api` | Dos superficies de riesgo distintas, despliegues independientes |
| 2 | **Un correlativo rechazado se quema**, no se recicla | Reciclar duplicaría numeración si confundimos un rechazo con una respuesta perdida |
| 3 | La reserva ocurre entera en Postgres, en una sentencia | Un `select`→Worker→`update` deja que dos Workers lean el mismo valor |
| 4 | Reservar y crear el documento son una sola operación | Entre dos llamadas cabe un timeout, y el reintento pediría numeración nueva |
| 5 | Aritmética en centavos enteros | El MH cuadra el subtotal contra la suma de ítems |
| 6 | Fecha con `Intl`, no con la hora del proceso | Los Workers corren siempre en UTC |
| 7 | Verificar cada firma antes de transmitir | Un milisegundo contra descubrir el error en el rechazo de Hacienda |
| 8 | Validar contra el schema antes de firmar | La comprobación más barata; el MH no dice qué campo falló |
| 9 | Validadores precompilados | Los Workers prohíben `new Function()`, que es como AJV compila |
| 10 | Los identificadores los asigna la base, no el builder | Si no, un reintento generaría un `codigoGeneracion` nuevo |
