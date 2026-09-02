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

The GitHub Actions workflow also provides an hourly sync and a manual **Run workflow** action. Its `refresh_latest` option forces the latest edited activity to be regenerated. The workflow reads the API key from the `INTERVALS_ICU_API_KEY` repository secret and publishes the Vite build to GitHub Pages.

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

Signed-in users also see a `Walk books` entry in the account menu. Its first version is a deliberately simple book → walk → detail layout. The committed site contains only the interface preview: real book metadata and photographed pages must come from the authenticated private service, not the GitHub Pages bundle.

## Privacy boundary

- Raw FIT files, source exports, manifests and previous versions remain under `private/` and are ignored by Git.
- Canonical records and route versions are public-safe and versioned in Git.
- Public filenames use numeric Garmin IDs or neutral provider-prefixed IDs.
- Generated routes contain route geometry and selected activity statistics, not heart-rate streams, email addresses or original private filenames.
- Public photo URLs may be recorded in canonical walks. Protected photo metadata will instead be requested from the authenticated photo service when it exists.
