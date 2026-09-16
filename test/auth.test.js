import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OIDC_SCOPE,
  ZITADEL_MEDIA_AUDIENCE_SCOPE,
  ZITADEL_PROJECT_ROLES_SCOPE,
  rolesFromProfile,
  safeReturnUrl,
} from '../src/auth.js'
import { BOOK_CATALOGUE_ASSET_ID, mediaUrl } from '../src/book-library.js'

test('requests a media API audience and project roles during sign-in', () => {
  const scopes = OIDC_SCOPE.split(' ')

  assert.ok(scopes.includes(ZITADEL_MEDIA_AUDIENCE_SCOPE))
  assert.ok(scopes.includes(ZITADEL_PROJECT_ROLES_SCOPE))
})

test('builds private media URLs only from API paths', () => {
  assert.equal(
    mediaUrl(`/v1/assets/${BOOK_CATALOGUE_ASSET_ID}/content`),
    `https://media.ashterism.com/v1/assets/${BOOK_CATALOGUE_ASSET_ID}/content`,
  )
  assert.throws(() => mediaUrl('https://example.com/private'))
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

test('reads Zitadel roles when the claim is returned as an array', () => {
  assert.deepEqual(
    rolesFromProfile({
      'urn:zitadel:iam:org:project:roles': [
        { 'walks.private_photos': { organization: 'ashterix' } },
        { 'media.editor': { organization: 'ashterix' } },
      ],
    }),
    ['walks.private_photos', 'media.editor'],
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
