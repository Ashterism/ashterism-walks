import assert from 'node:assert/strict'
import test from 'node:test'

import { mediaRequestUrl } from '../src/walk-photos.js'

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
