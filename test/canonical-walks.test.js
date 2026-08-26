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

test('Garmin-only records resolve through the same public model', () => {
  const record = {
    schemaVersion: 1,
    id: '123',
    local: {
      name: 'Epping Forest Hiking',
      activityType: 'Hike',
      visibility: 'public',
      photos: [],
    },
    sources: {
      garmin: {
        activityId: '123',
        snapshot: {
          name: 'Epping Forest Other',
          type: 'Hike',
          startDate: '2019-11-16T10:29:37.000Z',
          distanceM: 6344.89,
          movingTimeSeconds: 7356.97,
          elapsedTimeSeconds: 7356.97,
          ascentM: 90,
        },
      },
    },
    route: { descentM: 92 },
    review: [],
  }

  assert.deepEqual(resolvePublicFields(record), {
    id: '123',
    activity: 'hiking',
    name: 'Epping Forest Hiking',
    date: '2019-11-16T10:29:37.000Z',
    distanceKm: 6.34,
    movingTimeSeconds: 7356.97,
    elapsedTimeSeconds: 7356.97,
    ascentM: 90,
    descentM: 92,
    providers: ['Garmin'],
  })
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

test('compiled records expose their sources and estimated-route provenance', () => {
  const compiled = {
    ...record,
    id: 'withings-4213159220',
    sources: {
      withings: { snapshot: record.sources.intervals.snapshot },
      googleTimeline: { snapshot: { pointCount: 16 } },
    },
    provenance: {
      status: 'estimated',
      method: 'withings-google-timeline',
      label: 'Estimated route compiled from Withings activity data and Google Timeline.',
    },
  }

  const publicWalk = resolvePublicFields(compiled)
  assert.deepEqual(publicWalk.providers, ['Withings', 'Google Timeline'])
  assert.equal(publicWalk.provenance.status, 'estimated')
})

test('Ashterism-owned notes and references are published when present', () => {
  const noted = {
    ...record,
    local: {
      ...record.local,
      notes: 'Walked with a friend.',
      references: [{ label: 'Trail information', url: 'https://example.com/trail' }],
    },
  }

  const publicWalk = resolvePublicFields(noted)
  assert.equal(publicWalk.notes, 'Walked with a friend.')
  assert.deepEqual(publicWalk.references, [
    { label: 'Trail information', url: 'https://example.com/trail' },
  ])
})

test('official route metadata can supply estimated elevation and attribution', () => {
  const refined = {
    ...record,
    sources: {
      ...record.sources,
      intervals: {
        ...record.sources.intervals,
        snapshot: { ...record.sources.intervals.snapshot, ascentM: null },
      },
      rotaVicentina: { routeId: '801765498' },
    },
    route: { ...record.route, ascentM: 417, descentM: 416 },
  }

  const publicWalk = resolvePublicFields(refined)
  assert.equal(publicWalk.ascentM, 417)
  assert.equal(publicWalk.descentM, 416)
  assert.ok(publicWalk.providers.includes('Rota Vicentina'))
})
