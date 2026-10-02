import assert from 'node:assert/strict'
import test from 'node:test'

import { addedWalkIds, isRecentWalk } from '../scripts/lib/new-walk-photo-worker.js'

test('detects only added canonical walk files', () => {
  assert.deepEqual(addedWalkIds('A\tdata/walks/intervals-123.json\nM\tdata/walks/intervals-456.json\n'), ['intervals-123'])
})

test('restricts automatic preparation to recent walks', () => {
  const now = Date.parse('2026-10-01T16:00:00Z')
  const walk = (startDate) => ({ id: 'intervals-123', sources: { intervals: { snapshot: {
    startDate, elapsedTimeSeconds: 3600,
  } } } })
  assert.equal(isRecentWalk(walk('2026-10-01T08:00:00Z'), now), true)
  assert.equal(isRecentWalk(walk('2026-09-01T08:00:00Z'), now), false)
})
