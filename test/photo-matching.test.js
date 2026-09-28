import assert from 'node:assert/strict'
import test from 'node:test'

import {
  capturedAtFromFilename,
  distanceToRoute,
  matchPhotoCandidates,
  routeCoordinatesFrom,
} from '../scripts/lib/photo-matching.js'

test('reads historical archive timestamps from filenames without sidecars', () => {
  const timestamp = capturedAtFromFilename('2014-08-10 11.38.12.jpg')
  const date = new Date(timestamp)
  assert.deepEqual(
    [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()],
    [2014, 8, 10, 11, 38, 12],
  )
})

test('extracts line coordinates from feature collections', () => {
  assert.deepEqual(
    routeCoordinatesFrom({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } }],
    }),
    [[1, 2], [3, 4]],
  )
})

test('reports zero distance for a point on the route', () => {
  assert.equal(distanceToRoute([12, 58], [[12, 58], [13, 59]]), 0)
})

test('keeps campsite photographs before the recorded walk when they are near the route', () => {
  const startTime = Date.parse('2022-04-17T12:00:00+02:00')
  const endTime = Date.parse('2022-04-17T16:00:00+02:00')
  const [candidate] = matchPhotoCandidates({
    photos: [{ id: 'camp', capturedAt: Date.parse('2022-04-17T08:30:00+02:00'), location: [12, 58] }],
    routeCoordinates: [[12, 58]],
    startTime,
    endTime,
  })
  assert.equal(candidate.id, 'camp')
  assert.equal(candidate.matchReason, 'Before walk and near route')
})

test('rejects photographs outside both the time window and route corridor', () => {
  const candidates = matchPhotoCandidates({
    photos: [{ id: 'other', capturedAt: Date.parse('2022-04-16T08:30:00+02:00'), location: [0, 0] }],
    routeCoordinates: [[12, 58]],
    startTime: Date.parse('2022-04-17T12:00:00+02:00'),
    endTime: Date.parse('2022-04-17T16:00:00+02:00'),
  })
  assert.deepEqual(candidates, [])
})
