import fs from 'node:fs'
import path from 'node:path'

import { Decoder, Stream } from '@garmin/fitsdk'

import {
  assertSafeWalkId,
  loadCanonicalRecords,
  providerStatusFor,
  preserveRouteAfterInvalidCandidate,
  readJson,
  routeVersionPath,
  sha256,
  withProviderStatus,
  writeCanonicalRecord,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const archiveDirectory = 'private/garmin/activities'
const manifestPath = 'private/garmin/manifest.json'
const candidateFilenamePattern =
  /^((?:\d+|intervals-\d+))_ACTIVITY\.fit$/i

const semicirclesToDegrees = (value) => value * (180 / 2 ** 31)

const round = (value, decimalPlaces = 2) => {
  if (!Number.isFinite(value)) return null
  const multiplier = 10 ** decimalPlaces
  return Math.round(value * multiplier) / multiplier
}

const calculateBounds = (coordinates) => {
  let minimumLongitude = Infinity
  let minimumLatitude = Infinity
  let maximumLongitude = -Infinity
  let maximumLatitude = -Infinity

  for (const [longitude, latitude] of coordinates) {
    minimumLongitude = Math.min(minimumLongitude, longitude)
    minimumLatitude = Math.min(minimumLatitude, latitude)
    maximumLongitude = Math.max(maximumLongitude, longitude)
    maximumLatitude = Math.max(maximumLatitude, latitude)
  }

  return [
    minimumLongitude,
    minimumLatitude,
    maximumLongitude,
    maximumLatitude,
  ]
}

const decodeRouteCandidate = (inputPath) => {
  const fitBuffer = fs.readFileSync(inputPath)
  const decoder = new Decoder(Stream.fromBuffer(fitBuffer))

  if (!decoder.isFIT()) throw new Error('Not a valid FIT file')
  if (!decoder.checkIntegrity()) {
    throw new Error('Failed its FIT integrity check')
  }

  const { messages, errors } = decoder.read({
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
  })

  if (errors.length > 0) throw new Error(errors.join('\n'))

  const session = messages.sessionMesgs?.[0]
  const records = messages.recordMesgs ?? []
  if (!session) throw new Error('No activity session was found')

  const coordinates = records
    .filter(
      (record) =>
        Number.isFinite(record.positionLat) &&
        Number.isFinite(record.positionLong),
    )
    .map((record) => {
      const coordinate = [
        semicirclesToDegrees(record.positionLong),
        semicirclesToDegrees(record.positionLat),
      ]

      if (Number.isFinite(record.enhancedAltitude)) {
        coordinate.push(record.enhancedAltitude)
      }

      return coordinate
    })

  if (coordinates.length < 2) return null

  return {
    feature: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    },
    bounds: calculateBounds(coordinates),
    start: coordinates[0].slice(0, 2),
    finish: coordinates.at(-1).slice(0, 2),
    descentM: round(session.totalDescent, 0),
  }
}

const candidatePathFor = (metadata) => {
  if (!metadata.candidateFilename) return null

  const match = String(metadata.candidateFilename).match(
    candidateFilenamePattern,
  )

  if (
    !match ||
    match[1] !== String(metadata.id) ||
    path.basename(metadata.candidateFilename) !== metadata.candidateFilename
  ) {
    throw new Error(
      `Unsafe candidate filename for activity ${metadata.id}`,
    )
  }

  const filePath = path.join(archiveDirectory, metadata.candidateFilename)
  if (!fs.existsSync(filePath)) {
    throw new Error(`FIT candidate is missing for activity ${metadata.id}`)
  }

  return filePath
}

const newRecordFor = (metadata) => ({
  schemaVersion: 1,
  id: assertSafeWalkId(metadata.id),
  local: {
    name: null,
    activityType: null,
    visibility: 'public',
  },
  sources: {
    garmin: /^\d+$/.test(String(metadata.id))
      ? { activityId: String(metadata.id) }
      : null,
    intervals: {
      activityId: String(metadata.intervalsActivityId),
      status: 'active',
      statusChangedAt: null,
      fingerprint: null,
      snapshot: {},
    },
  },
  route: null,
  review: [],
})

if (!fs.existsSync(manifestPath)) {
  throw new Error(`The private sync manifest does not exist: ${manifestPath}`)
}

const manifest = readJson(manifestPath)
const records = loadCanonicalRecords()
const recordsById = new Map(records.map((record) => [record.id, record]))
const recordsByIntervalsId = new Map(
  records.map((record) => [
    String(record.sources.intervals.activityId),
    record,
  ]),
)
const observedProviderIds = new Set(
  manifest.observedIntervalsActivityIds ?? [],
)
const eligibleProviderIds = new Set(
  manifest.activities.map((activity) =>
    String(activity.intervalsActivityId),
  ),
)

if (manifest.completeProviderSnapshot) {
  for (const existingRecord of records) {
    const providerActivityId = String(
      existingRecord.sources.intervals.activityId,
    )
    const status = providerStatusFor(
      providerActivityId,
      observedProviderIds,
      eligibleProviderIds,
    )
    const reconciled = withProviderStatus(
      existingRecord,
      status,
      manifest.generatedAt,
    )
    recordsById.set(reconciled.id, reconciled)
    recordsByIntervalsId.set(providerActivityId, reconciled)
  }
}

let convertedCount = 0
let preservedRouteCount = 0

for (const metadata of manifest.activities) {
  const providerActivityId = String(metadata.intervalsActivityId)
  let record =
    recordsByIntervalsId.get(providerActivityId) ??
    recordsById.get(String(metadata.id)) ??
    newRecordFor(metadata)
  const review = new Set(record.review ?? [])
  review.delete('source-missing')
  review.delete('source-no-longer-eligible')
  const candidatePath = candidatePathFor(metadata)
  let route = record.route

  if (candidatePath) {
    const candidate = decodeRouteCandidate(candidatePath)

    if (candidate) {
      const canonicalText = `${JSON.stringify(candidate.feature, null, 2)}\n`
      const checksum = sha256(canonicalText)
      writeJsonIfChanged(
        routeVersionPath(record.id, checksum),
        candidate.feature,
      )

      const versions = [...(route?.versions ?? [])]
      if (!versions.some((version) => version.checksum === checksum)) {
        versions.push({
          checksum,
          source: 'intervals',
          capturedAt: manifest.generatedAt,
        })
      }

      route = {
        activeVersion: checksum,
        source: 'intervals',
        status: 'current',
        versions,
        bounds: candidate.bounds,
        start: candidate.start,
        finish: candidate.finish,
        descentM: candidate.descentM,
      }
      review.delete('route-unavailable')
      review.delete('source-route-invalid')
      convertedCount += 1
    } else if (route?.activeVersion) {
      route = preserveRouteAfterInvalidCandidate(route)
      review.add('source-route-invalid')
      preservedRouteCount += 1
    } else {
      review.add('route-unavailable')
      review.add('source-route-invalid')
    }
  } else if (!route?.activeVersion) {
    review.add('route-unavailable')
  }

  const previousStatus = record.sources.intervals.status
  record = {
    ...record,
    sources: {
      ...record.sources,
      intervals: {
        ...record.sources.intervals,
        activityId: providerActivityId,
        status: 'active',
        statusChangedAt:
          previousStatus === 'active'
            ? record.sources.intervals.statusChangedAt
            : manifest.generatedAt,
        fingerprint: metadata.providerFingerprint ?? null,
        snapshot: {
          name: metadata.name ?? null,
          type: metadata.type,
          startDate: metadata.startDate,
          startDateLocal: metadata.startDateLocal ?? null,
          distanceM: metadata.distanceM ?? null,
          movingTimeSeconds: metadata.movingTimeSeconds ?? null,
          elapsedTimeSeconds: metadata.elapsedTimeSeconds ?? null,
          ascentM: metadata.ascentM ?? null,
          source: metadata.source ?? null,
        },
      },
    },
    route,
    review: [...review].sort(),
  }

  recordsById.set(record.id, record)
  recordsByIntervalsId.set(providerActivityId, record)
}

for (const record of [...recordsById.values()].sort((a, b) =>
  a.id.localeCompare(b.id),
)) {
  writeCanonicalRecord(record)
}

await import('./build-catalogue.js')

console.log(`New route versions accepted: ${convertedCount}`)
console.log(`Cached routes preserved after invalid updates: ${preservedRouteCount}`)
