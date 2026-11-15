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
notify_authentication_failure() {
  local ping_file="$config_dir/healthchecks-icloud-url"
  local monitor_log=/home/ash/photo-ingest-reports/scheduler/healthchecks.log
  local ping_url
  if [[ ! -s "$ping_file" ]]; then
    echo "$(date --iso-8601=seconds) iCloud auth failure alert skipped: Healthchecks URL missing" >> "$monitor_log"
    return 0
  fi

  ping_url=$(<"$ping_file")
  ping_url=${ping_url%/}
  if curl -fsS --max-time 10 --retry 2 \
      -o /dev/null \
      --data-binary "iCloud authentication is required. SSH to ashserver and run: photo-ingest icloud-auth. Enter the Apple password and any verification code in that terminal; the password is not sent to Healthchecks." \
      "$ping_url/fail"; then
    echo "iCloud Healthchecks authentication failure alert sent"
  else
    echo "$(date --iso-8601=seconds) iCloud Healthchecks authentication failure ping failed" >> "$monitor_log"
  fi
}

run_icloudpd() {
  local status
  if [[ -t 0 ]]; then
    docker_options+=(-it)
    if docker run "${docker_options[@]}" "$image" icloudpd "${options[@]}"; then
      return 0
    else
      status=$?
    fi
  else
    if docker run "${docker_options[@]}" "$image" icloudpd "${options[@]}" </dev/null; then
      return 0
    else
      status=$?
    fi
  fi

  # tee writes asynchronously. Wait briefly for a definitive auth message
  # before deciding whether this needs the immediate Healthchecks alert.
  for ((i=0; i<20; i++)); do
    if grep -Eiq 'Authentication required for Account\\.|Invalid email/password combination' "$log_file"; then
      notify_authentication_failure
      break
    fi
    sleep 0.25
  done
  return "$status"
}

run_icloudpd
echo "Finished iCloud $mode download at $(date --iso-8601=seconds)"

# Only a genuinely completed watcher pass counts as success.
# An Apple indexing response must never generate a success heartbeat.
if [[ "$mode" == watch-pass ]]; then
  ping_file="$config_dir/healthchecks-icloud-url"
  monitor_log=/home/ash/photo-ingest-reports/scheduler/healthchecks.log

  # Allow the existing tee logger to finish writing.
  for ((i=0; i<20; i++)); do
    if grep -qF "All photos and videos have been downloaded" "$log_file"; then
      break
    fi
    sleep 0.25
  done

  if grep -qF "All photos and videos have been downloaded" "$log_file" \
      && ! grep -qF "has not finished indexing yet" "$log_file"; then
    if [[ -s "$ping_file" ]]; then
      if curl -fsS --max-time 10 --retry 2 \
          -o /dev/null \
          --data-binary "iCloud watch-pass completed successfully at $(date --iso-8601=seconds)" \
          "$(<"$ping_file")"; then
        echo "iCloud Healthchecks success heartbeat sent"
      else
        echo "$(date --iso-8601=seconds) iCloud Healthchecks ping failed" >> "$monitor_log"
      fi
    else
      echo "$(date --iso-8601=seconds) iCloud Healthchecks URL missing" >> "$monitor_log"
    fi
  else
    echo "iCloud check incomplete; no success heartbeat sent"
  fi
fi
