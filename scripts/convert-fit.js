import fs from 'node:fs'
import path from 'node:path'

import {
  Decoder,
  Stream,
} from '@garmin/fitsdk'

const inputDirectory = 'private/garmin'
const archiveDirectory =
  'private/garmin/activities'
const manifestPath = 'private/garmin/manifest.json'
const routesDirectory = 'public/data/routes'
const indexPath = 'public/data/walks.json'

const activityFilenamePattern =
  /^((?:\d+|intervals-\d+))_ACTIVITY\.fit$/i

const semicirclesToDegrees = (value) =>
  value * (180 / 2 ** 31)

const round = (value, decimalPlaces = 2) => {
  if (!Number.isFinite(value)) {
    return null
  }

  const multiplier = 10 ** decimalPlaces

  return (
    Math.round(value * multiplier) /
    multiplier
  )
}

const loadManifest = () => {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `The private manifest does not exist: ${manifestPath}`,
    )
  }

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  )

  return new Map(
    manifest.activities.map((activity) => [
      String(
        activity.id ??
        activity.garminActivityId,
      ),
      activity,
    ]),
  )
}

const collectActivityFiles = (manifest) => {
  const activityFiles = new Map()

  for (const [activityId, metadata] of manifest) {
    const filename = String(metadata.filename ?? '')
    const match = filename.match(
      activityFilenamePattern,
    )

    if (
      !match ||
      match[1] !== activityId ||
      path.basename(filename) !== filename
    ) {
      throw new Error(
        `Unsafe private filename for activity ${activityId}`,
      )
    }

    const filePath = path.join(
      archiveDirectory,
      filename,
    )

    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Private FIT is missing for activity ${activityId}`,
      )
    }

    activityFiles.set(activityId, filePath)
  }

  return activityFiles
}

const calculateBounds = (coordinates) => {
  let minimumLongitude = Infinity
  let minimumLatitude = Infinity
  let maximumLongitude = -Infinity
  let maximumLatitude = -Infinity

  for (const [longitude, latitude] of coordinates) {
    minimumLongitude = Math.min(
      minimumLongitude,
      longitude,
    )

    minimumLatitude = Math.min(
      minimumLatitude,
      latitude,
    )

    maximumLongitude = Math.max(
      maximumLongitude,
      longitude,
    )

    maximumLatitude = Math.max(
      maximumLatitude,
      latitude,
    )
  }

  return [
    minimumLongitude,
    minimumLatitude,
    maximumLongitude,
    maximumLatitude,
  ]
}

const toPublicActivityType = (type) =>
  String(type).toLowerCase() === 'hike'
    ? 'hiking'
    : 'walking'

const convertFitFile = (
  inputPath,
  activityId,
  metadata,
) => {
  const fitBuffer = fs.readFileSync(inputPath)
  const fitStream = Stream.fromBuffer(fitBuffer)
  const decoder = new Decoder(fitStream)

  if (!decoder.isFIT()) {
    throw new Error('Not a valid FIT file')
  }

  if (!decoder.checkIntegrity()) {
    throw new Error(
      'Failed its FIT integrity check',
    )
  }

  const { messages, errors } = decoder.read({
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
  })

  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }

  const session = messages.sessionMesgs?.[0]
  const records = messages.recordMesgs ?? []

  if (!session) {
    throw new Error(
      'No activity session was found',
    )
  }

  const coordinates = records
    .filter(
      (record) =>
        Number.isFinite(record.positionLat) &&
        Number.isFinite(record.positionLong),
    )
    .map((record) => {
      const coordinate = [
        semicirclesToDegrees(
          record.positionLong,
        ),

        semicirclesToDegrees(
          record.positionLat,
        ),
      ]

      if (
        Number.isFinite(
          record.enhancedAltitude,
        )
      ) {
        coordinate.push(
          record.enhancedAltitude,
        )
      }

      return coordinate
    })

  if (coordinates.length < 2) {
    return {
      status: 'skipped',
      reason: 'No usable GPS route',
    }
  }

  const routeFilename = `${activityId}.geojson`

  const date = metadata.startDate ?? (
    session.startTime instanceof Date
      ? session.startTime.toISOString()
      : null
  )

  const properties = {
    id: activityId,
    activity: toPublicActivityType(metadata.type),
    name:
      metadata.name ??
      session.sportProfileName ??
      'Walk',
    date,
    distanceKm: round(
      metadata.distanceM / 1000,
    ) ?? round(
      session.totalDistance / 1000,
    ),
    movingTimeSeconds: round(
      metadata.movingTimeSeconds,
      0,
    ) ?? round(
      session.totalTimerTime,
      0,
    ),
    elapsedTimeSeconds: round(
      metadata.elapsedTimeSeconds,
      0,
    ) ?? round(
      session.totalElapsedTime,
      0,
    ),
    ascentM: round(
      metadata.ascentM,
      0,
    ) ?? round(
      session.totalAscent,
      0,
    ),
    descentM: round(
      session.totalDescent,
      0,
    ),
  }

  const route = {
    type: 'Feature',
    properties,

    geometry: {
      type: 'LineString',
      coordinates,
    },
  }

  const routePath = path.join(
    routesDirectory,
    routeFilename,
  )

  fs.writeFileSync(
    routePath,
    `${JSON.stringify(route, null, 2)}\n`,
  )

  return {
    status: 'converted',

    walk: {
      ...properties,
      routeUrl: `/data/routes/${routeFilename}`,
      bounds: calculateBounds(coordinates),
      start: coordinates[0].slice(0, 2),
      finish:
        coordinates[
          coordinates.length - 1
        ].slice(0, 2),
    },
  }
}

const assertPublicOutputIsSafe = (value) => {
  const output = JSON.stringify(value)

  if (
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(output) ||
    output.includes('/Users/')
  ) {
    throw new Error(
      'Private information was detected in public output',
    )
  }
}

if (!fs.existsSync(inputDirectory)) {
  throw new Error(
    `The input directory does not exist: ${inputDirectory}`,
  )
}

const manifest = loadManifest()
const activityFiles = collectActivityFiles(manifest)

fs.mkdirSync(routesDirectory, {
  recursive: true,
})

const walks = []
let skippedCount = 0
let failedCount = 0

console.log(
  `Found ${activityFiles.size} unique private activity file(s)`,
)

for (const [activityId, fitFile] of activityFiles) {
  const metadata = manifest.get(activityId)

  if (!metadata) {
    skippedCount += 1
    console.log(
      `Skipped activity ${activityId}: Not in the private manifest`,
    )
    continue
  }

  try {
    const result = convertFitFile(
      fitFile,
      activityId,
      metadata,
    )

    if (result.status === 'skipped') {
      skippedCount += 1
      console.log(
        `Skipped activity ${activityId}: ${result.reason}`,
      )
      continue
    }

    walks.push(result.walk)
    console.log(`Converted activity ${activityId}`)
  } catch (error) {
    failedCount += 1
    console.error(
      `Failed activity ${activityId}: ${error.message}`,
    )
  }
}

walks.sort(
  (firstWalk, secondWalk) =>
    new Date(secondWalk.date) -
    new Date(firstWalk.date),
)

const catalogue = {
  generatedAt: new Date().toISOString(),
  walkCount: walks.length,
  skippedWithoutRoute: skippedCount,
  walks,
}

assertPublicOutputIsSafe(catalogue)

fs.mkdirSync(
  path.dirname(indexPath),
  {
    recursive: true,
  },
)

fs.writeFileSync(
  indexPath,
  `${JSON.stringify(catalogue, null, 2)}\n`,
)

console.log('')
console.log(`Routes converted: ${walks.length}`)
console.log(`Activities skipped: ${skippedCount}`)
console.log(`Files failed: ${failedCount}`)
console.log(`Created ${indexPath}`)

if (failedCount > 0) {
  process.exitCode = 1
}
