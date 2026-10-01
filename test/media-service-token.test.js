import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mediaServiceScopes,
  mediaServiceToken,
} from '../scripts/lib/media-service-token.js'

test('requests a JWT Media token with audience and role scopes', async () => {
  let request
  const token = await mediaServiceToken({
    clientId: 'worker-id',
    clientSecret: 'worker-secret',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return {
        ok: true,
        json: async () => ({ token_type: 'Bearer', access_token: 'header.body.signature' }),
      }
    },
  })

  assert.equal(token, 'header.body.signature')
  assert.equal(request.url, 'https://ashterix-mkjzns.eu1.zitadel.cloud/oauth/v2/token')
  assert.equal(request.options.method, 'POST')
  assert.equal(
    request.options.headers.Authorization,
    `Basic ${Buffer.from('worker-id:worker-secret').toString('base64')}`,
  )
  assert.equal(request.options.body.get('grant_type'), 'client_credentials')
  assert.equal(request.options.body.get('scope'), mediaServiceScopes)
  assert.match(mediaServiceScopes, /389018638520205980:aud/)
  assert.match(mediaServiceScopes, /org:projects:roles/)
})

test('rejects opaque service tokens before making Media requests', async () => {
  await assert.rejects(
    mediaServiceToken({
      clientId: 'worker-id',
      clientSecret: 'worker-secret',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ token_type: 'Bearer', access_token: 'opaque' }),
      }),
    }),
    /JWT bearer access tokens/,
  )
})
