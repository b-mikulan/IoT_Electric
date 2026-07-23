#!/bin/sh
set -eu

if [ -f /run/secrets/ews_credentials ]; then
  # credentials.txt treba imati username i password u formatu:
  # EWS_USER=...
  # EWS_PASSWORD=...
  . /run/secrets/ews_credentials
fi

exec "$@"