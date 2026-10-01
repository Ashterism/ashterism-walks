# New-walk photo automation

## Intended behaviour

The normal Intervals/Garmin sync makes a new walk appear on Walks. A server with
access to `/volume1/photo/Photos` then scans the relevant archive months, uploads
matching photographs to Ashterix Media, and associates a protected manifest with
the walk. Every new photograph starts authenticated/private and `unreviewed`.
The public `walk.photos` array remains empty. After signing in, a user with
`walks.private_photos` can see the photographs and their `Needs review` state;
signing in is only for viewing and review, never for authorising the upload.

## What exists on `feat/new-walk-photo-prep`

- Candidate matching, including a time window derived from a newly synced
  Intervals walk when no historical photo-archive snapshot exists.
- A manual `photos:prepare` command that uploads to Media, records
  `archiveRelativePath`, writes a protected manifest, updates the walk/catalogue,
  and reuses its private publication ledger on rerun.
- Walks rendering that fetches the manifest and image variants with the signed-in
  viewer's access token.

This has automated tests and a build, but has not had a real Media upload or a
signed-in dev-site check. No branch has been merged into `dev` or `main` for this
work.

## Server work still required

1. Give a worker on HALMAN direct read-only access to the photo archive and
   persistent storage for the private publication ledger. HALMAN is preferred
   because the archive and Media service are already there.
2. Create a dedicated ZITADEL service account with a JWT access token, Media
   audience, and `media.editor` role. The worker obtains short-lived tokens
   without any browser session. Keep its credential outside Git. The Media API
   currently validates JWTs and does not accept an opaque service token.
3. Run the same candidate preparation/upload code when a newly synced walk is
   available. Retry safely after reboot and after transient archive/Media
   failures. Verify the archive has received the photos before finalising an
   empty candidate set.
4. Make the new manifest asset ID available to Walks. The current implementation
   writes it into the canonical walk and rebuilds the catalogue. A permanent
   worker therefore needs a source-controlled update path, or a new authenticated
   Media lookup endpoint and corresponding Walks rendering change. Choose and
   test one path before deployment.
5. Test one walk end to end on `dev`, including anonymous and signed-in views,
   reruns, restart recovery, and HEIC display variants. Only then promote the
   proven behaviour to the production sync/deployment path.

The next implementation session should start with a read-only HALMAN check and
the service-account setup, then complete the worker and dev integration. Do not
infer that a browser login supplies the worker's credential.
