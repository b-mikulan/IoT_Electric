#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
script="$repo_dir/tools/stack-setup/prepare-instance.js"

if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  exec node "$script" "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Potreban je Node >=24 ili Docker." >&2
  exit 1
fi

base_dir=/opt/iot-electric
args=("$@")
mounts=(--mount "type=bind,src=$repo_dir,dst=/source,readonly")
base_arg_index=-1
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[i]}" in
    --base-dir)
      base_dir="${args[i+1]:?Nedostaje putanja za --base-dir}"
      base_arg_index=$((i+1))
      ;;
    --widgets|--connection-file)
      input_file="$(realpath -e -- "${args[i+1]:?Nedostaje ulazna datoteka}")"
      if [[ "$input_file" == *","* ]]; then
        echo "Putanja ulazne datoteke ne smije sadrzavati zarez." >&2
        exit 1
      fi
      args[i+1]="$input_file"
      mounts+=(--mount "type=bind,src=$input_file,dst=$input_file,readonly")
      ;;
  esac
done

tty_args=()
if [[ -t 0 && -t 1 ]]; then tty_args=(-it); fi
if [[ " ${args[*]} " == *" --help "* ]]; then
  exec docker run --rm "${mounts[@]}" node:24-alpine node /source/tools/stack-setup/prepare-instance.js --help
fi
if [[ "$EUID" != 0 ]]; then
  echo "Pokreni skriptu sa sudo radi prava na serveru." >&2
  exit 1
fi
if [[ "$base_dir" == *","* || "$repo_dir" == *","* ]]; then
  echo "Putanje za Docker mount ne smiju sadrzavati zarez." >&2
  exit 1
fi
umask 022
mkdir -p -- "$base_dir"
base_dir="$(cd -- "$base_dir" && pwd -P)"
if ((base_arg_index >= 0)); then
  args[base_arg_index]="$base_dir"
else
  args+=(--base-dir "$base_dir")
fi
published_ports="$(docker ps --format '{{.Ports}}')"
# Use the host network so the helper checks the real server's published ports.
exec docker run --rm "${tty_args[@]}" --network host \
  "${mounts[@]}" --mount "type=bind,src=$base_dir,dst=$base_dir" \
  --env "STACK_SETUP_PUBLISHED_PORTS=$published_ports" \
  --workdir /source node:24-alpine \
  node /source/tools/stack-setup/prepare-instance.js "${args[@]}"
