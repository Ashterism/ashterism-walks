import assert from 'node:assert/strict'
import test from 'node:test'

import { rolesFromProfile, safeReturnUrl } from '../src/auth.js'

test('reads Zitadel project roles from the standard claim', () => {
  assert.deepEqual(
    rolesFromProfile({
      'urn:zitadel:iam:org:project:roles': {
        private_photos: { organization: 'ashterix' },
        admin: { organization: 'ashterix' },
      },
    }),
    ['private_photos', 'admin'],
  )
})

test('only restores same-origin URLs after authentication', () => {
  const origin = 'https://walks.ashterism.com'
  assert.equal(
    safeReturnUrl(
      'https://walks.ashterism.com/?walk=withings-202508110129&view=details',
      origin,
    ),
    '/?walk=withings-202508110129&view=details',
  )
  assert.equal(safeReturnUrl('https://example.com/private', origin), '/')
})
