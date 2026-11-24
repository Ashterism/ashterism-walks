import assert from 'node:assert/strict'
import test from 'node:test'

import scheduler, { dispatchSync, isDispatchHour } from '../src/index.js'

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
    schedule: 'hourly; dispatch 06:00–23:00 Europe/London',
  })
})

test('dispatch window uses scheduled London time across GMT and BST boundaries', () => {
  const cases = [
    ['2026-01-15T05:00:00Z', false],
    ['2026-01-15T06:00:00Z', true],
    ['2026-01-15T23:00:00Z', true],
    ['2026-01-16T00:00:00Z', false],
    ['2026-07-15T04:00:00Z', false],
    ['2026-07-15T05:00:00Z', true],
    ['2026-07-15T22:00:00Z', true],
    ['2026-07-15T23:00:00Z', false],
  ]
  for (const [time, expected] of cases) assert.equal(isDispatchHour(time), expected, time)
})

test('dispatch window follows London daylight-saving transitions', () => {
  assert.equal(isDispatchHour('2026-03-28T06:00:00Z'), true) // 06:00 GMT
  assert.equal(isDispatchHour('2026-03-29T05:00:00Z'), true) // 06:00 BST
  assert.equal(isDispatchHour('2026-10-24T05:00:00Z'), true) // 06:00 BST
  assert.equal(isDispatchHour('2026-10-25T06:00:00Z'), true) // 06:00 GMT
})

test('scheduled handler gates using scheduledTime rather than execution time', async () => {
  let calls = 0
  const env = { GITHUB_TOKEN: 'test-token' }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 204 }) }
  try {
    await scheduler.scheduled({ scheduledTime: Date.parse('2026-01-15T05:00:00Z') }, env)
    assert.equal(calls, 0)
    await scheduler.scheduled({ scheduledTime: Date.parse('2026-01-15T06:00:00Z') }, env)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
