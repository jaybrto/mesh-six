#!/bin/sh
set -e
MQTT_URL="${VITE_MQTT_URL:-wss://rabbitmq-ws.bto.bar/ws}"
echo "Dashboard starting with MQTT URL: $MQTT_URL"
find /usr/share/nginx/html -name "*.js" -exec sed -i "s|__MQTT_URL_PLACEHOLDER__|${MQTT_URL}|g" {} \;
exec nginx -g "daemon off;"
