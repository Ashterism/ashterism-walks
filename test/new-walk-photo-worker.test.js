import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addedWalkIds,
  isRecentWalk,
  PHOTO_RETRY_WINDOW_MS,
  prunePhotoRetries,
  queuePhotoRetry,
} from '../scripts/lib/new-walk-photo-worker.js'

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

test('keeps processed walks queued for 48 hours, then clears expired retry state', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  const state = { pendingWalkIds: [] }

  queuePhotoRetry(state, '24755894108', now)
  assert.deepEqual(state.pendingWalkIds, ['24755894108'])
  assert.equal(
    state.retryUntilByWalkId['24755894108'],
    now + PHOTO_RETRY_WINDOW_MS,
  )

  const restoredAfterRestart = JSON.parse(JSON.stringify(state))
  prunePhotoRetries(restoredAfterRestart, now + PHOTO_RETRY_WINDOW_MS - 1)
  assert.deepEqual(restoredAfterRestart.pendingWalkIds, ['24755894108'])

  prunePhotoRetries(state, now + PHOTO_RETRY_WINDOW_MS)
  assert.deepEqual(state.pendingWalkIds, [])
  assert.deepEqual(state.retryUntilByWalkId, {})
})

test('migrates previously pending walks into a bounded retry window', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  const state = { pendingWalkIds: ['walk-1'] }
  prunePhotoRetries(state, now)
  assert.equal(state.retryUntilByWalkId['walk-1'], now + PHOTO_RETRY_WINDOW_MS)
})
