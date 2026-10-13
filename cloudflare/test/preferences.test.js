import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { handlePreferences, verifyAccessToken, ISSUER, AUDIENCE } from '../src/preferences.js'

const pair = await generateKeyPair('RS256')
const jwk = await exportJWK(pair.publicKey)
const keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] })
const verify = (token) => verifyAccessToken(token, keySet)
const tokenFor = (subject = 'alice', options = {}) => new SignJWT({})
  .setProtectedHeader({ alg: 'RS256', kid: 'test' })
  .setSubject(subject).setIssuer(options.issuer ?? ISSUER)
  .setAudience(options.audience ?? AUDIENCE).setIssuedAt()
  .setExpirationTime(options.expiration ?? '5m').sign(options.key ?? pair.privateKey)
const origin = 'https://walks.ashterism.com'
const makeEnv = () => {
  const values = new Map()
  return { values, WALKS_ORIGINS: origin, WALK_PREFERENCES: {
    get: async (key) => values.has(key) ? JSON.parse(values.get(key)) : null,
    put: async (key, value) => values.set(key, value),
  } }
}
const request = (token, method = 'GET', body, requestOrigin = origin) => new Request('https://worker.test/api/preferences', {
  method, headers: { Origin: requestOrigin, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

test('signed users read and update only their own preference across sessions/devices', async () => {
  const env = makeEnv()
  const alice = await tokenFor()
  const bob = await tokenFor('bob')
  assert.deepEqual(await (await handlePreferences(request(alice), env, verify)).json(), { showWalks: false })
  const saved = await handlePreferences(request(alice, 'PUT', { showWalks: true }), env, verify)
  assert.equal(saved.status, 200)
  const secondDevice = await tokenFor('alice')
  assert.deepEqual(await (await handlePreferences(request(secondDevice), env, verify)).json(), { showWalks: true })
  assert.deepEqual(await (await handlePreferences(request(bob), env, verify)).json(), { showWalks: false })
  assert.deepEqual([...env.values.keys()], ['walks:alice'])
  assert.equal((await handlePreferences(request(alice, 'PUT', { showWalks: true, userId: 'bob' }), env, verify)).status, 400)
  await handlePreferences(request(secondDevice, 'PUT', { showWalks: false }), env, verify)
  assert.deepEqual(await (await handlePreferences(request(alice), env, verify)).json(), { showWalks: false })
})

test('rejects missing, forged, expired, wrong-issuer and wrong-audience tokens', async () => {
  const otherPair = await generateKeyPair('RS256')
  const env = makeEnv()
  for (const token of [null, 'not-a-token', await tokenFor('alice', { expiration: 1 }),
    await tokenFor('alice', { issuer: 'https://attacker.test' }),
    await tokenFor('alice', { audience: '388904162139747950' }),
    await tokenFor('alice', { key: otherPair.privateKey })]) {
    assert.equal((await handlePreferences(request(token), env, verify)).status, 401)
  }
  assert.equal(env.values.size, 0)
})

test('strict origins, preflight, no-store and boolean-only payloads', async () => {
  const env = makeEnv(), token = await tokenFor()
  for (const disallowed of ['https://attacker.test', 'https://walks.ashterism.com.attacker.test', 'null', '']) {
    const result = await handlePreferences(request(token, 'PUT', { showWalks: true }, disallowed), env, verify)
    assert.equal(result.status, 403)
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), null)
  }
  const preflight = await handlePreferences(request(null, 'OPTIONS'), env, verify)
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin)
  assert.equal(preflight.headers.get('Cache-Control'), 'private, no-store')
  for (const body of [{ showWalks: 'true' }, {}, null, { sub: 'bob', showWalks: false }]) {
    assert.equal((await handlePreferences(request(token, 'PUT', body), env, verify)).status, 400)
  }
  assert.equal((await handlePreferences(request(token, 'POST', {}), env, verify)).status, 405)
  assert.equal((await handlePreferences(request(token), { WALKS_ORIGINS: origin }, verify)).status, 503)
})
