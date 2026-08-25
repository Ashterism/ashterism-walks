import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Decoder, Stream } from '@garmin/fitsdk'

import {
  findCanonicalActivityMatch,
  loadCanonicalRecords,
  routeVersionPath,
  sha256,
  writeCanonicalRecord,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const apply = process.argv.includes('--apply')
const exportArgument = process.argv.slice(2).find((value) => !value.startsWith('--'))

if (!exportArgument) {
  throw new Error(
    'Usage: npm run import:garmin-export -- /path/to/DI_CONNECT [--apply]',
  )
}

const exportDirectory = fs.realpathSync(path.resolve(exportArgument))
const fitnessDirectory = path.join(exportDirectory, 'DI-Connect-Fitness')
const uploadedFilesDirectory = path.join(
  exportDirectory,
  'DI-Connect-Uploaded-Files',
)
const overrides = JSON.parse(
  fs.readFileSync('scripts/garmin-export-overrides.json', 'utf8'),
)
const archiveDirectory = 'private/garmin/activities'
const importedAt = new Date().toISOString()

const summaryFiles = fs
  .readdirSync(fitnessDirectory)
  .filter((filename) => filename.endsWith('_summarizedActivities.json'))
  .sort()

const activities = summaryFiles.flatMap((filename) =>
  JSON.parse(fs.readFileSync(path.join(fitnessDirectory, filename), 'utf8'))
    .flatMap((section) => section.summarizedActivitiesExport ?? []),
)
const activitiesById = new Map(
  activities.map((activity) => [String(activity.activityId), activity]),
)

const zipFiles = fs
  .readdirSync(uploadedFilesDirectory)
  .filter((filename) => filename.endsWith('.zip'))
  .sort()
  .map((filename) => path.join(uploadedFilesDirectory, filename))

const requestedTokens = new Set(
  Object.values(overrides)
    .map((override) => override.fitToken)
    .filter(Boolean),
)
const fitEntriesByToken = new Map()

for (const zipPath of zipFiles) {
  const entries = execFileSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).split(/\r?\n/)

  for (const entry of entries) {
    const match = entry.match(/_(\d+)\.fit$/i)
    if (!match || !requestedTokens.has(match[1])) continue
    if (fitEntriesByToken.has(match[1])) {
      throw new Error(`More than one FIT entry matched token ${match[1]}`)
    }
    fitEntriesByToken.set(match[1], { zipPath, entry })
  }
}

const semicirclesToDegrees = (value) => value * (180 / 2 ** 31)

const routeFromFit = (buffer) => {
  const decoder = new Decoder(Stream.fromBuffer(buffer))
  if (!decoder.isFIT() || !decoder.checkIntegrity()) {
    throw new Error('The selected Garmin export entry is not a valid FIT file')
  }

  const { messages, errors } = decoder.read({
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
  })
  if (errors.length > 0) throw new Error(errors.join('\n'))

  const session = messages.sessionMesgs?.[0]
  const coordinates = (messages.recordMesgs ?? [])
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
  const longitudes = coordinates.map((coordinate) => coordinate[0])
  const latitudes = coordinates.map((coordinate) => coordinate[1])

  return {
    feature: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    },
    bounds: [
      Math.min(...longitudes),
      Math.min(...latitudes),
      Math.max(...longitudes),
      Math.max(...latitudes),
    ],
    start: coordinates[0].slice(0, 2),
    finish: coordinates.at(-1).slice(0, 2),
    descentM: Number.isFinite(session?.totalDescent)
      ? Math.round(session.totalDescent)
      : null,
  }
}

const correctedName = (name, type) => {
  if (type !== 'Hike') return name
  return String(name).replace(/\s+(?:Other|Running)$/i, ' Hiking')
}

const archiveFit = (id, buffer) => {
  const filename = `${id}_ACTIVITY.fit`
  const destination = path.join(archiveDirectory, filename)
  if (
    fs.existsSync(destination) &&
    sha256(fs.readFileSync(destination)) === sha256(buffer)
  ) {
    return filename
  }
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(destination, buffer, { mode: 0o600 })
  return filename
}

const records = loadCanonicalRecords()
const recordsById = new Map(records.map((record) => [record.id, record]))
let linkedCount = 0
let createdCount = 0
let routeCount = 0

for (const [activityId, override] of Object.entries(overrides)) {
  const activity = activitiesById.get(activityId)
  if (!activity) throw new Error(`Garmin activity ${activityId} was not found`)

  const snapshot = {
    name: activity.name ?? null,
    type: override.type,
    startDate: new Date(activity.beginTimestamp).toISOString(),
    startDateLocal: activity.startTimeLocal
      ? new Date(activity.startTimeLocal).toISOString().replace(/Z$/, '')
      : null,
    distanceM: Number.isFinite(activity.distance)
      ? activity.distance / 100
      : null,
    movingTimeSeconds: Number.isFinite(activity.movingDuration)
      ? activity.movingDuration / 1000
      : Number.isFinite(activity.duration)
        ? activity.duration / 1000
        : null,
    elapsedTimeSeconds: Number.isFinite(activity.elapsedDuration)
      ? activity.elapsedDuration / 1000
      : Number.isFinite(activity.duration)
        ? activity.duration / 1000
        : null,
    ascentM: Number.isFinite(activity.elevationGain)
      ? activity.elevationGain / 100
      : null,
  }

  let record =
    [...recordsById.values()].find(
      (candidate) =>
        String(candidate.sources.garmin?.activityId) === activityId,
    ) ?? findCanonicalActivityMatch([...recordsById.values()], snapshot)

  const matchedExisting = Boolean(record)
  const id = record?.id ?? activityId
  let candidate = null
  let archivedFilename = record?.sources.garmin?.archivedFilename ?? null

  if (override.fitToken) {
    const located = fitEntriesByToken.get(String(override.fitToken))
    if (!located) {
      throw new Error(`FIT token ${override.fitToken} was not found in the export`)
    }
    const buffer = execFileSync(
      'unzip',
      ['-p', located.zipPath, located.entry],
      { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 },
    )
    candidate = routeFromFit(buffer)
    if (!candidate) throw new Error(`Garmin activity ${activityId} has no GPS route`)
    if (apply) archivedFilename = archiveFit(id, buffer)
  }

  if (!record) {
    record = {
      schemaVersion: 1,
      id,
      local: {
        name: correctedName(activity.name, override.type),
        activityType: override.type,
        visibility: 'public',
        photos: [],
      },
      sources: {},
      route: null,
      review: [],
    }
    createdCount += 1
  } else {
    linkedCount += 1
  }

  let route = record.route
  if (candidate) {
    const canonicalText = `${JSON.stringify(candidate.feature, null, 2)}\n`
    const checksum = sha256(canonicalText)
    if (apply) writeJsonIfChanged(routeVersionPath(id, checksum), candidate.feature)
    const versions = [...(route?.versions ?? [])]
    if (!versions.some((version) => version.checksum === checksum)) {
      versions.push({ checksum, source: 'garmin', capturedAt: importedAt })
    }
    if (!route?.activeVersion) {
      route = {
        activeVersion: checksum,
        source: 'garmin',
        status: 'archived',
        versions,
        bounds: candidate.bounds,
        start: candidate.start,
        finish: candidate.finish,
        descentM: candidate.descentM,
      }
    } else {
      route = { ...route, versions }
    }
    routeCount += 1
  }

  record = {
    ...record,
    local: {
      ...record.local,
      name:
        record.local.name ?? correctedName(activity.name, override.type),
      activityType: override.type,
    },
    sources: {
      ...record.sources,
      garmin: {
        activityId,
        status: 'archived',
        archivedFilename,
        snapshot,
      },
    },
    route,
  }

  recordsById.set(id, record)
  if (apply) writeCanonicalRecord(record)
}

if (apply) await import('./build-catalogue.js')

console.log(`Reviewed Garmin hikes: ${Object.keys(overrides).length}`)
console.log(`Linked to existing walks: ${linkedCount}`)
console.log(`New canonical walks: ${createdCount}`)
console.log(`Recovered Garmin routes: ${routeCount}`)
