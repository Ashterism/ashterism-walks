# Ashterism Walks

A Vite and MapLibre site for walking and hiking routes recorded with Garmin.

## View the site locally

```sh
npm run dev
```

Open the local HTTP address printed by Vite. Do not open `index.html` directly from Finder.

## Sync activities on demand

```sh
npm run sync
```

This asks Intervals.icu for Garmin walks and hikes. It downloads a FIT only for a new or changed activity, reconciles the response with Ashterism's canonical walk records, then regenerates the public catalogue.

If the latest activity was cropped or otherwise edited in Intervals.icu, force a fresh Intervals-generated FIT with:

```sh
npm run sync:latest
```

The previous FIT is preserved under `private/garmin/history/` before a changed version replaces it.

Cloudflare's `ashterism-walks-sync` Worker dispatches the GitHub Actions workflow every 15 minutes. GitHub performs the FIT conversion, commits changed route data, and publishes the Vite build. The workflow also provides a manual **Run workflow** action; its `refresh_latest` option forces the latest edited activity to be regenerated. The workflow reads the API key from the `INTERVALS_ICU_API_KEY` repository secret.

The scheduler lives under `cloudflare/`. It requires a `GITHUB_TOKEN` Worker secret with **Actions: write** permission for this repository. Deploy it with:

```sh
npm run scheduler:deploy
```

Sync/build and Pages deployment use separate job concurrency groups. Sync/build
is serialized without cancelling an active data commit; deployment lets a newer
build supersede a stalled deployment. A Pages environment wait must never hold
the sync lock. Running build/deploy jobs have 15/10-minute timeouts (environment
approval waits are not covered by job timeouts).

If activities stop appearing, check Cloudflare `sync_dispatch_started` and
`sync_dispatch_completed`, then GitHub workflow runs, including `waiting` runs.
On 11 October 2026, a Pages deployment waiting since 6 October held the old
workflow-wide concurrency lock: later 15-minute dispatches replaced pending
runs without running sync. Cancelling that stale run restored sync and imported
three walks. Intervals credentials and the data commit/push were healthy.
For recovery, cancel a confirmed stale deployment and dispatch `site.yml` on
`main`; verify the sync log, canonical `data/walks/` commit, and Pages deployment.

On macOS the sync reads the Intervals.icu API key from the `ashterism-walks` / `intervals.icu` Keychain entry. An automated server can instead provide the key through the `INTERVALS_ICU_API_KEY` environment variable.

## Generate private training context

Create a compact 14-day JSON snapshot for exercise coaching with the same
Intervals.icu authentication used by the walk sync:

```sh
npm run training-context
```

The export is written to `private/training-context.json`. It contains a summary,
recent activities, current and daily fitness/fatigue/load, and any available
wellness values such as resting heart rate, HRV, sleep, soreness and readiness.
Missing wellness metrics are omitted rather than guessed.

Use `-- --days 30` to change the window (up to 90 days), or `-- --stdout` to
send the JSON to another local tool. The file stays under the ignored `private/`
directory: the site is hosted on public GitHub Pages, so this data must not be
placed in `public/` without adding an authenticated backend.

## Import reconstructed historical walks

Some historical walks have statistics in Withings but no route recording. A Google Timeline export can supply a sparse coordinate trace for the same period. Preview the configured reconstruction without writing anything:

```sh
npm run import:withings-timeline -- /path/to/withings-export /path/to/location-history.json
```

After reviewing the matched point counts and distances, apply it with:

```sh
npm run import:withings-timeline -- /path/to/withings-export /path/to/location-history.json --apply
```

The importer combines tracker fragments belonging to the same day's journey, uses Withings for activity statistics, crops Google Timeline coordinates to the corresponding time window, and records the route as estimated. The raw exports are archived under `private/` and remain outside Git; the public-safe canonical records and generated route geometry are versioned in Git.

## Rename or hide a walk

Ashterism-owned fields are stored independently from provider values. A local name always wins over the Intervals name:

```sh
npm run rename -- 24098515780 "Mialet evening walk"
```

Restore the provider's name with:

```sh
npm run rename -- 24098515780 --clear
```

Add an Ashterism-owned note to a walk with:

```sh
npm run notes -- 24098515780 "Walked with Sam; muddy after the bridge."
```

Use `--clear` in place of the note to remove it. Notes are shown near the bottom of the walk detail page and are not overwritten by provider syncs.

Hide a walk from the published map without deleting its record or route:

```sh
npm run visibility -- 24098515780 hidden
```

Change `hidden` to `public` to publish it again.

## Data ownership and reconciliation

Ashterism is the system of record. Garmin, Intervals.icu, Strava, Withings and Google Timeline are linked providers, not owners of the published archive.

- `data/walks/` contains one canonical, public-safe JSON object per activity.
- `data/route-versions/` contains immutable route versions addressed by checksum.
- `public/data/` is generated from the canonical records and active route versions.
- Each walk has an Ashterism-owned `photos` list ready for externally hosted image URLs and captions; it is empty until the photo archive is connected.
- A valid changed route from Intervals becomes the active version; previous versions remain stored.
- An empty or invalid replacement route cannot overwrite the last valid route.
- An activity missing from a successful provider response is marked for review but remains published.
- An activity whose provider type changes away from walk/hike is marked for review but remains published.
- A failed provider request stops the sync before reconciliation, so an outage cannot remove or alter existing walks.
- Local names, notes, activity-type corrections and visibility always win over provider values.
- Provider distance, timing, ascent and valid route edits update the corresponding source snapshot.
- Reconstructed routes retain an explicit estimated status, their contributing source IDs and a public provenance label.

This separation means the public archive and its history remain usable if Intervals.icu is unavailable or replaced later.

## Optional sign-in

The map and all public walks remain available without an account. The subtle account menu in the site header provides an optional Ashterix sign-in for features that need extra permission, such as private photographs later.

Authentication uses the `Ashterism Walks` project in ZITADEL and the browser-safe Authorization Code with PKCE flow. The application has no client secret: its client ID is public by design. Only users assigned to the project can complete sign-in. Current roles are:

- `private_photos` — may view protected photographs when the photo service is connected.
- `admin` — reserved for future editing and administration.

The browser session and its roles may be used to adapt the interface, but they are not the security boundary. The future NAS-backed photo API must validate the access token and required role itself before returning any protected metadata or image bytes. Private photographs and their private metadata must never be copied into `public/` or the public walk catalogue.

The sign-in request also asks ZITADEL for the `Ashterix Media` project audience (`389018638520205980`) and project-role claims. This lets the same browser-safe Walks login produce an access token intended for the NAS media API. The API still validates that audience and enforces `walks.private_photos`, `media.editor`, or `media.admin` itself.

Signed-in users also see a `Walk books` entry in the account menu. Its first version is a deliberately simple book → walk → detail layout. The committed site contains only the interface preview: real book metadata and photographed pages must come from the authenticated private service, not the GitHub Pages bundle.

## Privacy boundary

- Raw FIT files, source exports, manifests and previous versions remain under `private/` and are ignored by Git.
- Canonical records and route versions are public-safe and versioned in Git.
- Public filenames use numeric Garmin IDs or neutral provider-prefixed IDs.
- Generated routes contain route geometry and selected activity statistics, not heart-rate streams, email addresses or original private filenames.
- Public photo URLs may be recorded in canonical walks. Protected photo metadata will instead be requested from the authenticated photo service when it exists.

## Prepare and review photographs for a walk

The manual preparation command finds matching archive photographs, uploads new
candidates to Ashterix Media as authenticated assets, creates a protected
manifest, and updates the canonical walk and public catalogue with only the
manifest pointer. Candidates remain private and marked `Unreviewed`; the public
`photos` list stays empty until a photograph is explicitly made public. The
Git-ignored publication ledger under `private/photo-reviews/` makes a successful
rerun idempotent.

Copy a current access token from a signed-in Media editor/admin session into the
environment, then run:

```sh
ASHTERIX_MEDIA_TOKEN='…' npm run photos:prepare -- intervals-178050639
```

Use `--archive /another/archive/root` when the archive is not mounted at
`/Volumes/photo/Photos`. Do not commit or paste the token into a file. After the
resulting commit is deployed on Walks, an account with
`walks.private_photos` sees the protected candidates immediately.

A server worker can instead set `ZITADEL_MEDIA_CLIENT_ID` and
`ZITADEL_MEDIA_CLIENT_SECRET` for a dedicated ZITADEL service account with JWT
access tokens and the `media.editor` role. The command then obtains a short-lived
Media token itself; the viewer's browser session is never used for uploads. On
HALMAN, pass `--archive /volume1/photo/Photos` and
`--state-dir /volume1/docker/ashterism-walks-photo-worker/state` so the private
publication ledger survives code updates.

The local review workspace finds candidate images in the verified NAS archive using the walk time window, photo GPS metadata and route proximity. It never reads the live iCloud inbox and does not publish or alter archive files.

```sh
npm run photos:review -- --walk photo-20220417 --archive /Volumes/photo/Photos
```

Open `http://127.0.0.1:4175`. The contact-sheet view shows the complete candidate set for comparison. Every thumbnail has direct `Private`, `Public` and `Not included` controls. Select individual thumbnails or use `Select all shown`, which respects the active status filter, then apply the same decisions in bulk when useful. Double-click a thumbnail, or select one and choose `Open one`, for rotation, captioning and closer inspection. Untouched matches are visible only to authorised private accounts and clearly labelled `Unreviewed`; rejected photographs are hidden everywhere. Reviewed photographs remain private unless explicitly marked public. Decisions are saved under the Git-ignored `private/photo-reviews/` directory, so review can be stopped and resumed safely. Rerun `photos:prepare` after changing decisions to update Media metadata and the protected/public associations.

### Walk viewing preference

Signed-in users can change **Settings → Show walks** in the account menu. It is
OFF by default; signed-out visitors always use that default. Garmin walking
activities (including explicitly marked post-run walks) are hidden while hikes
and historical/non-Garmin routes retain their existing behaviour. The published
catalogue and photo-worker eligibility are unchanged.

The existing `ashterism-walks-sync` Worker exposes only `GET` and `PUT
/api/preferences`. The `WALK_PREFERENCES` KV binding stores one `showWalks`
boolean per verified ZITADEL subject. The Worker validates RS256 signatures,
issuer, expiry and the Walks project audience (`388903513951875876`) using
ZITADEL JWKS. The browser requests that audience alongside its existing Media
scope; sessions created before this change may need sign-out/sign-in once.
`WALKS_ORIGINS` permits the production Walks origin and the two Vite localhost
origins only. Preference responses are private/no-store. Saves update the view
immediately and roll back with an error if persistence fails. Cloudflare KV is
eventually consistent: another device/region may take about a minute to observe
a recent save. Each sign-in restores the saved value; there is no browser-stored
preference and no polling of other devices.

To label an activity manually, set `local.postRun` to the boolean `true` in its
canonical record and run `npm run catalogue`. The generated public field
`postRun: true` makes a walking detail heading show `WALKING · POST-RUN` using
the existing typography. No automatic detection or activity reclassification
is performed. `npm run scheduler:deploy` deploys the existing Worker with its
committed KV binding and preserves the 15-minute activity-sync cron.
