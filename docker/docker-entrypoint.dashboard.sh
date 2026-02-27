#!/bin/sh
set -e

MQTT_URL="${VITE_MQTT_URL:-wss://rabbitmq-ws.bto.bar/ws}"
ONBOARDING_URL="${VITE_ONBOARDING_URL:-}"

echo "Dashboard starting with MQTT URL: $MQTT_URL, Onboarding URL: $ONBOARDING_URL"

# Escape characters that sed treats as special in the replacement string (|, &, \)
ESCAPED_MQTT=$(printf '%s\n' "$MQTT_URL" | sed 's/[|&\\]/\\&/g')
ESCAPED_ONBOARDING=$(printf '%s\n' "$ONBOARDING_URL" | sed 's/[|&\\]/\\&/g')

find /usr/share/nginx/html -name "*.js" \
  -exec sed -i "s|__MQTT_URL_PLACEHOLDER__|${ESCAPED_MQTT}|g" {} \; \
  -exec sed -i "s|__ONBOARDING_URL_PLACEHOLDER__|${ESCAPED_ONBOARDING}|g" {} \;

exec nginx -g "daemon off;"
