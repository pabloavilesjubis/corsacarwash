#!/usr/bin/env bash
#
# CORSA — deja `push-dispatch` desplegada y con sus secretos puestos.
#
#   ./scripts/desplegar-push.sh
#
# Hace, en orden, lo que hay que hacer una sola vez:
#
#   1. comprueba que la CLI de Supabase esté conectada;
#   2. enlaza el proyecto si hace falta;
#   3. mira si ya hay un par VAPID cargado — si lo hay, NO lo toca;
#   4. genera el par sólo si falta, y lo carga como secreto;
#   5. despliega la función;
#   6. comprueba que /vapid-public-key responda 200.
#
# POR QUÉ NO REGENERA LAS CLAVES
# El navegador ata cada suscripción a la clave pública con la que se creó.
# Generar un par nuevo no «actualiza» nada: deja fuera de juego a todos los
# teléfonos ya registrados, que siguen suscritos contra una clave que el
# servidor ya no tiene, y los pushes empiezan a fallar sin que nada lo indique.
# Por eso el paso 3 es una comprobación y no un `set` incondicional — este
# script se puede correr las veces que haga falta.
#
# LA CLAVE PRIVADA no se imprime, no se guarda en el repositorio y no pasa por
# la línea de comandos (donde `ps` la vería): va por un archivo temporal con
# permisos 600 que se borra al salir, pase lo que pase.
#
set -uo pipefail

REF="${SUPABASE_PROJECT_REF:-zvbpkfuehnmqlqimyxcs}"
SUBJECT="${VAPID_SUBJECT:-mailto:soporte@corsacarwash.com}"
raiz="$(cd "$(dirname "$0")/.." && pwd)"
cd "$raiz" || exit 1

echo
echo "CORSA — despliegue de push-dispatch  ·  proyecto $REF"
echo

# ── 1. La CLI ──
if ! command -v supabase >/dev/null 2>&1; then
  echo "❌ No está la CLI de Supabase."
  echo "   npm i -g supabase   (o: brew install supabase/tap/supabase)"
  exit 1
fi

if ! supabase projects list >/dev/null 2>&1; then
  echo "❌ La CLI no tiene sesión."
  echo
  echo "   supabase login"
  echo
  echo "   Abre el navegador y hay que autorizar ahí; no se puede hacer"
  echo "   desde un script. También sirve exportar un token personal:"
  echo "     export SUPABASE_ACCESS_TOKEN=sbp_…"
  exit 1
fi
echo "  ✓ CLI conectada"

# ── 2. El proyecto ──
if [[ "$(cat supabase/.temp/project-ref 2>/dev/null)" != "$REF" ]]; then
  echo "  · enlazando el proyecto…"
  if ! supabase link --project-ref "$REF"; then
    echo "❌ No se pudo enlazar el proyecto $REF."
    exit 1
  fi
fi
echo "  ✓ proyecto enlazado"

# ── SQL contra el proyecto ──
# La CLI no ejecuta SQL suelto (`db push` aplicaría TODAS las migraciones, que
# no es lo que se quiere acá), así que esto va por la API de gestión con el
# mismo token que dejó `supabase login`.
export TOKEN_FILE="$HOME/.supabase/access-token"
export REF

sql() {
  [[ -s "$TOKEN_FILE" ]] || return 1
  SQL_QUERY="$1" node -e '
    const https = require("https"), fs = require("fs")
    const pat = fs.readFileSync(process.env.TOKEN_FILE, "utf8").trim()
    const data = JSON.stringify({ query: process.env.SQL_QUERY })
    const req = https.request({
      hostname: "api.supabase.com",
      path: `/v1/projects/${process.env.REF}/database/query`,
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json",
                 "Content-Length": Buffer.byteLength(data) },
    }, r => { let b = ""; r.on("data", d => b += d); r.on("end", () => {
        if (r.statusCode >= 200 && r.statusCode < 300) process.stdout.write(b)
        else { process.stderr.write(b); process.exit(1) } }) })
    req.on("error", e => { process.stderr.write(e.message); process.exit(1) })
    req.write(data); req.end()' 2>/dev/null
}

despacho_configurado() {
  if sql "select count(*)::int as n from public.corsa_dispatch_config where enabled" \
       2>/dev/null | grep -q '"n":1'
  then echo 1; else echo 0; fi
}

# ── 3. ¿Ya hay claves? ──
# `secrets list` muestra los nombres y un digest, nunca los valores: sirve para
# saber si existen sin llegar a verlas.
secretos="$(supabase secrets list --project-ref "$REF" 2>/dev/null)"
tiene() { printf '%s' "$secretos" | grep -qw "$1" ; }

faltan=()
for s in VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT PUSH_DISPATCH_SECRET; do
  tiene "$s" || faltan+=("$s")
done

# El despacho cuenta como algo que falta aunque el secreto exista: tenerlo
# cargado en la función y NO en la base deja los eventos reales sin salir, y
# como el digest no se puede leer, la única salida es rotarlo.
if [[ ${#faltan[@]} -eq 0 && "$(despacho_configurado)" == "1" ]]; then
  echo "  ✓ los secretos ya están cargados (no se toca el par VAPID)"
else
  # Si la pública ya existe pero falta la privada —o al revés— no se puede
  # arreglar generando: el par tiene que ser el mismo. Mejor parar y decirlo.
  if tiene VAPID_PUBLIC_KEY && ! tiene VAPID_PRIVATE_KEY; then
    echo "❌ Está VAPID_PUBLIC_KEY pero no VAPID_PRIVATE_KEY."
    echo "   Son un par: hay que cargar la privada que corresponde a esa pública."
    echo "   Si se perdió, generá un par nuevo a mano y contá con que todos los"
    echo "   dispositivos ya registrados van a tener que volver a suscribirse."
    exit 1
  fi

  if [[ ${#faltan[@]} -gt 0 ]]; then
    echo "  · faltan: ${faltan[*]}"
  else
    echo "  · los secretos están, pero la base no tiene configurado el despacho"
  fi

  umask 077
  env_tmp="$(mktemp)"
  trap 'rm -f "$env_tmp"' EXIT INT TERM

  if tiene VAPID_PUBLIC_KEY; then
    echo "  · el par VAPID ya existe; sólo se completa lo que falta"
  else
    echo "  · generando el par VAPID (una sola vez en la vida del proyecto)…"
    node -e '
      const { webcrypto: c } = require("node:crypto")
      const b64 = b => Buffer.from(b).toString("base64")
        .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")
      c.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"])
        .then(async par => {
          const pub = new Uint8Array(await c.subtle.exportKey("raw", par.publicKey))
          const jwk = await c.subtle.exportKey("jwk", par.privateKey)
          process.stdout.write(`VAPID_PUBLIC_KEY=${b64(pub)}\nVAPID_PRIVATE_KEY=${jwk.d}\n`)
        })
    ' >> "$env_tmp" || { echo "❌ No se pudo generar el par VAPID."; exit 1; }
  fi

  tiene VAPID_SUBJECT || echo "VAPID_SUBJECT=$SUBJECT" >> "$env_tmp"

  # La llave con la que el cron y el trigger de la base llaman a /run. Sin ella
  # la ruta responde 503 a propósito: un despachador sin llave es un endpoint
  # público para vaciar la cola.
  #
  # Tiene que quedar en DOS lados —el secreto de la función y la fila de
  # corsa_dispatch_config— y `secrets list` sólo muestra un digest, así que un
  # secreto ya cargado es un secreto que nadie puede volver a leer. Por eso se
  # decide acá, donde todavía está en claro, y se escribe en los dos lugares en
  # la misma corrida. Si falta en cualquiera de los dos, se rota: rotarlo no
  # cuesta nada —no está atado a ningún dispositivo, al revés que VAPID—.
  if ! tiene PUSH_DISPATCH_SECRET || [[ "$(despacho_configurado)" != "1" ]]; then
    SECRETO_DESPACHO="$(openssl rand -hex 32)"
    echo "PUSH_DISPATCH_SECRET=$SECRETO_DESPACHO" >> "$env_tmp"
  fi

  if ! supabase secrets set --env-file "$env_tmp" --project-ref "$REF" >/dev/null; then
    echo "❌ No se pudieron cargar los secretos."
    exit 1
  fi
  rm -f "$env_tmp"
  echo "  ✓ secretos cargados (la privada no se imprimió ni quedó en disco)"
fi

# ── 4. Desplegar ──
echo "  · desplegando…"
if ! supabase functions deploy push-dispatch --project-ref "$REF"; then
  echo "❌ Falló el despliegue."
  exit 1
fi
echo "  ✓ push-dispatch desplegada"

# ── 4b. Quién despierta al despachador ──
# Desplegar la función no basta para los eventos REALES. Un lavado que termina
# escribe una fila en notification_events y ahí se queda: la base no habla
# HTTPS, así que alguien tiene que llamar a /run. Con pg_net, el trigger que ya
# está puesto hace ese POST y el push sale en segundos.
#
# El push de PRUEBA sí funciona sin esto —la ruta /test despacha en línea— y
# por eso este hueco no se nota hasta que se espera el primer lavado de verdad.
if [[ -n "${SECRETO_DESPACHO:-}" ]]; then
  echo "  · configurando quién despierta al despachador…"
  if sql "create extension if not exists pg_net;
          select public.corsa_configurar_despacho(
            'https://$REF.supabase.co/functions/v1/push-dispatch/run',
            '$SECRETO_DESPACHO');" >/dev/null
  then
    echo "  ✓ pg_net instalado y despacho configurado"
  else
    echo "  ⚠ No se pudo configurar el despacho automático."
    echo "    El push de prueba va a funcionar igual, pero los eventos reales"
    echo "    (WASH_COMPLETED, MACHINE_ERROR) se van a quedar encolados."
    echo "    Ver docs/NOTIFICACIONES_PUSH.md §5.5."
  fi
  unset SECRETO_DESPACHO
elif [[ "$(despacho_configurado)" == "1" ]]; then
  echo "  ✓ el despacho automático ya estaba configurado"
fi

# ── 5. Comprobar ──
# Es la comprobación que importa: que `deploy` haya terminado bien no dice que
# la función responda, y es exactamente este GET el que hace la PWA.
url="https://$REF.supabase.co/functions/v1/push-dispatch/vapid-public-key"
echo "  · probando $url"
respuesta="$(curl -sS -m 30 -w $'\n%{http_code}' "$url" 2>&1)"
codigo="${respuesta##*$'\n'}"
cuerpo="${respuesta%$'\n'*}"

echo
if [[ "$codigo" == "200" ]] && printf '%s' "$cuerpo" | grep -q '"publicKey"'; then
  echo "  ✓ HTTP 200 · $(printf '%s' "$cuerpo" | head -c 40)…"

  # ── 6. Que la base esté a la altura ──
  # Desplegar la función no alcanza: el teléfono consigue la clave, se suscribe
  # y recién entonces intenta guardarse con corsa_registrar_dispositivo. Si la
  # base tiene la versión vieja —sin p_reactivar— eso falla con PGRST202
  # después de haber pedido el permiso, que es el peor momento para fallar.
  # Mejor enterarse acá.
  anon="$(grep -E '^VITE_SUPABASE_ANON_KEY=' .env.local 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/\r$//' -e 's/^"\(.*\)"$/\1/')"
  if [[ -n "$anon" ]]; then
    echo "  · comprobando la migración 0042 en la base…"
    rpc="$(curl -sS -m 20 -X POST "https://$REF.supabase.co/rest/v1/rpc/corsa_registrar_dispositivo" \
      -H "apikey: $anon" -H "Content-Type: application/json" \
      -d '{"p_endpoint":"x","p_p256dh":"x","p_auth":"x","p_device_name":"x","p_user_agent":"x","p_platform":"x","p_standalone":false,"p_reactivar":true}' 2>&1)"

    # «Se necesita una sesión» es la respuesta correcta: la función existe con
    # los ocho parámetros y rechazó la llamada por no tener sesión, que es su
    # trabajo. PGRST202 significa que no existe con esa firma.
    if printf '%s' "$rpc" | grep -q 'PGRST202'; then
      echo
      echo "  ⚠ La base tiene una versión vieja de corsa_registrar_dispositivo."
      echo "    La suscripción del teléfono va a fallar al guardarse."
      echo
      echo "    Aplicá la migración (es idempotente, se puede correr de nuevo):"
      echo "      Dashboard → SQL Editor → pegar el contenido de"
      echo "      supabase/migrations/0042_notificaciones_push.sql → Run"
      echo
      exit 1
    fi
    echo "  ✓ la base tiene la firma nueva"
  fi

  echo
  echo "Listo. Ahora, en el teléfono:"
  echo "  Configuración → Notificaciones → Activar, y después «Diagnóstico»."
else
  echo "  ✗ HTTP $codigo"
  echo "    $cuerpo"
  echo
  case "$codigo" in
    404) echo "  → La función no quedó desplegada. Revisá el paso anterior." ;;
    503) echo "  → Está desplegada pero sin VAPID_PUBLIC_KEY. Volvé a correr esto." ;;
  esac
  exit 1
fi
echo
