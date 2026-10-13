import assert from 'node:assert/strict'
import test from 'node:test'
import { createWalkPreferences } from '../src/walk-preferences.js'
import { activityLabel, isWalkVisible } from '../src/walk-visibility.js'

const hike = { activity: 'hiking', providers: ['Garmin'] }
const walk = { activity: 'walking', providers: ['Garmin'] }
const historical = { activity: 'walking', providers: ['Strava'] }

test('visibility preserves hikes and historical records, toggling Garmin and post-run walks', () => {
  const records = [hike, walk, historical, { ...walk, postRun: true }, { activity: 'walking', providers: ['Withings'] }]
  assert.deepEqual(records.filter((entry) => isWalkVisible(entry)), [records[0], records[2], records[4]])
  assert.deepEqual(records.filter((entry) => isWalkVisible(entry, true)), records)
  assert.equal(isWalkVisible({ ...historical, postRun: true }), false)
  assert.equal(activityLabel({ ...walk, postRun: true }), 'WALKING · POST-RUN')
  assert.equal(activityLabel(walk), 'Walking')
  assert.equal(activityLabel(hike), 'Hiking')
})

test('toggle updates immediately, persists across new clients, and sign-out resets the view', async () => {
  const saved = new Map(), changes = []
  let token = 'alice'
  let release
  const makeClient = () => createWalkPreferences({ getAccessToken: () => token, onChange: (state) => changes.push(state), fetchImpl: async (url, options) => {
    const subject = options.headers.Authorization
    if (options.method === 'PUT') {
      await new Promise((resolve) => { release = resolve })
      saved.set(subject, JSON.parse(options.body).showWalks)
    }
    return Response.json({ showWalks: saved.get(subject) ?? false })
  } })
  const client = makeClient()
  await client.load()
  const saving = client.set(true)
  assert.equal(client.getShowWalks(), true)
  assert.equal(changes.at(-1).busy, true)
  release(); await saving
  token = null; client.reset()
  assert.equal(client.getShowWalks(), false)
  token = 'alice'; await client.load()
  assert.equal(client.getShowWalks(), true)
  const secondDevice = makeClient(); await secondDevice.load()
  assert.equal(secondDevice.getShowWalks(), true)
  const disabling = secondDevice.set(false)
  assert.equal(secondDevice.getShowWalks(), false)
  release(); await disabling
  await client.load(); assert.equal(client.getShowWalks(), false)
})

test('failed saves roll back and stale loads cannot reveal a signed-out user preference', async () => {
  let release
  const errors = []
  const client = createWalkPreferences({ getAccessToken: () => 'alice', onChange: (state) => errors.push(state), fetchImpl: async (url, options) => {
    if (options.method === 'PUT') return new Response(null, { status: 503 })
    await new Promise((resolve) => { release = resolve })
    return Response.json({ showWalks: true })
  } })
  const loading = client.load(); client.reset(); release(); await loading
  assert.equal(client.getShowWalks(), false)
  await client.set(true)
  assert.equal(client.getShowWalks(), false)
  assert.match(errors.at(-1).error, /Could not save/)
})
