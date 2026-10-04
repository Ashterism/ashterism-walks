import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { reconcilePhotoReviews } from '../scripts/lib/reconcile-photo-reviews.js'

test('review reconciliation publishes only approved public images, retains private/rejected for undo, and never reuploads images', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-review-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const publicationPath = path.join(dir, '123.publication.json')
  fs.writeFileSync(publicationPath, JSON.stringify({ walkId: '123', collectionId: 'collection', assets: Object.fromEntries(['a', 'b', 'c'].map(id => [id, { assetId: id, archiveRelativePath: `2026/private/${id}.heic`, capturedAt: `2026-10-01T12:00:0${id === 'a' ? 1 : id === 'b' ? 2 : 3}Z`, reviewStatus: 'unreviewed', visibility: 'private' }])) }))
  const assets = {
    a: { id: 'a', visibility: 'public', requiredRoles: [], custom: { reviewStatus: 'keep' }, variants: { display: {} } },
    b: { id: 'b', visibility: 'authenticated', custom: { reviewStatus: 'keep' } },
    c: { id: 'c', visibility: 'authenticated', custom: { reviewStatus: 'reject' } },
  }
  const walk = { id: '123', local: {}, sources: {} }
  let uploaded = 0
  let manifest
  const options = { walk, publicationPath, token: 'service',
    request: async url => assets[url.split('/').pop()],
    upload: async input => { uploaded++; assert.equal(input.file.type, 'application/json'); assert.equal(input.metadata.visibility, 'authenticated'); assert.deepEqual(input.metadata.requiredRoles, ['walks.private_photos']); manifest = JSON.parse(await input.file.text()); return { id: 'manifest' } },
    writeWalk: () => true,
  }
  await reconcilePhotoReviews(options)
  assert.equal(uploaded, 1)
  assert.deepEqual(walk.local.photos.map(photo => photo.assetId), ['a'])
  assert.ok(!JSON.stringify(walk.local.photos).includes('private/'))
  assert.deepEqual(manifest.photos.map(photo => photo.assetId), ['b', 'c'])
  assert.equal(manifest.photos[1].reviewStatus, 'reject')
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '123.json')))
  assert.equal(saved.decisions.a.visibility, 'public')
  assert.equal(saved.decisions.c.status, 'reject')
  await reconcilePhotoReviews(options)
  assert.equal(uploaded, 1)
  // Undo rejection; no originals or image assets are recreated.
  assets.c.custom.reviewStatus = 'keep'
  await reconcilePhotoReviews(options)
  assert.equal(uploaded, 2)
  assert.equal(manifest.photos[1].reviewStatus, 'keep')
  assert.equal(assets.c.visibility, 'authenticated')
  assets.a.variants = {}
  await assert.rejects(reconcilePhotoReviews(options), /no display variant/)
})
