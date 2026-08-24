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

This asks Intervals.icu for Garmin walks and hikes, downloads only FIT files that are not already in the private local archive, then regenerates `public/data/walks.json` and the route GeoJSON files.

If the latest activity was cropped or otherwise edited in Intervals.icu, force a fresh Intervals-generated FIT with:

```sh
npm run sync:latest
```

The previous FIT is preserved under `private/garmin/history/` before a changed version replaces it.

On macOS the sync reads the Intervals.icu API key from the `ashterism-walks` / `intervals.icu` Keychain entry. An automated server can instead provide the key through the `INTERVALS_ICU_API_KEY` environment variable.

## Privacy boundary

- Raw FIT files, manifests and previous versions remain under `private/` and are ignored by Git.
- Public filenames use numeric Garmin IDs or neutral `intervals-…` IDs.
- Generated routes contain route geometry and selected activity statistics, not heart-rate streams, email addresses or original private filenames.
