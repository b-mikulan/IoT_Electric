#!/bin/sh
set -eu

if [ -f /run/secrets/ews_credentials ]; then
  set -a
  . /run/secrets/ews_credentials
  set +a
fi

exec "$@"