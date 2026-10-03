#!/usr/bin/env bash
set -euo pipefail

# Source-controlled version of the existing ashserver wrapper. Preserve its
# pinned image, inbox, cookies, filename policy, sidecars and original sizes.
mode=${1:-incremental}
year=${2:-$(date +%Y)}
tools_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
if [[ "$mode" == watch ]]; then
  [[ "$year" =~ ^20[0-9]{2}$ ]] || { echo 'Invalid year' >&2; exit 2; }
  # A watch interval must not retain .icloud-sync.lock while idle. Run the
  # existing one-pass download, then service requests once a minute between
  # ordinary two-hour checks. Only the child download holds that lock.
  while true; do
    "$tools_dir/run_icloud_sync.sh" watch-pass "$year"
    next_check=$(( $(date +%s) + 7200 ))
    while (( $(date +%s) < next_check )); do
      python3 "$tools_dir/process-walk-photo-refresh.py" || echo 'Walk refresh consumer failed; will retry' >&2
      sleep 60
    done
  done
fi
if [[ "$mode" != incremental && "$mode" != bootstrap && "$mode" != watch-pass && "$mode" != window ]]; then
  echo 'Usage: run_icloud_sync.sh [incremental | bootstrap YEAR | watch YEAR | window START_UTC END_UTC]' >&2
  exit 2
fi
if [[ "$mode" != window && ! "$year" =~ ^20[0-9]{2}$ ]]; then
  echo "Invalid year: $year" >&2
  exit 2
fi
if [[ "$mode" == window ]]; then
  python3 - "$year" "${3:-}" <<'PY'
import datetime as dt, sys
dates = [dt.datetime.fromisoformat(value.replace('Z', '+00:00')) for value in sys.argv[1:]]
if any(date.tzinfo is None for date in dates) or not dates[0] < dates[1]:
    raise SystemExit('Window requires ordered timestamps with explicit timezones')
PY
fi

config_dir=/home/ash/.config/photo-ingest
cookie_dir="$config_dir/icloud-cookies"
inbox_dir=/home/ash/icloud-inbox
username_file="$config_dir/icloud-username"
log_dir=/home/ash/photo-ingest-reports/icloud/logs
image='icloudpd/icloudpd@sha256:af2bf40cb2c1d42051793b4c3c04c825950697d7fedcd12bd8455d6952395801'

[[ -s "$username_file" ]] || {
  echo 'iCloud is not authenticated. Run: photo-ingest icloud-auth' >&2
  exit 1
}
if ! mountpoint -q /mnt/photo || [[ ! -d /mnt/photo/Photos ]]; then
  echo 'HALMAN photo archive is not mounted; refusing to start with archive-linked inbox media.' >&2
  exit 1
fi
username=$(<"$username_file")
mkdir -p "$cookie_dir" "$inbox_dir" "$log_dir"
chmod 700 "$config_dir" "$cookie_dir" "$inbox_dir"

exec 7>/home/ash/photo-ingest-reports/.icloud-sync.lock
if ! flock -n 7; then
  echo 'Another iCloud download is already active.' >&2
  exit 1
fi

timestamp=$(date +%Y%m%d-%H%M%S)
log_file="$log_dir/icloud-$mode-$timestamp.log"
# A narrow refresh must not masquerade as a successful full watcher pass.
if [[ "$mode" != window ]]; then
  ln -sfn "$log_file" /home/ash/photo-ingest-reports/icloud/latest.log
fi
exec > >(tee -a "$log_file") 2>&1

options=(
  --username "$username"
  --directory /inbox
  --cookie-directory /cookies
  --password-provider console
  --mfa-provider console
  --folder-structure '{:%Y/%m}'
  --size original
  --live-photo-size original
  --live-photo-mov-filename-policy suffix
  --file-match-policy name-id7
  --xmp-sidecar
  --log-level info
  --no-progress-bar
)
if [[ "$mode" == window ]]; then
  # Avoid --until-found: 100 existing photos inside a long hike must not hide
  # missing assets later in that same activity. Existing inbox assets still
  # use iCloudPD's normal skip-existing policy, including archive-linked files.
  options+=(--skip-created-before "$year" --skip-created-after "$3")
else
  options+=(--until-found 100)
  if [[ "$mode" == bootstrap ]]; then
    options+=(--skip-created-before "$year-01-01" --skip-created-after "$((year + 1))-01-01")
  elif [[ "$mode" == watch-pass ]]; then
    options+=(--skip-created-before "$year-01-01")
  fi
fi

echo "Started iCloud $mode download at $(date --iso-8601=seconds)"
echo "iCloud deletion is disabled. Inbox: $inbox_dir"
docker_options=(
  --rm
  --user "$(id -u):$(id -g)"
  -e HOME=/tmp -e TZ=Europe/Paris
  -v "$cookie_dir:/cookies"
  -v "$inbox_dir:/inbox"
  -v /mnt/photo/Photos:/mnt/photo/Photos:ro
)
if [[ -t 0 ]]; then
  docker_options+=(-it)
  docker run "${docker_options[@]}" "$image" icloudpd "${options[@]}"
else
  docker run "${docker_options[@]}" "$image" icloudpd "${options[@]}" </dev/null
fi
echo "Finished iCloud $mode download at $(date --iso-8601=seconds)"
