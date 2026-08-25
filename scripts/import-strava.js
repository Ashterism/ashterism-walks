import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { Decoder, Stream } from '@garmin/fitsdk'

import {
  findCanonicalActivityMatch,
  loadCanonicalRecords,
  readJson,
  routeVersionPath,
  sha256,
  writeCanonicalRecord,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const apply = process.argv.includes('--apply')
const verbose = process.argv.includes('--verbose')
const exportArgument = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith('--'))

if (!exportArgument) {
  throw new Error(
    'Usage: npm run import:strava -- /path/to/strava-export [--apply]',
  )
}

const exportDirectory = fs.realpathSync(path.resolve(exportArgument))
const cataloguePath = path.join(exportDirectory, 'activities.csv')
const privateActivitiesDirectory = 'private/strava/activities'
const privateMediaDirectory = 'private/strava/media'
const privateManifestPath = 'private/strava/manifest.json'
const overridesPath = 'scripts/strava-activity-overrides.json'
const allowedTypes = new Set(['Walk', 'Hike'])
const activityOverrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))

if (!fs.existsSync(cataloguePath)) {
  throw new Error('The Strava export does not contain activities.csv')
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
  fs.readFileSync(cataloguePath, 'utf8').replace(/^\uFEFF/, ''),
)
const headers = csvRows.shift()
const column = (name) => {
  const index = headers.indexOf(name)
  if (index < 0) throw new Error(`Strava column is missing: ${name}`)
  return index
}

const columns = {
  id: column('Activity ID'),
  date: column('Activity Date'),
  name: column('Activity Name'),
  type: column('Activity Type'),
  elapsed: column('Elapsed Time'),
  distanceKm: column('Distance'),
  filename: column('Filename'),
  moving: column('Moving Time'),
  ascentM: column('Elevation Gain'),
  descentM: column('Elevation Loss'),
  averageHeartRate: column('Average Heart Rate'),
  calories: column('Calories'),
  weatherCondition: column('Weather Condition'),
  weatherTemperature: column('Weather Temperature'),
  apparentTemperature: column('Apparent Temperature'),
  humidity: column('Humidity'),
  windSpeed: column('Wind Speed'),
  windGust: column('Wind Gust'),
  windBearing: column('Wind Bearing'),
  precipitationIntensity: column('Precipitation Intensity'),
  precipitationProbability: column('Precipitation Probability'),
  precipitationType: column('Precipitation Type'),
  cloudCover: column('Cloud Cover'),
  media: column('Media'),
}

const numberOrNull = (value) => {
  if (String(value).trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const parseStravaDate = (value) => {
  const match = String(value).match(
    /^(\w{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/,
  )
  if (!match) throw new Error(`Unexpected Strava activity date: ${value}`)

  const months = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  }
  let hour = Number(match[4]) % 12
  if (match[7] === 'PM') hour += 12

  return new Date(
    Date.UTC(
      Number(match[3]),
      months[match[1]],
      Number(match[2]),
      hour,
      Number(match[5]),
      Number(match[6]),
    ),
  ).toISOString()
}

const semicirclesToDegrees = (value) => value * (180 / 2 ** 31)

const calculateBounds = (coordinates) => {
  const longitudes = coordinates.map((coordinate) => coordinate[0])
  const latitudes = coordinates.map((coordinate) => coordinate[1])
  return [
    Math.min(...longitudes),
    Math.min(...latitudes),
    Math.max(...longitudes),
    Math.max(...latitudes),
  ]
}

const calculatedDescent = (coordinates) => {
  let descent = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1][2]
    const current = coordinates[index][2]
    if (Number.isFinite(previous) && Number.isFinite(current) && current < previous) {
      descent += previous - current
    }
  }
  return Math.round(descent)
}

const routeCandidate = (coordinates, descentM = null) => {
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
    descentM:
      Number.isFinite(descentM) ? Math.round(descentM) : calculatedDescent(coordinates),
  }
}

const decodeFit = (buffer) => {
  const decoder = new Decoder(Stream.fromBuffer(buffer))
  if (!decoder.isFIT() || !decoder.checkIntegrity()) return null

  const { messages, errors } = decoder.read({
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
  })
  if (errors.length > 0) throw new Error(errors.join('\n'))

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

  return routeCandidate(coordinates, messages.sessionMesgs?.[0]?.totalDescent)
}

const decodeGpx = (text) => {
  const coordinates = []
  const points = text.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi)

  for (const point of points) {
    const latitude = Number(point[1].match(/\blat=["']([^"']+)/i)?.[1])
    const longitude = Number(point[1].match(/\blon=["']([^"']+)/i)?.[1])
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue
    const coordinate = [longitude, latitude]
    const altitude = Number(point[2].match(/<ele>([^<]+)<\/ele>/i)?.[1])
    if (Number.isFinite(altitude)) coordinate.push(altitude)
    coordinates.push(coordinate)
  }

  return routeCandidate(coordinates)
}

const decodeActivityFile = (filePath) => {
  const compressed = filePath.endsWith('.gz')
  const buffer = compressed
    ? zlib.gunzipSync(fs.readFileSync(filePath))
    : fs.readFileSync(filePath)
  const uncompressedName = compressed ? filePath.slice(0, -3) : filePath

  if (uncompressedName.endsWith('.fit')) return decodeFit(buffer)
  if (uncompressedName.endsWith('.gpx')) return decodeGpx(buffer.toString('utf8'))
  throw new Error(`Unsupported Strava activity file: ${path.basename(filePath)}`)
}

const safeExportFile = (relativePath) => {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Strava supplied an unsafe or empty file path')
  }
  const filePath = fs.realpathSync(path.join(exportDirectory, relativePath))
  if (!filePath.startsWith(`${exportDirectory}${path.sep}`)) {
    throw new Error('A Strava file resolved outside the export directory')
  }
  return filePath
}

const archiveExtension = (filename) => {
  const match = filename.match(/\.(fit\.gz|gpx\.gz|gpx)$/i)
  if (!match) throw new Error(`Unsupported Strava filename: ${filename}`)
  return match[1].toLowerCase()
}

const copyIfChanged = (source, destination) => {
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

const activityFromRow = (row) => {
  const id = String(row[columns.id]).trim()
  if (!/^\d+$/.test(id)) throw new Error(`Unsafe Strava activity ID: ${id}`)
  const override = activityOverrides[id] ?? {}
  const distanceKm = numberOrNull(row[columns.distanceKm])
  const media = String(row[columns.media] ?? '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)

  return {
    id,
    type: override.type ?? row[columns.type],
    name: (override.name ?? row[columns.name]) || null,
    startDate: parseStravaDate(row[columns.date]),
    distanceM: distanceKm == null ? null : Math.round(distanceKm * 1000),
    movingTimeSeconds: numberOrNull(row[columns.moving]),
    elapsedTimeSeconds: numberOrNull(row[columns.elapsed]),
    ascentM: numberOrNull(row[columns.ascentM]),
    descentM: numberOrNull(row[columns.descentM]),
    averageHeartRate: numberOrNull(row[columns.averageHeartRate]),
    calories: numberOrNull(row[columns.calories]),
    filename: row[columns.filename],
    media,
    weather: {
      condition: row[columns.weatherCondition] || null,
      temperatureC: numberOrNull(row[columns.weatherTemperature]),
      apparentTemperatureC: numberOrNull(row[columns.apparentTemperature]),
      humidity: numberOrNull(row[columns.humidity]),
      windSpeed: numberOrNull(row[columns.windSpeed]),
      windGust: numberOrNull(row[columns.windGust]),
      windBearing: numberOrNull(row[columns.windBearing]),
      precipitationIntensity: numberOrNull(row[columns.precipitationIntensity]),
      precipitationProbability: numberOrNull(row[columns.precipitationProbability]),
      precipitationType: row[columns.precipitationType] || null,
      cloudCover: numberOrNull(row[columns.cloudCover]),
    },
  }
}

const activities = csvRows
  .filter((row) =>
    allowedTypes.has(
      activityOverrides[String(row[columns.id]).trim()]?.type ??
        row[columns.type],
    ),
  )
  .map(activityFromRow)
const importedAt = new Date().toISOString()
const records = loadCanonicalRecords()
const recordsByStravaId = new Map(
  records
    .filter((record) => record.sources.strava?.activityId != null)
    .map((record) => [String(record.sources.strava.activityId), record]),
)
const recordIndex = new Map(records.map((record) => [record.id, record]))
const manifestActivities = []
let linkedCount = 0
let createdCount = 0
let invalidRouteCount = 0
let archivedFileCount = 0
let archivedMediaCount = 0
let missingMediaCount = 0

for (const activity of activities) {
  const inputPath = safeExportFile(activity.filename)
  const candidate = decodeActivityFile(inputPath)
  if (candidate) {
    const startAltitude = candidate.feature.geometry.coordinates[0][2]
    const finishAltitude = candidate.feature.geometry.coordinates.at(-1)[2]
    candidate.descentM =
      activity.descentM ??
      (Number.isFinite(activity.ascentM) &&
      Number.isFinite(startAltitude) &&
      Number.isFinite(finishAltitude)
        ? Math.max(
            0,
            Math.round(activity.ascentM - (finishAltitude - startAltitude)),
          )
        : candidate.descentM)
  }
  if (!candidate) invalidRouteCount += 1

  let record =
    recordsByStravaId.get(activity.id) ??
    findCanonicalActivityMatch([...recordIndex.values()], activity)
  const matchedExisting = Boolean(record)
  const id = record?.id ?? `strava-${activity.id}`
  if (verbose) {
    console.log(
      `${matchedExisting ? 'link' : 'new '} ${activity.id} -> ${id} | ${candidate ? 'route' : 'no route'} | ${activity.startDate} | ${activity.name}`,
    )
  }

  const extension = archiveExtension(activity.filename)
  const archivedFilename = `${id}.${extension}`
  const archivedMedia = []
  const missingMedia = []
  for (const mediaPath of activity.media) {
    const unresolvedMediaPath = path.join(exportDirectory, mediaPath)
    if (!fs.existsSync(unresolvedMediaPath)) {
      missingMedia.push(path.basename(mediaPath))
      missingMediaCount += 1
      continue
    }
    const mediaSource = safeExportFile(mediaPath)
    const basename = path.basename(mediaSource)
    if (!/^[\w.-]+$/.test(basename)) {
      throw new Error(`Unsafe Strava media filename: ${basename}`)
    }
    const destinationName = `${id}-${basename}`
    if (apply && copyIfChanged(mediaSource, path.join(privateMediaDirectory, destinationName))) {
      archivedMediaCount += 1
    }
    archivedMedia.push(destinationName)
  }

  if (apply && copyIfChanged(inputPath, path.join(privateActivitiesDirectory, archivedFilename))) {
    archivedFileCount += 1
  }

  const snapshot = {
    name: activity.name,
    type: activity.type,
    startDate: activity.startDate,
    startDateLocal: null,
    distanceM: activity.distanceM,
    movingTimeSeconds: activity.movingTimeSeconds,
    elapsedTimeSeconds: activity.elapsedTimeSeconds,
    ascentM: activity.ascentM,
    descentM: activity.descentM,
    weather: activity.weather,
    mediaCount: archivedMedia.length,
  }
  const stravaSource = {
    activityId: activity.id,
    status: 'archived',
    archivedFilename,
    snapshot,
  }

  if (!record) {
    record = {
      schemaVersion: 1,
      id,
      local: {
        name: activity.name,
        activityType: null,
        visibility: 'public',
        photos: [],
      },
      sources: { garmin: null, strava: stravaSource },
      route: null,
      review: [],
    }
    createdCount += 1
  } else {
    record = {
      ...record,
      local: {
        ...record.local,
        name:
          record.local.name ??
          (record.sources.intervals ? null : activity.name),
      },
      sources: { ...record.sources, strava: stravaSource },
    }
    if (!recordsByStravaId.has(activity.id)) linkedCount += 1
  }

  const review = new Set(record.review ?? [])
  let route = record.route

  if (candidate) {
    const canonicalText = `${JSON.stringify(candidate.feature, null, 2)}\n`
    const checksum = sha256(canonicalText)
    if (apply) {
      writeJsonIfChanged(routeVersionPath(id, checksum), candidate.feature)
    }

    const versions = [...(route?.versions ?? [])]
    if (!versions.some((version) => version.checksum === checksum)) {
      versions.push({ checksum, source: 'strava', capturedAt: importedAt })
    }

    if (!route?.activeVersion) {
      route = {
        activeVersion: checksum,
        source: 'strava',
        status: 'archived',
        versions,
        bounds: candidate.bounds,
        start: candidate.start,
        finish: candidate.finish,
        descentM: candidate.descentM,
      }
    } else {
      route = {
        ...route,
        versions,
        ...(route.source === 'strava'
          ? { descentM: candidate.descentM }
          : {}),
      }
    }
    review.delete('route-unavailable')
  } else if (!route?.activeVersion) {
    review.add('route-unavailable')
  }

  record = { ...record, route, review: [...review].sort() }
  recordIndex.set(id, record)
  recordsByStravaId.set(activity.id, record)
  if (apply) writeCanonicalRecord(record)

  manifestActivities.push({
    id,
    stravaActivityId: activity.id,
    matchedExisting,
    archivedFilename,
    archivedMedia,
    missingMedia,
    routeAvailable: Boolean(candidate),
    privateMetrics: {
      averageHeartRate: activity.averageHeartRate,
      calories: activity.calories,
    },
  })
}

if (apply) {
  writeJsonIfChanged(privateManifestPath, {
    schemaVersion: 1,
    importedAt,
    source: 'Strava account export',
    activityCount: manifestActivities.length,
    activities: manifestActivities,
  })
  await import('./build-catalogue.js')
}

console.log(`Strava Walk/Hike activities: ${activities.length}`)
console.log(`Linked to existing walks: ${linkedCount}`)
console.log(`New canonical walks: ${createdCount}`)
console.log(`Activity files without a usable route: ${invalidRouteCount}`)
if (apply) {
  console.log(`New or changed private activity files archived: ${archivedFileCount}`)
  console.log(`New or changed private media files archived: ${archivedMediaCount}`)
} else {
  console.log('Dry run only; rerun with --apply to write the import')
}
console.log(`Media references missing from the Strava export: ${missingMediaCount}`)
