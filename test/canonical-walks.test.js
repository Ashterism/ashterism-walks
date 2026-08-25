import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
