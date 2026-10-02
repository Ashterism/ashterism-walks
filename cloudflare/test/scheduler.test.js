import assert from 'node:assert/strict'
import test from 'node:test'

import scheduler, { dispatchSync } from '../src/index.js'

test('dispatchSync starts the existing GitHub workflow on main', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url, options }
    return new Response(null, { status: 204 })
  }

  await dispatchSync('test-token', fetchImpl)

  assert.equal(
    request.url,
    'https://api.github.com/repos/Ashterism/ashterism-walks/actions/workflows/site.yml/dispatches',
  )
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers.Authorization, 'Bearer test-token')
  assert.deepEqual(JSON.parse(request.options.body), { ref: 'main' })
})

test('dispatchSync reports a rejected GitHub request', async () => {
  const fetchImpl = async () =>
    new Response('permission denied', { status: 403 })

  await assert.rejects(
    dispatchSync('test-token', fetchImpl),
    /HTTP 403: permission denied/,
  )
})

test('health endpoint describes the scheduler without exposing secrets', async () => {
  const response = await scheduler.fetch()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    service: 'ashterism-walks-sync',
    status: 'ok',
    schedule: 'every 15 minutes',
  })
})
