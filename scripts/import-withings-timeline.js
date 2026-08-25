import fs from 'node:fs'
import path from 'node:path'

import {
  assertSafeWalkId,
  findCanonicalActivityMatch,
  loadCanonicalRecords,
  readJson,
  routeVersionPath,
  sha256,
  writeCanonicalRecord,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const apply = process.argv.includes('--apply')
const inputs = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))

if (inputs.length !== 2) {
  throw new Error(
    'Usage: npm run import:withings-timeline -- /path/to/withings-export /path/to/location-history.json [--apply]',
  )
}

const withingsDirectory = fs.realpathSync(path.resolve(inputs[0]))
const timelinePath = fs.realpathSync(path.resolve(inputs[1]))
const activitiesPath = path.join(withingsDirectory, 'activities.csv')
const configuration = readJson('scripts/withings-timeline-walks.json')
const provenanceLabel =
  'Estimated route compiled from Withings activity data and Google Timeline.'

if (!fs.existsSync(activitiesPath)) {
  throw new Error('The Withings export does not contain activities.csv')
}
if (!fs.statSync(timelinePath).isFile()) {
  throw new Error('The Google Timeline input is not a file')
}

const parseCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }

  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows
}

const csvRows = parseCsv(
  fs.readFileSync(activitiesPath, 'utf8').replace(/^\uFEFF/, ''),
)
const headers = csvRows.shift()
const column = (name) => {
  const index = headers.indexOf(name)
  if (index < 0) throw new Error(`Withings column is missing: ${name}`)
  return index
}
const columns = {
  from: column('from'),
  to: column('to'),
  timezone: column('Timezone'),
  type: column('Activity type'),
  data: column('Data'),
}

const withingsRows = csvRows.map((row) => ({
  from: row[columns.from],
  to: row[columns.to],
  timezone: row[columns.timezone],
  type: row[columns.type],
  data: JSON.parse(row[columns.data]),
}))
const withingsRowsByWindow = new Map(
  withingsRows.map((row) => [`${row.from}|${row.to}`, row]),
)

const parseGeoPoint = (value) => {
  const match = String(value ?? '').match(/^geo:([-\d.]+),([-\d.]+)$/)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? [longitude, latitude]
    : null
}

const timeline = readJson(timelinePath)
if (!Array.isArray(timeline)) {
  throw new Error('Google Timeline must contain a top-level array')
}

const timelinePoints = timeline
  .flatMap((entry) =>
    (entry.timelinePath ?? []).flatMap((point) => {
      const coordinate = parseGeoPoint(point.point)
      const offsetMinutes = Number(point.durationMinutesOffsetFromStartTime)
      const startTime = new Date(entry.startTime).getTime()
      if (!coordinate || !Number.isFinite(offsetMinutes) || !Number.isFinite(startTime)) {
        return []
      }
      return [{
        time: startTime + offsetMinutes * 60_000,
        coordinate,
      }]
    }),
  )
  .sort((first, second) => first.time - second.time)

const distanceBetween = (first, second) => {
  const radians = (degrees) => (degrees * Math.PI) / 180
  const latitude1 = radians(first[1])
  const latitude2 = radians(second[1])
  const latitudeDelta = latitude2 - latitude1
  const longitudeDelta = radians(second[0] - first[0])
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(1 - haversine),
  )
}

const routeCandidate = (startTime, endTime, expectedDistanceM) => {
  const tolerance = 5 * 60_000
  const selected = timelinePoints.filter(
    (point) =>
      point.time >= startTime - tolerance && point.time <= endTime + tolerance,
  )
  const unique = selected.filter(
    (point, index) =>
      index === 0 ||
      point.time !== selected[index - 1].time ||
      point.coordinate.join(',') !== selected[index - 1].coordinate.join(','),
  )
  const coordinates = unique
    .map((point) => point.coordinate)
    .filter(
      (coordinate, index, all) =>
        index === 0 || coordinate.join(',') !== all[index - 1].join(','),
    )

  if (coordinates.length < 8) {
    throw new Error(`Only ${coordinates.length} Timeline points matched the walk`)
  }

  let lineDistanceM = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    lineDistanceM += distanceBetween(coordinates[index - 1], coordinates[index])
  }
  const distanceRatio = lineDistanceM / expectedDistanceM
  if (distanceRatio < 0.5 || distanceRatio > 1.4) {
    throw new Error(
      `Timeline geometry distance ratio ${distanceRatio.toFixed(2)} is outside the safe range`,
    )
  }

  const longitudes = coordinates.map((coordinate) => coordinate[0])
  const latitudes = coordinates.map((coordinate) => coordinate[1])
  return {
    feature: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    },
    pointCount: coordinates.length,
    lineDistanceM: Math.round(lineDistanceM),
    bounds: [
      Math.min(...longitudes),
      Math.min(...latitudes),
      Math.max(...longitudes),
      Math.max(...latitudes),
    ],
    start: coordinates[0],
    finish: coordinates.at(-1),
  }
}

const numberOrNull = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
const sumAvailable = (rows, key) => {
  const values = rows
    .map((row) => numberOrNull(row.data[key]))
    .filter((value) => value != null)
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null
}

const records = loadCanonicalRecords()
const recordIndex = new Map(records.map((record) => [record.id, record]))
const recordsByWithingsId = new Map(
  records.flatMap((record) =>
    (record.sources.withings?.activityIds ?? []).map((activityId) => [
      String(activityId),
      record,
    ]),
  ),
)
const importedAt = new Date().toISOString()
const manifestWalks = []
let createdCount = 0
let linkedCount = 0

for (const configuredWalk of configuration.walks) {
  assertSafeWalkId(configuredWalk.id)
  const components = configuredWalk.components.map((component) => {
    const row = withingsRowsByWindow.get(`${component.from}|${component.to}`)
    if (!row) {
      throw new Error(
        `Withings activity ${component.activityId} was not found at its configured time`,
      )
    }
    if (row.type !== 'Walking') {
      throw new Error(`Withings activity ${component.activityId} is not Walking`)
    }
    return { ...component, row }
  })
  const activityIds = components.map(({ activityId }) => String(activityId))
  const existingMatches = new Set(
    activityIds.map((id) => recordsByWithingsId.get(id)).filter(Boolean),
  )
  if (existingMatches.size > 1) {
    throw new Error(`Withings components for ${configuredWalk.id} match multiple walks`)
  }

  const startTime = Math.min(
    ...components.map(({ row }) => new Date(row.from).getTime()),
  )
  const endTime = Math.max(
    ...components.map(({ row }) => new Date(row.to).getTime()),
  )
  const componentRows = components.map(({ row }) => row)
  const distanceM = sumAvailable(componentRows, 'distance')
  const movingTimeSeconds = sumAvailable(componentRows, 'effduration')
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || !distanceM) {
    throw new Error(`Withings metrics are incomplete for ${configuredWalk.id}`)
  }

  const candidate = routeCandidate(startTime, endTime, distanceM)
  const snapshot = {
    name: configuredWalk.name,
    type: configuredWalk.activityType,
    startDate: new Date(startTime).toISOString(),
    startDateLocal: components[0].row.from,
    distanceM,
    movingTimeSeconds,
    elapsedTimeSeconds: Math.round((endTime - startTime) / 1000),
    ascentM: sumAvailable(componentRows, 'elevation'),
    componentCount: components.length,
  }
  let record =
    [...existingMatches][0] ??
    findCanonicalActivityMatch([...recordIndex.values()], snapshot)
  const matchedExisting = Boolean(record)
  const id = record?.id ?? configuredWalk.id
  assertSafeWalkId(id)

  if (!record) {
    record = {
      schemaVersion: 1,
      id,
      local: {
        name: configuredWalk.name,
        activityType: configuredWalk.activityType,
        visibility: 'public',
        photos: [],
      },
      sources: {},
      route: null,
      review: [],
    }
    createdCount += 1
  } else if (!record.sources.withings) {
    linkedCount += 1
  }

  const withingsSource = {
    activityIds,
    status: 'archived',
    archivedFilename: 'activities.csv',
    snapshot,
    components: components.map(({ activityId, row }) => ({
      activityId: String(activityId),
      from: row.from,
      to: row.to,
      distanceM: numberOrNull(row.data.distance),
      movingTimeSeconds: numberOrNull(row.data.effduration),
    })),
  }
  const googleTimelineSource = {
    status: 'archived',
    archivedFilename: 'location-history.json',
    snapshot: {
      startDate: new Date(startTime).toISOString(),
      endDate: new Date(endTime).toISOString(),
      pointCount: candidate.pointCount,
      lineDistanceM: candidate.lineDistanceM,
    },
  }

  const canonicalText = `${JSON.stringify(candidate.feature, null, 2)}\n`
  const checksum = sha256(canonicalText)
  if (apply) {
    writeJsonIfChanged(routeVersionPath(id, checksum), candidate.feature)
  }
  const versions = [...(record.route?.versions ?? [])]
  if (!versions.some((version) => version.checksum === checksum)) {
    versions.push({
      checksum,
      source: 'google-timeline',
      capturedAt: importedAt,
    })
  }

  const useCompiledRoute =
    !record.route?.activeVersion || record.route.source === 'google-timeline'
  const route = useCompiledRoute
    ? {
        activeVersion: checksum,
        source: 'google-timeline',
        status: 'estimated',
        versions,
        bounds: candidate.bounds,
        start: candidate.start,
        finish: candidate.finish,
        descentM: null,
      }
    : { ...record.route, versions }
  const review = new Set(record.review ?? [])
  review.delete('route-unavailable')

  record = {
    ...record,
    local: {
      ...record.local,
      name: record.local.name ?? configuredWalk.name,
      activityType: record.local.activityType ?? configuredWalk.activityType,
    },
    sources: {
      ...record.sources,
      withings: withingsSource,
      googleTimeline: googleTimelineSource,
    },
    route,
    provenance: {
      status: 'estimated',
      method: 'withings-google-timeline',
      metricsSource: 'Withings',
      routeSource: 'Google Timeline',
      label: provenanceLabel,
    },
    review: [...review].sort(),
  }
  recordIndex.set(id, record)
  for (const activityId of activityIds) recordsByWithingsId.set(activityId, record)
  if (apply) writeCanonicalRecord(record)

  manifestWalks.push({
    id,
    activityIds,
    matchedExisting,
    pointCount: candidate.pointCount,
    withingsDistanceM: Math.round(distanceM),
    routeLineDistanceM: candidate.lineDistanceM,
  })
}

const archiveFile = (source, destination) => {
  const sourceBuffer = fs.readFileSync(source)
  if (
    fs.existsSync(destination) &&
    sha256(fs.readFileSync(destination)) === sha256(sourceBuffer)
  ) {
    return false
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.copyFileSync(source, destination)
  fs.chmodSync(destination, 0o600)
  return true
}

if (apply) {
  archiveFile(activitiesPath, 'private/withings/activities.csv')
  archiveFile(timelinePath, 'private/google-timeline/location-history.json')
  writeJsonIfChanged('private/withings-timeline-manifest.json', {
    schemaVersion: 1,
    importedAt,
    source: 'Withings account export and Google Timeline export',
    walks: manifestWalks,
  })
  await import('./build-catalogue.js')
}

for (const walk of manifestWalks) {
  console.log(
    `${walk.matchedExisting ? 'link' : 'new '} ${walk.id} | ${walk.pointCount} points | ${(walk.withingsDistanceM / 1000).toFixed(2)} km Withings | ${(walk.routeLineDistanceM / 1000).toFixed(2)} km route`,
  )
}
console.log(`Compiled Portugal walks: ${manifestWalks.length}`)
console.log(`Linked to existing walks: ${linkedCount}`)
console.log(`New canonical walks: ${createdCount}`)
if (!apply) console.log('Dry run only; rerun with --apply to write the import')
