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
