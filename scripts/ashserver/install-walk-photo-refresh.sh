#!/usr/bin/env bash
set -euo pipefail

source_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
target_dir=/home/ash/photo-tools
report_dir=/home/ash/photo-ingest-reports

[[ $(id -un) == ash ]] || { echo 'Run this as ash on ashserver.' >&2; exit 1; }
mountpoint -q /mnt/photo
[[ -d /mnt/photo/Photos && -x "$target_dir/run_incremental_ingest.sh" ]]
[[ -f "$target_dir/run_icloud_sync.sh" ]]
command -v python3 >/dev/null
command -v flock >/dev/null
command -v tmux >/dev/null
bash -n "$source_dir/run_icloud_sync.sh"

# Confirm timestamp support in the installed/pinned downloader before replacing
# the wrapper. This is read-only: no login, enumeration or download takes place.
image='icloudpd/icloudpd@sha256:af2bf40cb2c1d42051793b4c3c04c825950697d7fedcd12bd8455d6952395801'
docker run --rm --entrypoint python3 "$image" -c '
from icloudpd.base import skip_created_generator
value = skip_created_generator("skip-created-before", "2026-10-02T09:10:21+00:00")
assert value.isoformat() == "2026-10-02T09:10:21+00:00", value
print("Pinned iCloudPD supports explicit UTC capture windows")
'

umask 007
mkdir -p /mnt/photo/.walk-photo-refresh/requests /mnt/photo/.walk-photo-refresh/results
mkdir -p "$report_dir/scheduler"
[[ -w /mnt/photo/.walk-photo-refresh/requests && -w /mnt/photo/.walk-photo-refresh/results ]]
backup="$target_dir/run_icloud_sync.sh.before-walk-refresh"
if [[ ! -e "$backup" ]]; then
  cp -p "$target_dir/run_icloud_sync.sh" "$backup"
fi
install -m 755 "$source_dir/process-walk-photo-refresh.py" "$target_dir/process-walk-photo-refresh.py"
install -m 755 "$source_dir/run_icloud_sync.sh" "$target_dir/run_icloud_sync.sh"

echo "Installed. Original downloader wrapper preserved at $backup"
echo 'Restart photo-icloud-live once after its current download pass has completed.'
echo 'The existing watchdog then uses the new cooperative watcher; cron is unchanged.'
