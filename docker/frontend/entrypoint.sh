#!/bin/sh
set -e

status=0
node /app/runtime-config.mjs /app/dist /app/serve.json /tmp/serve.json \
  /tmp/nedra-config-error /tmp/nedra-config-error.json || status=$?

if [ "$status" -eq 3 ]; then
  exec serve -s /tmp/nedra-config-error -l 3000 -c /tmp/nedra-config-error.json
fi
if [ "$status" -ne 0 ]; then
  exit "$status"
fi

exec serve -s dist -l 3000 -c /tmp/serve.json
