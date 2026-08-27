import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { Decoder, Stream } from '@garmin/fitsdk'

import {
  readJson,
  routeVersionPath,
  sha256,
  writeCanonicalRecord,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const argumentsList = process.argv.slice(2)
const apply = argumentsList.includes('--apply')
const valueFor = (flag) => {
  const index = argumentsList.indexOf(flag)
  return index >= 0 ? argumentsList[index + 1] : null
}
const id = argumentsList.find((argument) => !argument.startsWith('--'))
const endTime = valueFor('--end')
const reason = valueFor('--reason') ?? 'Removed non-walking travel after the activity'

if (!id || !endTime) {
  throw new Error(
    'Usage: node scripts/crop-fit-route.js <walk-id> --end <ISO timestamp> [--reason <text>] [--apply]',
  )
}

const cutoff = new Date(endTime).getTime()
if (!Number.isFinite(cutoff)) throw new Error(`Invalid crop timestamp: ${endTime}`)

const recordPath = path.join('data/walks', `${id}.json`)
if (!fs.existsSync(recordPath)) throw new Error(`Unknown walk: ${id}`)
const record = readJson(recordPath)

const archive = record.sources.strava?.archivedFilename
  ? {
      provider: 'Strava',
      path: path.join(
        'private/strava/activities',
        record.sources.strava.archivedFilename,
      ),
    }
  : record.sources.garmin?.archivedFilename
    ? {
        provider: 'Garmin',
        path: path.join(
          'private/garmin/activities',
          record.sources.garmin.archivedFilename,
        ),
      }
    : null

if (!archive || !fs.existsSync(archive.path)) {
  throw new Error(`No archived FIT source is available for ${id}`)
}

const compressed = archive.path.endsWith('.gz')
const sourceBuffer = fs.readFileSync(archive.path)
const fitBuffer = compressed ? zlib.gunzipSync(sourceBuffer) : sourceBuffer
const decoder = new Decoder(Stream.fromBuffer(fitBuffer))
if (!decoder.isFIT() || !decoder.checkIntegrity()) {
  throw new Error(`Archived source is not a valid FIT file: ${archive.path}`)
}

const { messages, errors } = decoder.read({
  convertTypesToStrings: true,
  convertDateTimesToDates: true,
})
if (errors.length > 0) throw new Error(errors.join('\n'))

const semicirclesToDegrees = (value) => (value * 180) / 2 ** 31
const points = (messages.recordMesgs ?? [])
  .filter(
    (recordMessage) =>
      Number.isFinite(recordMessage.positionLat) &&
      Number.isFinite(recordMessage.positionLong) &&
      new Date(recordMessage.timestamp).getTime() <= cutoff,
  )
  .map((recordMessage) => ({
    time: new Date(recordMessage.timestamp).getTime(),
    coordinate: [
      semicirclesToDegrees(recordMessage.positionLong),
      semicirclesToDegrees(recordMessage.positionLat),
      recordMessage.enhancedAltitude ?? recordMessage.altitude,
    ].filter(Number.isFinite),
    speed: recordMessage.enhancedSpeed ?? recordMessage.speed ?? 0,
  }))

if (points.length < 2) throw new Error('The crop would leave fewer than two route points')

const originalPointCount = (messages.recordMesgs ?? []).filter(
  (recordMessage) =>
    Number.isFinite(recordMessage.positionLat) &&
    Number.isFinite(recordMessage.positionLong),
).length
if (points.length === originalPointCount) {
  throw new Error('The crop timestamp does not remove any route points')
}

const radians = (degrees) => (degrees * Math.PI) / 180
const distanceBetween = (first, second) => {
  const latitude1 = radians(first[1])
  const latitude2 = radians(second[1])
  const latitudeDelta = latitude2 - latitude1
  const longitudeDelta = radians(second[0] - first[0])
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

let distanceM = 0
let movingTimeSeconds = 0
let ascentM = 0
let descentM = 0
for (let index = 1; index < points.length; index += 1) {
  const previous = points[index - 1]
  const current = points[index]
  distanceM += distanceBetween(previous.coordinate, current.coordinate)
  const intervalSeconds = (current.time - previous.time) / 1000
  if (intervalSeconds > 0 && intervalSeconds <= 5 && current.speed >= 0.3) {
    movingTimeSeconds += intervalSeconds
  }
  const altitudeChange = current.coordinate[2] - previous.coordinate[2]
  if (Number.isFinite(altitudeChange)) {
    if (altitudeChange > 0) ascentM += altitudeChange
    else descentM -= altitudeChange
  }
}

const coordinates = points.map((point) => point.coordinate)
const longitudes = coordinates.map((coordinate) => coordinate[0])
const latitudes = coordinates.map((coordinate) => coordinate[1])
const feature = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates },
}
const canonicalText = `${JSON.stringify(feature, null, 2)}\n`
const checksum = sha256(canonicalText)
const metrics = {
  distanceM: Math.round(distanceM),
  movingTimeSeconds: Math.round(movingTimeSeconds),
  elapsedTimeSeconds: Math.round((points.at(-1).time - points[0].time) / 1000),
  ascentM: Math.round(ascentM),
  descentM: Math.round(descentM),
}
const capturedAt = new Date().toISOString()
const versions = [...(record.route?.versions ?? [])]
if (!versions.some((version) => version.checksum === checksum)) {
  versions.push({ checksum, source: 'local-crop', capturedAt })
}

const updatedRecord = {
  ...record,
  local: {
    ...record.local,
    metrics,
    routeEdit: {
      type: 'crop',
      endTime: new Date(cutoff).toISOString(),
      reason,
    },
  },
  route: {
    ...record.route,
    activeVersion: checksum,
    source: 'local-crop',
    status: 'edited',
    versions,
    bounds: [
      Math.min(...longitudes),
      Math.min(...latitudes),
      Math.max(...longitudes),
      Math.max(...latitudes),
    ],
    start: coordinates[0].slice(0, 2),
    finish: coordinates.at(-1).slice(0, 2),
    ascentM: metrics.ascentM,
    descentM: metrics.descentM,
  },
  provenance: {
    status: 'edited',
    method: 'manual-crop',
    label: `${archive.provider} activity · cropped by Ashterism`,
  },
}

console.log(
  `${id}: ${originalPointCount} -> ${points.length} points | ${(metrics.distanceM / 1000).toFixed(2)} km | ${Math.round(metrics.movingTimeSeconds / 60)} min moving`,
)

if (!apply) {
  console.log('Dry run only; rerun with --apply to store and publish the crop')
} else {
  writeJsonIfChanged(routeVersionPath(id, checksum), feature)
  writeCanonicalRecord(updatedRecord)
  await import('./build-catalogue.js')
  console.log(`Stored original and cropped route versions for ${id}`)
}
