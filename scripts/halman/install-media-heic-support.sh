#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP=/volume1/docker/ashterix-media/app
if [[ "$#" -lt 1 ]]; then
  echo 'Usage: bash install-media-heic-support.sh MANIFEST_UUID [MANIFEST_UUID ...]' >&2
  exit 1
fi
command -v python3 >/dev/null
sudo -v
if sudo docker compose version >/dev/null 2>&1; then
  compose() { sudo docker compose "$@"; }
else
  compose() { sudo docker-compose "$@"; }
fi
cd "$APP"
compose config --services | grep -qx media
python3 "$SCRIPT_DIR/patch-media-heic.py" "$APP"
IMAGE="$(sudo docker inspect --format '{{.Config.Image}}' app_media_1)"
# Update the lockfile on the NAS using the existing Node runtime, not host npm.
sudo docker run --rm --user "$(id -u):$(id -g)" --entrypoint npm \
  -v "$APP:/app" -w /app "$IMAGE" \
  install --package-lock-only --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache
compose build media
# No source/metadata writes were made to the running container. Stop the API only
# for the short repair phase; restart even when conversion fails.
trap 'compose up -d --no-deps media' EXIT
compose stop media
compose run --rm --no-deps -T --entrypoint node media - --apply "$@" \
  < "$SCRIPT_DIR/repair-media-variants.cjs"
compose up -d --no-deps media
trap - EXIT
echo 'HEIC support installed and requested walk variants repaired.'
