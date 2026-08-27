import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTrainingContext } from '../scripts/lib/training-context.js'

test('builds concise activity, load and wellness coaching context', () => {
  const context = buildTrainingContext({
    oldest: '2026-08-14',
    newest: '2026-08-27',
    generatedAt: '2026-08-27T12:00:00.000Z',
    activities: [
      {
        id: 'i2',
        start_date: '2026-08-27T08:00:00Z',
        start_date_local: '2026-08-27T10:00:00',
        name: 'Morning Run',
        type: 'Run',
        source: 'GARMIN_CONNECT',
        icu_distance: 5100.4,
        moving_time: 1800,
        elapsed_time: 1900,
        total_elevation_gain: 45,
        icu_training_load: 42,
        icu_intensity: 79.2,
        average_heartrate: 145,
        max_heartrate: 171,
        icu_ctl: 31.4,
        icu_atl: 39.9,
      },
      {
        id: 'i1',
        start_date: '2026-08-26T08:00:00Z',
        type: 'WeightTraining',
        moving_time: 2400,
        kg_lifted: 3150,
        icu_training_load: 20,
      },
    ],
    wellness: [
      { id: '2026-08-26', ctl: 30, atl: 35, ctlLoad: 20, atlLoad: 20 },
      {
        id: '2026-08-27',
        ctl: 31.4,
        atl: 39.9,
        rampRate: 3.2,
        ctlLoad: 42,
        atlLoad: 42,
        restingHR: 52,
        hrv: 47.5,
        sleepSecs: 27000,
        readiness: 68,
      },
    ],
  })

  assert.deepEqual(context.period, {
    oldest: '2026-08-14',
    newest: '2026-08-27',
  })
  assert.deepEqual(context.summary, {
    activityCount: 2,
    totalDistanceM: 5100.4,
    totalMovingTimeSeconds: 4200,
    totalTrainingLoad: 62,
    activitiesByType: { Run: 1, WeightTraining: 1 },
  })
  assert.equal(context.activities[0].formAfter, -8.5)
  assert.equal(context.activities[1].weightLiftedKg, 3150)
  assert.deepEqual(context.load.current, {
    date: '2026-08-27',
    fitness: 31.4,
    fatigue: 39.9,
    form: -8.5,
    rampRate: 3.2,
    fitnessLoad: 42,
    fatigueLoad: 42,
  })
  assert.deepEqual(context.wellness.availableMetrics, [
    'restingHeartRateBpm',
    'hrvRmssdMs',
    'sleepSeconds',
    'readiness',
  ])
  assert.deepEqual(context.wellness.days[0], {
    date: '2026-08-27',
    restingHeartRateBpm: 52,
    hrvRmssdMs: 47.5,
    sleepSeconds: 27000,
    readiness: 68,
  })
})

test('rejects unexpected API responses', () => {
  assert.throws(
    () =>
      buildTrainingContext({
        activities: {},
        wellness: [],
        oldest: '2026-08-14',
        newest: '2026-08-27',
      }),
    /unexpected training response/,
  )
})
