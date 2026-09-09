# Publicar un instalador en la pantalla Software

La pantalla **Software** (Administración → Software, sólo Super Admin) lista
instaladores descargables. El archivo vive en el bucket privado `software` de
Supabase Storage; la tabla `software_releases` sólo guarda el metadato.

El bucket es privado a propósito: uno público serviría el instalador a
cualquiera que adivinara la URL, sin sesión. La descarga usa una URL firmada
que vive 5 minutos y se genera recién al hacer clic.

---

## Publicar el CORSA PLC Gateway

### 1. Subir el archivo

El paquete está en:

```
/home/pablo/projects/Corsa-PLC-Gateway/dist/CORSA-PLC-Gateway-1.0.0-win-x64.zip
```

Subilo desde **Supabase Dashboard → Storage → software**, en la ruta:

```
plc-gateway/CORSA-PLC-Gateway-1.0.0-win-x64.zip
```

> Se usa el dashboard y no la app porque el archivo pesa 75 MB: la subida
> estándar del navegador tiene un tope de 50 MB en varios planes de Supabase.
> Si el bucket no aparece, corré antes la migración `0034`.

### 2. Registrar la versión

En el SQL Editor:

```sql
insert into public.software_releases (
  organization_id, product, name, version, platform,
  description, storage_path, file_name, file_size_bytes, sha256,
  is_current, release_notes
) values (
  '00000000-0000-0000-0000-000000000001',
  'plc-gateway',
  'CORSA PLC Gateway',
  '1.0.0',
  'win-x64',
  'Servicio de Windows que monitorea las máquinas de lavado por Modbus TCP. Solo lectura: no envía comandos a los PLC.',
  'plc-gateway/CORSA-PLC-Gateway-1.0.0-win-x64.zip',
  'CORSA-PLC-Gateway-1.0.0-win-x64.zip',
  78556257,
  '0ad77ff744fcc0c09df20a64adafad93e640c66786c34566067f810ec650fc4f',
  true,
  'INSTALACIÓN

1. Descomprimir el archivo en cualquier carpeta temporal.
2. Abrir PowerShell COMO ADMINISTRADOR.
3. Ejecutar:

     cd <carpeta descomprimida>
     .\\scripts\\install.ps1

4. Abrir http://localhost:5055 para verificar.

REQUISITOS
- Windows 10/11 x64
- Permisos de administrador
- Acceso de red a los PLC (puerto 502)
- No hace falta instalar .NET: el binario es autocontenido.

CONFIGURAR LAS MÁQUINAS
  C:\\Program Files\\CORSA\\PLC-Gateway\\appsettings.json
  Restart-Service CorsaPlcGateway

COMPROBAR SEÑALES ANTES DE PRODUCCIÓN
  cd "C:\\Program Files\\CORSA\\PLC-Gateway\\diagnostics"
  .\\Corsa.PlcGateway.Diagnostics.exe 192.168.5.10 192.168.5.11'
);
```

### 3. Verificar

Entrá a **Software** en el sistema. Si el archivo no llegó al bucket, la
pantalla lo dice explícitamente y deshabilita el botón, en vez de dejar que
alguien haga clic y reciba un error.

---

## Publicar una versión nueva

1. Compilar: `.\\scripts\\build.ps1` en el repositorio del gateway.
2. Empaquetar y calcular el checksum.
3. Subir con la versión nueva en la ruta.
4. Marcar la anterior como no vigente y registrar la nueva:

```sql
update public.software_releases
set is_current = false
where product = 'plc-gateway';

-- …y después el insert de la versión nueva con is_current = true
```

No se borra la versión anterior: si la nueva falla en sitio, hay que poder
volver a la que funcionaba.

---

## Datos del paquete actual

| | |
|---|---|
| Archivo | `CORSA-PLC-Gateway-1.0.0-win-x64.zip` |
| Tamaño | 75MB |
| SHA-256 | `0ad77ff744fcc0c09df20a64adafad93e640c66786c34566067f810ec650fc4f` |

Verificación en la PC destino:

```powershell
Get-FileHash CORSA-PLC-Gateway-1.0.0-win-x64.zip -Algorithm SHA256
```
