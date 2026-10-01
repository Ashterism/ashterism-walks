#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
worker_dir=$(dirname "$repo_dir")

export ZITADEL_MEDIA_CLIENT_ID
export ZITADEL_MEDIA_CLIENT_SECRET
ZITADEL_MEDIA_CLIENT_ID=$(head -n 1 "$worker_dir/credentials/client-id")
ZITADEL_MEDIA_CLIENT_SECRET=$(head -n 1 "$worker_dir/credentials/client-secret")

cd "$repo_dir"
exec node scripts/run-photo-worker.js \
  --archive /volume1/photo/Photos \
  --state-dir "$worker_dir/state"
