import test from 'node:test'
import assert from 'node:assert/strict'

import { isPostRunWalk, preserveManualPostRun } from '../scripts/lib/post-run-matching.js'
import { isRecentWalk } from '../scripts/lib/new-walk-photo-worker.js'

const run = {
  id: 'run-1',
  type: 'Run',
  source: 'GARMIN_CONNECT',
  file_type: 'fit',
  start_date: '2026-10-14T10:00:00Z',
  elapsed_time: 1800,
}

const walkAt = (gapMinutes) => ({
  id: 'walk-1',
  type: 'Walk',
  source: 'GARMIN_CONNECT',
  file_type: 'fit',
  start_date: new Date(Date.parse(run.start_date) + 1800_000 + gapMinutes * 60_000).toISOString(),
  start_date_local: new Date(Date.parse(run.start_date) + 1800_000 + gapMinutes * 60_000).toISOString(),
})

test('matches Garmin walks starting 2 or exactly 5 minutes after a run', () => {
  assert.equal(isPostRunWalk(walkAt(2), [run]), true)
  assert.equal(isPostRunWalk(walkAt(5), [run]), true)
})

test('does not match a walk after 6 minutes or without a preceding Garmin run', () => {
  assert.equal(isPostRunWalk(walkAt(6), [run]), false)
  assert.equal(isPostRunWalk(walkAt(2), []), false)
})

test('only applies from 14 October 2026 and only to Garmin runs', () => {
  assert.equal(isPostRunWalk({ ...walkAt(2), start_date_local: '2026-10-13T12:32:00' }, [run]), false)
  assert.equal(isPostRunWalk(walkAt(2), [{ ...run, source: 'STRAVA' }]), false)
  assert.equal(isPostRunWalk(walkAt(2), [{ ...run, type: 'Hike' }]), false)
  assert.equal(isPostRunWalk({ ...walkAt(2), effectiveType: 'Hike' }, [run]), false)
})

test('post-run walks are excluded from automatic photo matching', () => {
  assert.equal(isRecentWalk({
    date: '2026-10-14',
    providers: ['Garmin'],
    postRun: true,
  }, Date.parse('2026-10-14T12:00:00Z')), false)
})

test('preserves explicit manual post-run values', () => {
  const manualTrue = { id: 'walk-1', local: { postRun: true } }
  const manualFalse = { id: 'walk-1', local: { postRun: false } }
  assert.equal(preserveManualPostRun(manualTrue, false), manualTrue)
  assert.equal(preserveManualPostRun(manualFalse, true), manualFalse)
  assert.deepEqual(preserveManualPostRun({ id: 'walk-1', local: {} }, true), {
    id: 'walk-1', local: { postRun: true },
  })
})
