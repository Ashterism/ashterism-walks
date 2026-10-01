import assert from 'node:assert/strict'
import test from 'node:test'

import { photoWindowFor } from '../scripts/lib/prepare-photo-candidates.js'

test('derives a new walk photo window from its recorded start and elapsed time', () => {
  assert.deepEqual(photoWindowFor({
    id: 'intervals-1',
    sources: { intervals: { snapshot: {
      startDate: '2026-10-01T08:00:00Z',
      startDateLocal: '2026-10-01T10:00:00',
      elapsedTimeSeconds: 5400,
    } } },
  }), {
    date: '2026-10-01',
    startDate: '2026-10-01T08:00:00Z',
    endDate: '2026-10-01T09:30:00.000Z',
  })
})

test('keeps an explicit historical archive window', () => {
  const snapshot = {
    date: '2014-08-10',
    startDate: '2014-08-10T10:01:21+01:00',
    endDate: '2014-08-10T19:05:41+01:00',
  }
  assert.equal(photoWindowFor({ sources: { photoArchive: { snapshot } } }), snapshot)
})
