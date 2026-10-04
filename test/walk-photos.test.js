import assert from 'node:assert/strict'
import test from 'node:test'

import { mediaRequestUrl, privatePhotoFailureFor, publicPhotoEta, reviewDecisionFor } from '../src/walk-photos.js'

test('photo failures distinguish sign-in, permission, missing-image and connection errors', () => {
  assert.match(privatePhotoFailureFor({ status: 401 }).copy, /Sign out, then sign in/)
  assert.match(privatePhotoFailureFor({ status: 403 }).copy, /You are signed in/)
  assert.match(privatePhotoFailureFor({ status: 404, stage: 'image' }).copy, /image request returned 404/)
  assert.match(privatePhotoFailureFor({ status: 500, stage: 'manifest' }).note, /manifest: 500/)
  assert.match(privatePhotoFailureFor(new TypeError('Failed to fetch')).note, /connection failed/)
})

test('unreviewed matched photos default to private', () => {
  assert.deepEqual(
    reviewDecisionFor({ review: { decisions: {} } }, { id: 'example' }),
    { status: 'unreviewed', visibility: 'private', rotation: 0, caption: '' },
  )
})

test('routes dev media requests through the same-origin Pages proxy', () => {
  assert.equal(
    mediaRequestUrl('/v1/assets/example/content', {
      hostname: 'dev.walks.ashterism.com',
    }),
    '/media-proxy/v1/assets/example/content',
  )
})

test('keeps production media requests on the dedicated media hostname', () => {
  assert.equal(
    mediaRequestUrl('/v1/assets/example/content', {
      hostname: 'walks.ashterism.com',
    }),
    'https://media.ashterism.com/v1/assets/example/content',
  )
})

test('rejects paths outside the media API', () => {
  assert.throws(() => mediaRequestUrl('https://example.com/secret', { hostname: 'dev.walks.ashterism.com' }))
})


test('public photo ETA includes expected time and a conservative buffer', () => {
  const eta = publicPhotoEta(new Date('2026-10-04T17:38:00+02:00'))
  assert.equal(eta.expected.toISOString(), '2026-10-04T16:08:00.000Z')
  assert.equal(eta.buffered.toISOString(), '2026-10-04T16:23:00.000Z')
})
