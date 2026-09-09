# Activar la sincronización del PLC Gateway

Todo está desarrollado y probado, pero **apagado**. Este documento es la
secuencia para encenderlo cuando decidas.

Mientras esté apagado, el gateway **no abre ninguna conexión hacia afuera**.
Los eventos se acumulan en SQLite marcados como pendientes y se envían todos al
habilitarlo. No se pierde nada por esperar.

---

## Cómo funciona

```
  Surface (carwash)                    Supabase
  ┌──────────────────┐                 ┌────────────────────────┐
  │ CORSA PLC        │   HTTPS         │ Edge Function          │
  │ Gateway          │ ─────────────▶  │ gateway-ingest         │
  │                  │  X-Gateway-Key  │   valida la clave      │
  │ SQLite local     │                 │   escribe con          │
  │ (buffer offline) │                 │   service_role         │
  └──────────────────┘                 └───────────┬────────────┘
         ▲                                         │
         │ Modbus TCP                               ▼
    ┌────┴─────┐                        plc_machine_events
    │   PLC    │                        plc_wash_cycles
    └──────────┘                        plc_gateway_heartbeats
```

**El gateway nunca toca la base de datos.** Escribe contra la Edge Function,
que valida su clave y hace la escritura del lado del servidor. La Surface está
físicamente accesible dentro del local: si tuviera credenciales de base y se
filtraran, el atacante entraría a la base de producción del negocio entero, no
sólo al monitoreo de las máquinas.

---

## Pasos

### 1. Correr la migración

`supabase/migrations/0035_plc_gateway_ingest.sql` en el SQL Editor.

Crea `plc_gateways`, `plc_machine_events`, `plc_wash_cycles`,
`plc_gateway_heartbeats`, la vista `v_plc_gateway_status` y los permisos
`plc.read` / `plc.manage`.

### 2. Desplegar la Edge Function

```bash
supabase functions deploy gateway-ingest --project-ref zvbpkfuehnmqlqimyxcs
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta Supabase sola.

### 3. Generar la clave del gateway

En una terminal:

```bash
openssl rand -hex 32
```

Guardá ese valor: **es la única vez que va a existir en claro.** La base
guarda sólo su hash, así que si esta tabla se filtrara no se podría suplantar
al gateway con lo que hay ahí.

### 4. Registrar el gateway

En el SQL Editor, reemplazando `<CLAVE>` por la que generaste:

```sql
insert into public.plc_gateways (organization_id, gateway_id, name, api_key_hash)
values (
  '00000000-0000-0000-0000-000000000001',
  'CORSA-GATEWAY-01',
  'Surface Sucursal Escalón',
  encode(sha256('<CLAVE>'::bytea), 'hex')
);
```

Verificá que quedó:

```sql
select gateway_id, name, active, left(api_key_hash, 12) || '…' as hash
from public.plc_gateways;
```

### 5. Configurar la Surface

**La clave no va en `appsettings.json`.** Ese archivo se copia, se respalda y
se manda por correo; la clave va como variable de entorno del sistema:

```powershell
# PowerShell como administrador
[Environment]::SetEnvironmentVariable(
  'CORSA_Sync__ApiKey', '<CLAVE>', 'Machine')
```

Después, en `C:\Program Files\CORSA\PLC-Gateway\appsettings.json`:

```json
"Sync": {
  "Enabled": true,
  "Endpoint": "https://zvbpkfuehnmqlqimyxcs.supabase.co/functions/v1/gateway-ingest",
  "IntervalSeconds": 30,
  "BatchSize": 200
}
```

```powershell
Restart-Service CorsaPlcGateway
```

### 6. Verificar

En el log de la Surface debería aparecer:

```
Sincronización HABILITADA hacia https://…/gateway-ingest cada 30 s
```

```powershell
Get-Content "C:\ProgramData\CORSA\PLC-Gateway\logs\gateway-$(Get-Date -Format yyyyMMdd).log" -Tail 20
```

Y en Supabase, al minuto:

```sql
select gateway_id, online, last_seen_at, last_version, pending_events
from public.v_plc_gateway_status;
```

`online = true` significa que el heartbeat está llegando.

Todo lo que el gateway venía acumulando se envía en los primeros ciclos:

```sql
select event_type, count(*) from public.plc_machine_events group by event_type;
```

---

## Idempotencia

Cada evento y ciclo lleva el UUID que generó el gateway y lo conserva en los
reintentos. La Edge Function hace upsert sobre ese identificador.

Esto importa porque el caso normal no es el ideal: el carwash pierde Internet,
el gateway acumula horas de eventos, y al volver la conexión reenvía lotes que
quizás llegaron a medias. **Verificado**: el mismo evento enviado dos veces
deja una sola fila.

Los ciclos sí se actualizan: uno enviado como `IN_PROGRESS` puede llegar
después como `COMPLETED` con su duración.

---

## Apagarlo

```json
"Sync": { "Enabled": false }
```

```powershell
Restart-Service CorsaPlcGateway
```

El gateway deja de salir a Internet y vuelve a acumular localmente. **No se
pierde nada**: lo pendiente sigue en SQLite esperando.

---

## Si algo falla

**`Credenciales inválidas` (401)** → la clave de la variable de entorno no
coincide con el hash registrado. Regenerá y repetí los pasos 3 a 5.

**`Gateway desactivado` (403)** → `update public.plc_gateways set active = true
where gateway_id = 'CORSA-GATEWAY-01';`

**Los eventos no llegan pero no hay errores** → revisá que `Sync.Enabled` sea
`true`. Si está habilitado pero incompleto, el log lo dice al arrancar.

**`pending_events` sube y no baja** → el gateway no está pudiendo enviar.
Revisá el log; los errores de red se registran en nivel Debug para no llenar
el disco cuando no hay Internet.
