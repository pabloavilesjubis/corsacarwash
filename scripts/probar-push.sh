#!/usr/bin/env bash
#
# Dispara notificaciones de prueba a TUS dispositivos, sin esperar un lavado.
#
# POR QUÉ EXISTE, SI LA PANTALLA YA TIENE BOTONES
# Los botones de simulación de Configuración → Notificaciones sólo se compilan
# en desarrollo (import.meta.env.DEV). En el CORSA desplegado no existen — que
# es lo correcto: nadie debería poder disparar notificaciones falsas desde la
# aplicación de producción.
#
# Pero probar el push en un iPhone REQUIERE el CORSA desplegado: iOS sólo
# permite Web Push a las apps instaladas desde HTTPS, y localhost no se puede
# instalar en el teléfono. Este script es la forma de cerrar ese hueco: pide el
# evento desde afuera, con tu propia sesión, sin que exista ningún botón.
#
#   ./scripts/probar-push.sh <email> <contraseña> [evento] [máquina]
#
# Eventos:  test (por defecto) · pro · elite · signature · error1 · error2 · cierre
#
# Ejemplo:
#   ./scripts/probar-push.sh pablo@corsa.com 'mi-clave' signature
#
# ANTES DE CORRER ESTO, habilitar la simulación (y apagarla al terminar):
#   update public.corsa_notification_config set simulacion_habilitada = true;
#
# El evento llega SÓLO a tus dispositivos y no escribe en ninguna tabla de
# máquinas: no crea lavados ni mueve las estadísticas del día.
#
set -uo pipefail

EMAIL="${1:-}"; PASS="${2:-}"; EVENTO="${3:-test}"; MAQUINA="${4:-}"

raiz="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "$EMAIL" || -z "$PASS" ]]; then
  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

# La URL y la anon key salen de .env.local, que es donde ya están. Pedirlas por
# argumento invitaría a pegarlas en el historial de la terminal.
env_local="$raiz/.env.local"
if [[ ! -f "$env_local" ]]; then
  echo "❌ No encuentro $env_local" >&2
  exit 1
fi

# Toma el último valor de la clave, le saca comillas y el \r de Windows.
leer() {
  grep -E "^$1=" "$env_local" | tail -1 | cut -d= -f2- \
    | sed -e 's/\r$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

URL="$(leer VITE_SUPABASE_URL)"
ANON="$(leer VITE_SUPABASE_ANON_KEY)"

if [[ -z "$URL" || -z "$ANON" ]]; then
  echo "❌ Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY en .env.local" >&2
  exit 1
fi
URL="${URL%/}"

# ── 1. Armar el evento ──
case "$EVENTO" in
  test)                 ruta="test";     cuerpo='{}' ;;
  pro|elite|signature)  ruta="simulate"
                        cuerpo=$(printf '{"tipo":"WASH_COMPLETED","servicio":"%s","machine":%s}' \
                                 "$(printf '%s' "$EVENTO" | tr '[:lower:]' '[:upper:]')" \
                                 "$([[ -n "$MAQUINA" ]] && printf '"%s"' "$MAQUINA" || echo null)") ;;
  error1)               ruta="simulate"; cuerpo='{"tipo":"MACHINE_ERROR","machine":"machine-1"}' ;;
  error2)               ruta="simulate"; cuerpo='{"tipo":"MACHINE_ERROR","machine":"machine-2"}' ;;
  cierre)               ruta="simulate"; cuerpo='{"tipo":"DAILY_CLOSE"}' ;;
  *)
    echo "❌ Evento desconocido '$EVENTO'."
    echo "   Usá: test · pro · elite · signature · error1 · error2 · cierre"
    exit 1 ;;
esac


# ── 2. Iniciar sesión ──
# Se usa TU sesión y no el service_role a propósito: corsa_simular_evento()
# valida el permiso plc.manage y la bandera de simulación con el usuario que
# llama. Con service_role se saltearían las dos validaciones, que son
# justamente las que impiden que esto funcione en producción por descuido.
echo
echo "Iniciando sesión como $EMAIL…"

login=$(curl -sS -m 30 -X POST "$URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "$(printf '{"email":%s,"password":%s}' \
        "$(printf '%s' "$EMAIL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
        "$(printf '%s' "$PASS"  | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" 2>&1)

TOKEN=$(printf '%s' "$login" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("access_token",""))
except Exception: print("")' 2>/dev/null)

if [[ -z "$TOKEN" ]]; then
  echo "❌ No se pudo iniciar sesión."
  printf '%s\n' "$login" | head -3
  exit 1
fi
echo "  ✓ sesión abierta"

echo "Disparando «$EVENTO»…"

respuesta=$(curl -sS -m 60 -w $'\n%{http_code}' \
  -X POST "$URL/functions/v1/push-dispatch/$ruta" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "apikey: $ANON" \
  -d "$cuerpo" 2>&1)

codigo="${respuesta##*$'\n'}"
salida="${respuesta%$'\n'*}"

echo
if [[ "$codigo" == "200" ]]; then
  echo "  ✓ $salida"
  echo
  echo "Revisá el teléfono. Si no llegó nada:"
  echo "  · ¿activaste las notificaciones en Configuración → Notificaciones?"
  echo "  · select * from v_corsa_notificaciones order by created_at desc limit 5;"
  echo "  · select device_name, status, http_status, provider_error"
  echo "      from notification_deliveries d"
  echo "      join push_subscriptions s on s.id = d.subscription_id"
  echo "     order by d.created_at desc limit 5;"
else
  echo "  ✗ HTTP $codigo"
  echo "    $salida"
  echo
  case "$salida" in
    *simulación*|*simulacion*)
      echo "  → Habilitala y volvé a intentar:"
      echo "      update public.corsa_notification_config"
      echo "         set simulacion_habilitada = true;" ;;
    *permiso*)
      echo "  → Tu usuario necesita el permiso plc.manage." ;;
    *VAPID*)
      echo "  → Faltan los secretos de la función:"
      echo "      node scripts/generar-vapid.mjs" ;;
  esac
  exit 1
fi
echo
