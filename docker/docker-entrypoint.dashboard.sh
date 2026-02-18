#!/bin/sh
set -e
MQTT_URL="${VITE_MQTT_URL:-wss://rabbitmq-ws.bto.bar/ws}"
echo "Dashboard starting with MQTT URL: $MQTT_URL"
# Escape characters that sed treats as special in the replacement string (|, &, \)
ESCAPED_URL=$(printf '%s\n' "$MQTT_URL" | sed 's/[|&\\]/\\&/g')
find /usr/share/nginx/html -name "*.js" -exec sed -i "s|__MQTT_URL_PLACEHOLDER__|${ESCAPED_URL}|g" {} \;
exec nginx -g "daemon off;"
