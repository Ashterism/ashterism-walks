# New-walk photo automation

## Intended behaviour

The normal Intervals/Garmin sync makes a new walk appear on Walks. A server with
access to `/volume1/photo/Photos` then scans the relevant archive months, uploads
matching photographs to Ashterix Media, and associates a protected manifest with
the walk. Every new photograph starts authenticated/private and `unreviewed`.
The public `walk.photos` array remains empty. After signing in, a user with
`walks.private_photos` can see the photographs and their `Needs review` state;
signing in is only for viewing and review, never for authorising the upload.

## What exists on `main`

- Candidate matching, including a time window derived from a newly synced
  Intervals walk when no historical photo-archive snapshot exists.
- A manual `photos:prepare` command that uploads to Media, records
  `archiveRelativePath`, writes a protected manifest, updates the walk/catalogue,
  and reuses its private publication ledger on rerun.
- Walks rendering that fetches the manifest and image variants with the signed-in
  viewer's access token.
- `scripts/run-photo-worker.js`, which watches for newly added walks on `main`,
  waits for archive matches, and then prepares photos and pushes the manifest
  pointer. Its first run records a baseline, so it does not import old walks.

This has automated tests and a build, but has not had a real Media upload or a
signed-in site check. The worker has not been installed or scheduled on HALMAN.

The installation notes above describe the original rollout. Current production
documentation in `Ashterism/ashterix` confirms the HALMAN worker is installed as
`ash`, runs every ten minutes, and keeps its checkout/state under
`/var/services/homes/ash/ashterism-photo-worker`.

## Targeted iCloud refresh for newly detected walks

The worker now persists a request under
`/volume1/photo/.walk-photo-refresh/requests/<walkId>.json` before matching a
pending walk. This is the same share ashserver mounts at
`/mnt/photo/.walk-photo-refresh`. No remote shell credentials or additional
network service are required. Existing pending walks (including `24576877588`)
get requests automatically; the baseline/new-walk detection rules are unchanged.
The consumer rejects capture windows older than eight days rather than doing a
historical backfill.

The window uses timezone-bearing `startDate` plus `elapsedTimeSeconds`, including
pauses, with one hour before and after the activity. The upper buffer is clipped
to now. Timezone-free start values are rejected; `startDateLocal` is not treated
as UTC. Mialet (`24576877588`) requests `2026-10-02T09:10:21.000Z` through
`2026-10-02T11:57:43.000Z`. Cross-midnight and New Year windows are supported.

`scripts/ashserver/run_icloud_sync.sh` is the source-controlled replacement for
the existing ashserver wrapper, based on the production script supplied on
3 October 2026. It preserves the pinned iCloudPD image, credentials, cookie
directory, shared inbox, name-ID matching, original sizes, and Live Photo/XMP
options. `window START END` supplies exact capture timestamp filters. It omits
`--until-found 100` for targeted requests so an already-ingested stretch cannot
stop enumeration before missing photos later in a long walk. Existing retained
or archive-linked inbox files use iCloudPD's existing skip-existing mechanism.

The old continuous watcher held `.icloud-sync.lock` through its two-hour sleep.
The replacement performs the same bounded year-onward pass every two hours but
releases the download lock between passes. During that wait it calls
`process-walk-photo-refresh.py` every minute. That consumer:

- Takes the existing `.pipeline-cron.lock` across download and ingest. A running
  normal cron pipeline defers the request without acknowledging it.
- Uses the existing `.icloud-sync.lock` for the downloader and the unchanged
  `run_incremental_ingest.sh` for relevant inbox years. That script retains its
  `.incremental.lock`, manual-operation checks, saved plan, shared cache,
  exact-byte/content dedupe, XMP checks, review holds, collision-safe copies and
  checksum verification. No separate copying/ingest implementation is added.
- Writes a matching acknowledgement only after both stages succeed. Failures
  remain retryable with a thirty-minute backoff. A partial ingest cannot release
  HALMAN to publish an incomplete set. Targeted logs do not replace the full
  watcher's `icloud/latest.log` or change cron's last-success timestamp.

HALMAN continues its ten-minute retry schedule. Once acknowledged, it scans the
archive and uses the existing Media publication ledger. If photos or the archive
month are still absent, a pending walk requests another refresh after thirty
minutes, allowing for late iCloud uploads. Photos remain authenticated/private
and unreviewed; the public photo array remains empty until review.

## Deploy the refresh

The source is committed to `Ashterism/ashterism-walks`. The ashserver photo-tools
directory is not currently a documented Git checkout, so install these tracked
scripts from that repository. Existing ingest tools and cron entries are kept.
SSH deployment from the development Mac was unavailable (`Permission denied`).

On **ashserver**, as `ash` (clone once; use `git pull --ff-only` on later updates):

```sh
git clone https://github.com/Ashterism/ashterism-walks.git /home/ash/ashterism-walks
bash /home/ash/ashterism-walks/scripts/ashserver/install-walk-photo-refresh.sh
```

The installer checks UTC-filter support in the pinned image without accessing
iCloud, checks the archive mount, preserves the original wrapper, and installs
two files under `/home/ash/photo-tools`. The shared request/result directories
must be writable by HALMAN's `ash` account and ashserver's CIFS mount identity.

The existing tmux watcher needs one restart to pick up its changed loop. Wait
until its current download pass has finished (it is in the two-hour wait), then:

```sh
tmux send-keys -t photo-icloud-live C-c
```

After that tmux session has exited, confirm the old download lock is free and
start the replacement watcher:

```sh
flock -n /home/ash/photo-ingest-reports/.icloud-sync.lock true
tmux new-session -d -s photo-icloud-live 'bash /home/ash/photo-tools/run_icloud_sync.sh watch 2026; result=$?; echo iCloud-downloader-exited-with-status-$result; sleep 10'
```

If the lock check fails or the session still exists, wait rather than starting
another downloader. Future restarts use the unchanged watchdog/cron. No Immich
command is needed.

On **HALMAN**, update the worker checkout and run it once:

```sh
git -C /var/services/homes/ash/ashterism-photo-worker/repo pull --ff-only
/bin/sh /var/services/homes/ash/ashterism-photo-worker/repo/scripts/halman-photo-worker.sh
```

Its existing scheduler then picks up the result. Inspect Mialet's result on
ashserver with:

```sh
cat /mnt/photo/.walk-photo-refresh/results/24576877588.json
```

Expect `status: complete`, then a HALMAN commit `Prepare private photos for
24576877588`. Check the walk while signed in: candidates should appear as
unreviewed/private. An anonymous empty `photos` array is expected until review.
No live photo download/upload or UI verification was performed during local
development. An auth/metadata hold remains an operational issue for review.

Local validation: `npm test`, `python3 test/ashserver-refresh-test.py`, and
`bash -n scripts/ashserver/*.sh`. The tests cover UTC windowing, elapsed seven-hour
hikes, queue restart/idempotency, stale acknowledgements, New Year boundaries,
normal-pipeline lock contention and ingest failure recovery.

## Server work still required

1. Install a separate `main` checkout on HALMAN with read access to
   `/volume1/photo/Photos` and a persistent state directory outside the checkout.
   Node 18 and Git are installed; Docker is not available to the `ash` user and
   is not needed for the worker.
2. The `walk-photo-worker` ZITADEL service account is active, issues JWT tokens,
   and has `media.editor`. Generate a client secret and store its client ID and
   secret on HALMAN outside Git. Do not send them through chat.
3. Give the HALMAN checkout GitHub write access, then initialise and schedule
   `node scripts/run-photo-worker.js --archive /volume1/photo/Photos --state-dir
   <persistent-directory>` through Synology Task Scheduler. The task retries
   walks whose photos are not yet in the archive.
4. Test one walk end to end: Media upload, protected manifest, source commit,
   anonymous and signed-in views, rerun, restart recovery, and HEIC variants.

The browser login supplies viewing access only. The worker uses its own
short-lived token and must not rely on a human session.
