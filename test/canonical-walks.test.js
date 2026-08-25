import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findCanonicalActivityMatch,
  preserveRouteAfterInvalidCandidate,
  providerStatusFor,
  resolvePublicFields,
  withProviderStatus,
} from '../scripts/lib/canonical-walks.js'

const record = {
  id: '123',
  local: { name: 'Our name', activityType: null, visibility: 'public' },
  sources: {
    intervals: {
      activityId: 'i123',
      status: 'active',
      statusChangedAt: null,
      snapshot: {
        name: 'Their name',
        type: 'Hike',
        startDate: '2026-01-01T10:00:00Z',
        distanceM: 1234,
        movingTimeSeconds: 900,
        elapsedTimeSeconds: 1000,
        ascentM: 82.4,
      },
    },
  },
  route: {
    activeVersion: 'abc',
    status: 'current',
    descentM: 75,
  },
  review: [],
}

test('local names win while provider measurements remain authoritative', () => {
  const publicWalk = resolvePublicFields(record)
  assert.equal(publicWalk.name, 'Our name')
  assert.equal(publicWalk.activity, 'hiking')
  assert.equal(publicWalk.distanceKm, 1.23)
  assert.equal(publicWalk.ascentM, 82)
  assert.deepEqual(publicWalk.providers, [])
})

test('missing provider records are retained and flagged for review', () => {
  const missing = withProviderStatus(record, 'missing', '2026-01-02T00:00:00Z')
  assert.equal(missing.sources.intervals.status, 'missing')
  assert.equal(missing.route.activeVersion, 'abc')
  assert.deepEqual(missing.review, ['source-missing'])
})

test('provider status distinguishes missing from newly ineligible', () => {
  assert.equal(providerStatusFor('i1', new Set(), new Set()), 'missing')
  assert.equal(
    providerStatusFor('i1', new Set(['i1']), new Set()),
    'ineligible',
  )
  assert.equal(
    providerStatusFor('i1', new Set(['i1']), new Set(['i1'])),
    'active',
  )
})

test('an invalid provider route never replaces the last valid route', () => {
  const preserved = preserveRouteAfterInvalidCandidate(record.route)
  assert.equal(preserved.activeVersion, 'abc')
  assert.equal(preserved.status, 'cached-after-invalid-source')
  assert.equal(preserveRouteAfterInvalidCandidate(null), null)
})

test('Strava-only records resolve through the same public model', () => {
  const stravaRecord = {
    ...record,
    id: 'strava-456',
    local: { ...record.local, name: null },
    sources: {
      strava: {
        activityId: '456',
        snapshot: {
          name: 'Peddars Way Pt.1',
          type: 'Hike',
          startDate: '2018-01-04T09:13:31Z',
          distanceM: 26920,
          movingTimeSeconds: 18333,
          elapsedTimeSeconds: 19000,
          ascentM: 171.8,
        },
      },
    },
  }

  const publicWalk = resolvePublicFields(stravaRecord)
  assert.equal(publicWalk.name, 'Peddars Way Pt.1')
  assert.equal(publicWalk.activity, 'hiking')
  assert.equal(publicWalk.distanceKm, 26.92)
  assert.deepEqual(publicWalk.providers, ['Strava'])
})

test('provider records match one canonical activity without creating a duplicate', () => {
  assert.equal(
    findCanonicalActivityMatch([record], {
      startDate: '2026-01-01T10:00:02Z',
      distanceM: 1240,
    }),
    record,
  )
  assert.equal(
    findCanonicalActivityMatch([record], {
      startDate: '2026-01-02T10:00:00Z',
      distanceM: 1234,
    }),
    null,
  )
})
