#!/usr/bin/env bash
#
# Prueba el API de ingesta del PLC Gateway sin tocar la Surface.
#
# Sirve para separar dos problemas que se confunden todo el tiempo: «el API no
# funciona» y «el gateway no está enviando». Si este script pasa, el API está
# bien y lo que falta es del lado de la Surface.
#
#   ./scripts/probar-ingesta.sh <endpoint> <gateway-id> <clave> [anon-key]
#
# Ejemplo:
#   ./scripts/probar-ingesta.sh \
#     https://abcdefgh.supabase.co/functions/v1/gateway-ingest \
#     CORSA-GATEWAY-01 \
#     "$(cat mi-clave.txt)"
#
set -uo pipefail

ENDPOINT="${1:-}"; GATEWAY_ID="${2:-}"; KEY="${3:-}"; ANON="${4:-}"

if [[ -z "$ENDPOINT" || -z "$GATEWAY_ID" || -z "$KEY" ]]; then
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

ENDPOINT="${ENDPOINT%/}"
FALLOS=0

# UUIDs fijos por corrida: el segundo envío reusa el del primero, que es
# justamente lo que prueba la idempotencia.
EVENT_ID=$(cat /proc/sys/kernel/random/uuid)
CYCLE_ID=$(cat /proc/sys/kernel/random/uuid)
AHORA=$(date -u +%Y-%m-%dT%H:%M:%SZ)

hdrs=(-H "Content-Type: application/json"
      -H "X-Gateway-Id: $GATEWAY_ID"
      -H "X-Gateway-Key: $KEY")
[[ -n "$ANON" ]] && hdrs+=(-H "apikey: $ANON" -H "Authorization: Bearer $ANON")

# $1 descripción  $2 ruta  $3 cuerpo  $4 código HTTP esperado
probar() {
  local desc="$1" ruta="$2" cuerpo="$3" esperado="$4"
  local salida codigo respuesta
  salida=$(curl -sS -m 30 -w $'\n%{http_code}' -X POST "$ENDPOINT/$ruta" "${hdrs[@]}" -d "$cuerpo" 2>&1)
  codigo="${salida##*$'\n'}"
  respuesta="${salida%$'\n'*}"

  if [[ "$codigo" == "$esperado" ]]; then
    printf '  \033[32m✓\033[0m %-42s %s  %s\n' "$desc" "$codigo" "$respuesta"
  else
    printf '  \033[31m✗\033[0m %-42s %s (esperado %s)\n      %s\n' \
      "$desc" "$codigo" "$esperado" "$respuesta"
    FALLOS=$((FALLOS + 1))
  fi
}

echo
echo "Probando $ENDPOINT"
echo "  gateway: $GATEWAY_ID"
echo

echo "Autenticación"
# Con la clave equivocada debe responder lo mismo que con un gateway que no
# existe: distinguirlos le diría a un atacante qué identificadores son reales.
salida=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -X POST "$ENDPOINT/heartbeat" \
  -H "Content-Type: application/json" -H "X-Gateway-Id: $GATEWAY_ID" \
  -H "X-Gateway-Key: clave-incorrecta-$RANDOM" \
  ${ANON:+-H "apikey: $ANON" -H "Authorization: Bearer $ANON"} -d '{}' 2>&1)
if [[ "$salida" == "401" ]]; then
  printf '  \033[32m✓\033[0m %-42s 401\n' "clave incorrecta se rechaza"
else
  printf '  \033[31m✗\033[0m %-42s %s (esperado 401)\n' "clave incorrecta se rechaza" "$salida"
  [[ "$salida" == "401" ]] || FALLOS=$((FALLOS + 1))
  if [[ "$salida" == "200" ]]; then
    echo "      GRAVE: aceptó una clave inventada."
  fi
fi

echo
echo "Ingesta"
probar "heartbeat" heartbeat \
  "{\"gateway_id\":\"$GATEWAY_ID\",\"timestamp\":\"$AHORA\",\"version\":\"prueba\",\"pending_events\":0,\"machines\":[{\"machine_id\":\"prueba-1\",\"plc_connected\":true}]}" 200

probar "evento" events \
  "{\"events\":[{\"id\":\"$EVENT_ID\",\"machine_id\":\"prueba-1\",\"event_type\":\"WASH_COMPLETED\",\"previous_value\":\"0\",\"new_value\":\"1\",\"event_timestamp\":\"$AHORA\",\"created_at\":\"$AHORA\"}]}" 200

probar "ciclo en curso" cycles \
  "{\"cycles\":[{\"id\":\"$CYCLE_ID\",\"machine_id\":\"prueba-1\",\"started_at\":\"$AHORA\",\"status\":\"IN_PROGRESS\"}]}" 200

echo
echo "Idempotencia — esto es lo que pasa al volver el Internet"
# El carwash pierde conexión, el gateway acumula, y al reconectar reenvía un
# lote que quizás ya llegó a medias. Reenviar no debe duplicar.
probar "mismo evento reenviado" events \
  "{\"events\":[{\"id\":\"$EVENT_ID\",\"machine_id\":\"prueba-1\",\"event_type\":\"WASH_COMPLETED\",\"previous_value\":\"0\",\"new_value\":\"1\",\"event_timestamp\":\"$AHORA\",\"created_at\":\"$AHORA\"}]}" 200

probar "mismo ciclo, ahora completado" cycles \
  "{\"cycles\":[{\"id\":\"$CYCLE_ID\",\"machine_id\":\"prueba-1\",\"started_at\":\"$AHORA\",\"completed_at\":\"$AHORA\",\"duration_seconds\":180,\"status\":\"COMPLETED\"}]}" 200

echo
echo "Rechazos"
probar "acción inexistente" cualquiera '{}' 404
probar "JSON inválido" events 'no-es-json' 400

echo
if [[ $FALLOS -eq 0 ]]; then
  echo -e "\033[32mEl API responde bien.\033[0m Verificá en el SQL Editor que quedó UNA sola fila:"
else
  echo -e "\033[31m$FALLOS prueba(s) fallaron.\033[0m"
fi

cat <<SQL

  select count(*) as eventos from public.plc_machine_events
   where id = '$EVENT_ID';                        -- debe dar 1, no 2

  select status, duration_seconds from public.plc_wash_cycles
   where id = '$CYCLE_ID';                        -- COMPLETED, 180

  select gateway_id, online, last_version from public.v_plc_gateway_status;

  -- Para borrar lo que dejó esta prueba:
  delete from public.plc_machine_events    where machine_id = 'prueba-1';
  delete from public.plc_wash_cycles       where machine_id = 'prueba-1';
  delete from public.plc_gateway_heartbeats where version   = 'prueba';
SQL

exit $((FALLOS > 0))
