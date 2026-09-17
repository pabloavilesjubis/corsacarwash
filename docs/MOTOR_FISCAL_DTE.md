# Motor fiscal DTE — Hacienda El Salvador

Qué hace falta para que CORSA emita sus propios Documentos Tributarios
Electrónicos contra el Ministerio de Hacienda, **sin servidor físico y sin
depender de ninguna infraestructura de ERP-PAAJ**.

Este documento es el reporte previo al desarrollo. Nada de esto está
implementado todavía: hoy CORSA tiene la tabla `fiscal_documents` vacía, los
campos fiscales del cliente (migración `0029`) y una interfaz
[`FiscalProvider`](../src/integrations/fiscal/FiscalProvider.ts) que lanza error
si alguien la llama.

**Alcance inicial:** DTE `01` (Factura de Consumidor Final) y `03` (Comprobante
de Crédito Fiscal).

**El criterio que manda:** si mañana el Ubuntu de ERP-PAAJ se apaga, CORSA tiene
que poder vender, firmar, transmitir y recibir sello sin enterarse. ERP-PAAJ es
**referencia de lectura**, nunca una dependencia de ejecución. No se llama a su
API, ni a su base, ni a su firmador.

---

## 1. La pregunta que bloqueaba todo, y su respuesta

Hacienda entrega un firmador que es una aplicación **Java 8 / Spring Boot**
(`svfe/svfe-api-firmador`, clase `sv.mh.fe.Application`). Un Cloudflare Worker
corre V8, no una JVM. A primera vista eso obliga a tener un servidor.

No obliga. **El firmador de Hacienda no hace criptografía propietaria: compara
un hash de contraseña y produce un JWS RS512 estándar.**

### Evidencia

No es deducción. Se midió contra los DTE reales que el MH ya aceptó en la
instancia de ERP-PAAJ (113 documentos, leídos sin modificar nada):

```
DTE analizados                         : 113
headers JWS distintos encontrados      : 1
    {"alg":"RS512"}        b64url: eyJhbGciOiJSUzUxMiJ9
firma verifica como RS512 puro         : 113 | fallan: 0
    (RSASSA-PKCS1-v1_5 + SHA-512, contra la llave pública del certificado)
partes: 3 · padding "=": no · firma: 256 bytes
```

Sin `typ`, sin `x5c`, sin `kid`. El header es el mínimo posible.

Firmando con `crypto.subtle` —la misma API que hay en Workers— el header sale
**idéntico byte por byte**:

```
import PKCS#8 (privada) : OK — RSASSA-PKCS1-v1_5, 2048 bits
firma RS512             : OK — 256 bytes
verifica con la pública : true
header                  : eyJhbGciOiJSUzUxMiJ9
```

### Formato real del certificado

El `.crt` del MH es un XML `<CertificadoMH>`, no un PKCS#12:

| Campo | Valor real |
|---|---|
| `privateKey.format` | **PKCS#8 sin cifrar** — ASN.1 arranca `30 82 xx xx 02 01 00`, sin OID PBES |
| `privateKey.algorithm` | RSA 2048 |
| `privateKey.encodied` | la llave, en base64 |
| `privateKey.clave` | **SHA-512 en hex del `passwordPri`** (verificado) |
| `publicKey.format` | X.509 SPKI |

O sea: la llave privada está **en claro** dentro del XML y la contraseña sólo
sirve de portón. `crypto.subtle.importKey('pkcs8', der, {name:'RSASSA-PKCS1-v1_5',
hash:'SHA-512'}, false, ['sign'])` la carga directo.

### El detalle de la serialización

El firmador Java **re-serializa** el JSON antes de firmar: los 113 payloads
difieren de `JSON.stringify(dte_json)`. Se analizó en qué:

```
mismo objeto tras re-parsear (deep-eq) : 113 | distintos: 0
con saltos de línea / indentación      : 113
con distinto ORDEN de claves           :   0
con claves ELIMINADAS                  :   0
con \uXXXX escapado                    :   0
```

Sólo indentación. No reordena claves ni borra `null`.

**Consecuencia para CORSA:** se puede serializar compacto, porque el MH parsea
el payload. Pero hay que **mantener los `null` explícitos y el orden que emite
el builder**: los schemas del MH usan `additionalProperties: false` y exigen los
campos nullable *presentes*, no ausentes.

---

## 2. Discrepancias entre la especificación y lo que ERP-PAAJ hace de verdad

Cinco. Las tres primeras requieren una decisión antes de escribir código fiscal.

### 2.1 — ERP-PAAJ nunca ha emitido un CCF. Ni uno. · DECISIÓN PENDIENTE

```
DTE emitidos por tipo : {"01": 113}
correlativos en disco : 01.json, 03.json.bak, 05.json, 14.json
```

El correlativo del tipo `03` está renombrado a `.bak` — desactivado. El
`buildCcf` de ERP-PAAJ existe y se ve correcto, pero **nunca pasó por
Hacienda**.

Para CORSA el FCF es referencia probada (113 aceptaciones). El CCF es código
sin validar: hay que tratarlo como desarrollo nuevo y probarlo contra sandbox
antes de confiar en él.

### 2.2 — Reciclar correlativos: la especificación y ERP-PAAJ dicen lo contrario · DECISIÓN PENDIENTE

ERP-PAAJ, en `src/tenants/correlativo.repo.ts`:

```
reservar()  →  next = max(ultimo_consumido, max(reservados)) + 1
consumir()  →  sube ultimo_consumido          ← sólo si el MH aceptó
devolver()  →  quita N del array reservados   ← si el MH rechazó
```

`ultimo_consumido` nunca baja — pero como sólo sube al **consumir**, un rechazo
deja el número libre y la emisión siguiente **lo reutiliza**. ERP-PAAJ recicla.

La especificación de CORSA dice lo opuesto: un correlativo reservado no vuelve
al pool. Las dos posturas son defendibles y **mutuamente excluyentes**:

| | Reutilizar (ERP-PAAJ) | No reutilizar (spec CORSA) |
|---|---|---|
| Numeración | sin huecos | un hueco por cada rechazo |
| Auditoría | un número pudo pertenecer a dos intentos | un número, un intento, para siempre |
| RPC | dos fases: reservar + consumir/devolver | una sola sentencia `UPDATE … RETURNING` |

**Recomendación: no reutilizar.** El MH tolera huecos, y una RPC de una sola
sentencia tiene muchísima menos superficie para fallar bajo concurrencia que
una máquina de dos fases con un array de reservas.

### 2.3 — ERP-PAAJ indexa correlativos sólo por tipo de DTE · NO COPIAR

Un archivo por tipo, sin dimensión de establecimiento ni punto de venta, porque
ERP-PAAJ es un único punto de venta.

CORSA tiene sucursales (`branch_id`). El modelo correcto es
`UNIQUE(dte_type, establishment_code, pos_code)`. **Acá ERP-PAAJ no sirve de
referencia.**

Relacionado y fácil de pasar por alto: el MH distingue `codEstable` (el código
que define el contribuyente) de `codEstableMH` (el que asigna Hacienda en el
portal), y lo mismo con `codPuntoVenta` / `codPuntoVentaMH`. Si no coinciden con
lo dado de alta para el NIT, el MH rechaza.

### 2.4 — `totalEnLetras` está roto en producción · NO HEREDAR

```
  15.50 → "15 00/50 DÓLARES"
 123.45 → "123 00/45 DÓLARES"
```

Debería decir "QUINCE 50/100 DÓLARES". El propio código de ERP-PAAJ lo marca
como placeholder. El MH no valida el contenido —por eso pasó 113 veces— pero
sale impreso en cada factura que recibe el cliente.

### 2.5 — Dos cosas de ERP-PAAJ que no sobreviven en Cloudflare

| ERP-PAAJ | Por qué rompe en un Worker |
|---|---|
| `buildIdentificacion()` usa la hora local del servidor (`TZ=America/El_Salvador`) | Los Workers corren **siempre en UTC** y no se puede cambiar. A las 18:00 de El Salvador el `fecEmi` saldría con la fecha del día siguiente. Hay que convertir explícitamente a `America/El_Salvador`. |
| Token del MH cacheado en `let cached` a nivel de módulo | Los isolates son efímeros y hay miles en paralelo. El token tiene que vivir en KV o en Supabase, o CORSA va a pedir `/seguridad/auth` en cada emisión. |

---

## 3. Cómo emite ERP-PAAJ hoy (la referencia)

```
reservar correlativo (SELECT … FOR UPDATE)
  → buildFcf / buildCcf
  → validar contra schema AJV oficial del MH
  → firmar  (HTTP al contenedor Java → JWS compacto)
  → POST al MH
       PROCESADO → consumir correlativo + persistir + PDF
       RECHAZADO → devolver correlativo + audit_events
```

Lo que hay que conservar como principio: **el correlativo se reserva antes de
ir al MH y se confirma sólo si el MH aceptó.** Es lo único de todo esto que no
se puede arreglar después.

### Qué se reusa y qué se descarta

| Se reusa conceptualmente | Se descarta |
|---|---|
| `buildNumeroControl`, `newCodigoGeneracion` | el firmador Java → WebCrypto |
| Estructura FCF / CCF y reglas de IVA | Postgres self-hosted, Docker, Fastify |
| La idea de reservar antes y confirmar después | storage en filesystem |
| Los schemas JSON oficiales del MH | `totalEnLetras`, TZ del servidor, cache en módulo |

---

## 4. La API del Ministerio de Hacienda

| Uso | URL |
|---|---|
| Sandbox | `https://apitest.dtes.mh.gob.sv` |
| Producción | `https://api.dtes.mh.gob.sv` |
| Login | `POST /seguridad/auth` |
| Recepción | `POST /fesv/recepciondte` |
| Anulación | `POST /fesv/anulardte` |

**Autenticación.** El login va en `application/x-www-form-urlencoded`, **no en
JSON** — es el error más fácil de cometer:

```
user=<NIT 14 dígitos>&pwd=<password Hacienda>
→ { status: "OK", body: { token } }
```

El token puede venir con o sin el prefijo `Bearer `; hay que normalizarlo. Dura
24 h (ERP-PAAJ cachea 12 h por margen de reloj). Ante un `401`: limpiar cache,
renovar y reintentar **una sola vez**.

**Campo `ambiente`:** `00` en sandbox, `01` en producción. Viaja dentro del DTE
y también en el body del envío.

**Respuesta de recepción:** `estado` es `PROCESADO` o `RECHAZADO`. Lo que
importa guardar es `selloRecibido` — sin sello el documento no existe para
Hacienda. En rechazo vienen `descripcionMsg`, `codigoMsg` y el array
`observaciones`, que es donde el MH dice qué campo está mal.

---

## 5. Estructura de los documentos

### `numeroControl` — 31 caracteres, formato fijo

```
DTE-NN-EEEEPPPP-NNNNNNNNNNNNNNN
 │   │     │           └── correlativo, 15 dígitos, ceros a la izquierda
 │   │     └── establecimiento (4) + punto de venta (4), [A-Z0-9]
 │   └── tipo de DTE, 2 dígitos
 └── prefijo fijo
```

`codigoGeneracion` es otra cosa: un **UUID v4 en MAYÚSCULAS**. No confundirlos;
van en columnas separadas.

### FCF — tipo `01`, versión 1

- `precioUni` y `ventaGravada` **incluyen IVA**
- `ivaItem = ventaGravada × 0.13 / 1.13` (IVA implícito, informativo)
- receptor **opcional** — la venta de mostrador puede ser anónima
- `totalPagar = subTotal`

### CCF — tipo `03`, versión 3

- `precioUni` y `ventaGravada` van **sin IVA**
- el IVA se lista en `resumen.tributos`, código `'20'`
- receptor **obligatorio y completo**: `nit`, `nrc`, `nombre`, `codActividad`,
  `descActividad`, `direccion{departamento, municipio, complemento}`, `correo`
- `montoTotalOperacion = subTotal + IVA + percepción − retenciones`

El sistema debe **impedir** emitir un CCF si falta cualquiera de esos campos del
receptor, en vez de dejar que lo rechace Hacienda.

---

## 6. Qué le falta a CORSA

### Ya está, y está bien hecho

- **Migración `0029`** — los campos fiscales del cliente ya se derivaron de los
  schemas del MH, con constraints de formato (NIT de 14 o 9 dígitos, NRC de 1-8,
  `cod_actividad` de 2-6). No hay que rehacerlo.
- **`mh-catalogs.ts`** — catálogos CAT-012 / 013 / 019 / 022.
- **`fiscal_documents`** (migración `0022`) — existe con RLS; se extiende.
- **`corsa-cloud-api`** — el Worker ya desplegado sirve de molde: dominio propio,
  secrets por `wrangler secret put`, rate limiting.

### Falta el emisor

Hoy está hardcodeado en [`src/lib/ticket/fromSale.ts`](../src/lib/ticket/fromSale.ts)
y es **dato de relleno**:

```
nit: '0614-010101-000-0'      ← con guiones; el MH exige 14 dígitos sin guiones
nrc: '123456'                 ← placeholder
telefono: '+503 2222-1111'    ← placeholder
```

Y faltan por completo: `codActividad` / `descActividad`,
`tipoEstablecimiento`, departamento y municipio en código CAT-012 / CAT-013,
`codEstable` / `codEstableMH`, `codPuntoVenta` / `codPuntoVentaMH`. Todo eso
sale del portal del MH con el NIT real de CORSA.

---

## 7. Diseño propuesto

### Tablas y RPC (Supabase de CORSA)

```
fiscal_issuer_config    por sucursal: datos públicos del emisor + códigos MH.
                        Sin secretos — esos viven en Cloudflare.

fiscal_correlatives     UNIQUE(dte_type, establishment_code, pos_code)
                        current_value, seeded_by, updated_at

fiscal_documents        extender la de 0022:
                        + idempotency_key UNIQUE   'SALE:{sale_id}:DTE:{tipo}'
                        + codigo_generacion UNIQUE, numero_control UNIQUE
                        + correlative, signed_jws, sello_recepcion
                        + attempt_count
                        + signed_at / submitted_at / accepted_at / rejected_at
                        + status: CREATED | VALIDATED | SIGNED | SUBMITTED
                                | ACCEPTED | REJECTED | RETRY_PENDING
                                | CONTINGENCY | INVALIDATED

fiscal_audit_events     una fila por transición. Nunca secretos.

reserve_dte_correlative(p_dte_type, p_establishment_code, p_pos_code)
```

La reserva ocurre **entera dentro de Postgres**, en una sentencia:

```sql
UPDATE fiscal_correlatives
   SET current_value = current_value + 1
 WHERE dte_type = p_dte_type
   AND establishment_code = p_establishment_code
   AND pos_code = p_pos_code
RETURNING current_value;
```

Nunca `SELECT` → volver al Worker → sumar → `UPDATE`: dos Workers concurrentes
leerían el mismo valor.

### Workers

Worker **separado** de `corsa-cloud-api`. Ese hoy sólo autentica gateways del
PLC; meterle la llave fiscal ampliaría su superficie sin necesidad.

```
corsa-fiscal-api
  POST /v1/dte/emit       idempotente: crea fiscal_document y encola
  GET  /v1/dte/:id        estado, para que el POS haga poll
  POST /v1/dte/retry/:id  reprocesa EL MISMO documento
        ↓ Cloudflare Queue
  consumidor: firmar → MH → persistir
```

La venta no puede quedar esperando a que Hacienda responda: el MH se cuelga
minutos en hora pico. Por eso la emisión es asíncrona y el POS consulta estado.

**En un reintento no se genera nada nuevo.** Ni `codigoGeneracion`, ni
`numeroControl`, ni correlativo. Se recupera el `fiscal_document` y se reprocesa
el mismo.

### Secrets (Cloudflare, `wrangler secret put`)

```
MH_NIT · MH_PASSWORD           credenciales de CORSA en Hacienda
CERT_PKCS8_B64                 llave privada PKCS#8 de CORSA, en base64
CERT_PASSWORD                  passwordPri (portón SHA-512)
SUPABASE_SERVICE_ROLE_KEY
```

Variable no secreta: `MH_ENV` (`sandbox` / `production`).

**Nunca** en Git, en `VITE_*`, en el navegador, en `localStorage`, en el cliente
de Supabase ni en logs. La llave privada no llega al front bajo ninguna
circunstancia: el frontend no firma, no ve credenciales y no genera
correlativos.

---

## 8. Plan de trabajo

### Primera entrega — demostrar que el Java no hace falta

Sólo esto, y nada más:

1. Estudio del output del firmador de ERP-PAAJ — **hecho**, sección 1.
2. Signer propio de CORSA con WebCrypto.
3. Endpoint de prueba en Cloudflare.
4. Certificado y credenciales de CORSA como Secrets.
5. Builder mínimo válido de FCF.
6. Envío al sandbox del MH.
7. **Obtener un DTE aceptado.**

```
CORSA → Cloudflare → CORSA SIGNER → MH → ACEPTADO
```

### Segunda entrega — sólo después de la primera

Builder FCF completo · builder CCF completo · correlativos atómicos ·
`fiscal_documents` · cliente MH con reintentos · idempotencia · integración con
el POS.

### Plan de prueba contra el MH

1. CORSA tramita **su propio** certificado y credenciales en el portal del MH.
2. `MH_ENV=sandbox`. Login → token. *(Gate: `status:"OK"`)*
3. FCF mínima de un ítem, firmada en el Worker. Comparar el header contra
   `eyJhbGciOiJSUzUxMiJ9`.
4. `POST /fesv/recepciondte`. **Gate real: `estado:"PROCESADO"` con
   `selloRecibido`.**
5. Concurrencia: 50 emisiones simultáneas sobre `current_value = 100` → exacto
   101…150, sin repetidos y sin saltos.
6. Idempotencia: doble clic → un solo `fiscal_document`, un solo correlativo.
7. Recién entonces, CCF — el que nadie ha probado nunca (sección 2.1).

---

## 9. Decisiones pendientes

Tres cosas bloquean el arranque:

1. **¿Reciclamos correlativos en rechazo, o dejamos huecos?** (sección 2.2).
   La recomendación es dejar huecos.
2. **¿CORSA ya tiene NIT, NRC y certificado propios tramitados en el MH?** Sin
   eso no se puede correr el paso 4 del plan de prueba.
3. **¿Worker fiscal separado**, o dentro de `corsa-cloud-api`? La recomendación
   es separado.

---

## 10. El PDF no es el DTE

La representación gráfica es un subproducto. El orden es: construir → firmar →
transmitir → **sello del MH** → recién ahí, PDF.

Un error generando el PDF **no puede** hacer fallar una emisión ya aceptada por
Hacienda. Si generarlo dentro del Worker resulta incómodo —`pdfkit` es Node puro
y no corre en Workers— va a un servicio aparte o a la app web.

CORSA ya tiene [`facturaDocument.ts`](../src/lib/fiscal/facturaDocument.ts), que
dibuja la representación gráfica y hoy marca los campos fiscales como
"Pendiente de transmisión". Cuando exista el DTE, esos campos se llenan con
`numeroControl`, `codigoGeneracion`, sello y QR, y el rótulo desaparece.
