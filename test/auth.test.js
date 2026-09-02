import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OIDC_SCOPE,
  ZITADEL_MEDIA_AUDIENCE_SCOPE,
  ZITADEL_PROJECT_ROLES_SCOPE,
  rolesFromProfile,
  safeReturnUrl,
} from '../src/auth.js'

test('requests a media API audience and project roles during sign-in', () => {
  const scopes = OIDC_SCOPE.split(' ')

  assert.ok(scopes.includes(ZITADEL_MEDIA_AUDIENCE_SCOPE))
  assert.ok(scopes.includes(ZITADEL_PROJECT_ROLES_SCOPE))
})

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
