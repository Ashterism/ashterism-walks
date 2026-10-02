#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
worker_dir=$(dirname "$repo_dir")
credential_dir="$worker_dir/credentials"

if [ "$(git -C "$repo_dir" branch --show-current)" != main ]; then
  echo 'The HALMAN checkout must be on main.' >&2
  exit 1
fi
if [ -n "$(git -C "$repo_dir" status --porcelain)" ]; then
  echo 'The HALMAN checkout has uncommitted changes.' >&2
  exit 1
fi
if [ ! -r /volume1/photo/Photos ]; then
  echo 'The photo archive is not readable.' >&2
  exit 1
fi

echo 'Checking GitHub push access (no changes will be pushed)...'
git -C "$repo_dir" push --dry-run origin HEAD:main
if ! git -C "$repo_dir" config user.name > /dev/null; then
  git -C "$repo_dir" config user.name 'Ashterism photo worker'
fi
if ! git -C "$repo_dir" config user.email > /dev/null; then
  git -C "$repo_dir" config user.email 'photo-worker@ashterism.com'
fi

umask 077
mkdir -p "$credential_dir" "$worker_dir/state"
chmod 700 "$worker_dir" "$credential_dir" "$worker_dir/state"
printf 'ZITADEL client ID: ' > /dev/tty
IFS= read -r client_id < /dev/tty
printf 'ZITADEL client secret (input hidden): ' > /dev/tty
stty -echo < /dev/tty
trap 'stty echo < /dev/tty' 0 1 2 3 15
IFS= read -r client_secret < /dev/tty
stty echo < /dev/tty
trap - 0 1 2 3 15
printf '\n' > /dev/tty
if [ -z "$client_id" ] || [ -z "$client_secret" ]; then
  echo 'Both credentials are required.' >&2
  exit 1
fi
printf '%s\n' "$client_id" > "$credential_dir/client-id"
printf '%s\n' "$client_secret" > "$credential_dir/client-secret"
chmod 600 "$credential_dir/client-id" "$credential_dir/client-secret"

echo 'Checking ZITADEL token exchange...'
cd "$repo_dir"
ZITADEL_MEDIA_CLIENT_ID=$client_id ZITADEL_MEDIA_CLIENT_SECRET=$client_secret \
  node --input-type=module -e \
  "import { mediaServiceToken } from './scripts/lib/media-service-token.js'; await mediaServiceToken(); console.log('ZITADEL token OK')" \
  2>&1

echo 'Initialising the photo worker (existing walks will not be uploaded)...'
/bin/sh "$repo_dir/scripts/halman-photo-worker.sh"
echo "Ready. In Synology Task Scheduler, run this as ash every 10 minutes:"
echo "/bin/sh $repo_dir/scripts/halman-photo-worker.sh"
