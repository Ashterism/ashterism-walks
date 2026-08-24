import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const apiRoot = 'https://intervals.icu/api/v1'
const archiveDirectory = 'private/garmin/activities'
const manifestPath = 'private/garmin/manifest.json'
const keychainAccount = 'ashterism-walks'
const keychainService = 'intervals.icu'
const allowedTypes = new Set(['hike', 'walk'])

const getApiKey = () => {
  const environmentKey =
    process.env.INTERVALS_ICU_API_KEY?.trim()

  if (environmentKey) return environmentKey

  if (process.platform === 'darwin') {
    try {
      return execFileSync(
        'security',
        [
          'find-generic-password',
          '-a',
          keychainAccount,
          '-s',
          keychainService,
          '-w',
        ],
        { encoding: 'utf8' },
      ).trim()
    } catch {
      // The portable environment-variable option is explained below.
    }
  }

  throw new Error(
    'Intervals API key unavailable. Set INTERVALS_ICU_API_KEY or store it in the configured macOS Keychain entry.',
  )
}

const authorization = `Basic ${Buffer.from(
  `API_KEY:${getApiKey()}`,
).toString('base64')}`

const request = async (url) => {
  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
      Accept: 'application/json, application/octet-stream',
    },
  })

  if (!response.ok) {
    throw new Error(
      `Intervals request failed with HTTP ${response.status}`,
    )
  }

  return response
}

const sha256 = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex')

const isFit = (buffer) =>
  buffer.length >= 12 &&
  buffer.subarray(8, 12).toString('ascii') === '.FIT'

const loadExistingManifest = () => {
  if (!fs.existsSync(manifestPath)) return []

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  )

  return manifest.activities ?? []
}

const safeIdFor = (activity, existingActivity) => {
  const existingId =
    existingActivity?.id ??
    existingActivity?.garminActivityId

  if (existingId) return String(existingId)

  const externalId = String(activity.external_id ?? '')

  if (/^\d+$/.test(externalId)) {
    return externalId
  }

  const intervalsMatch =
    String(activity.id).match(/^i(\d+)$/)

  if (!intervalsMatch) {
    throw new Error(
      'An activity did not have a safe usable identifier',
    )
  }

  return `intervals-${intervalsMatch[1]}`
}

const downloadActivity = async (
  activity,
  existingByIntervalsId,
) => {
  const existingActivity =
    existingByIntervalsId.get(String(activity.id))

  const id = safeIdFor(
    activity,
    existingActivity,
  )

  if (!/^(?:\d+|intervals-\d+)$/.test(id)) {
    throw new Error(
      `Unsafe local identifier for Intervals activity ${activity.id}`,
    )
  }

  const filename = `${id}_ACTIVITY.fit`
  const filePath = path.join(
    archiveDirectory,
    filename,
  )

  let buffer

  if (fs.existsSync(filePath)) {
    buffer = fs.readFileSync(filePath)
  } else {
    const response = await request(
      `${apiRoot}/activity/${encodeURIComponent(activity.id)}/file`,
    )

    buffer = Buffer.from(
      await response.arrayBuffer(),
    )

    if (!isFit(buffer)) {
      throw new Error(
        `Intervals activity ${activity.id} did not return a FIT file`,
      )
    }

    const temporaryPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, buffer, {
      mode: 0o600,
    })
    fs.renameSync(temporaryPath, filePath)
  }

  if (!isFit(buffer)) {
    throw new Error(
      `Archived activity ${id} is not a FIT file`,
    )
  }

  return {
    id,
    intervalsActivityId: String(activity.id),
    type: activity.type,
    startDate:
      activity.start_date ??
      activity.start_date_local,
    name: activity.name,
    source: activity.source,
    deviceName: activity.device_name ?? null,
    distanceM: activity.distance ?? null,
    movingTimeSeconds: activity.moving_time ?? null,
    elapsedTimeSeconds: activity.elapsed_time ?? null,
    ascentM: activity.total_elevation_gain ?? null,
    filename,
    sha256: sha256(buffer),
  }
}

const tomorrow = new Date()
tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)

const activitiesUrl = new URL(
  `${apiRoot}/athlete/0/activities`,
)
activitiesUrl.searchParams.set('oldest', '2000-01-01')
activitiesUrl.searchParams.set(
  'newest',
  tomorrow.toISOString().slice(0, 10),
)

const activitiesResponse = await request(activitiesUrl)
const allActivities = await activitiesResponse.json()

if (!Array.isArray(allActivities)) {
  throw new Error(
    'Intervals returned an unexpected activities response',
  )
}

const activities = allActivities.filter(
  (activity) =>
    activity.source === 'GARMIN_CONNECT' &&
    activity.file_type === 'fit' &&
    allowedTypes.has(
      String(activity.type).toLowerCase(),
    ),
)

const existingByIntervalsId = new Map(
  loadExistingManifest().map((activity) => [
    String(activity.intervalsActivityId),
    activity,
  ]),
)

fs.mkdirSync(archiveDirectory, {
  recursive: true,
  mode: 0o700,
})

console.log(
  `Intervals returned ${activities.length} Garmin walk/hike FIT activities`,
)

const manifestActivities = []
const concurrency = 4

for (
  let offset = 0;
  offset < activities.length;
  offset += concurrency
) {
  const batch = activities.slice(
    offset,
    offset + concurrency,
  )

  manifestActivities.push(
    ...await Promise.all(
      batch.map((activity) =>
        downloadActivity(
          activity,
          existingByIntervalsId,
        ),
      ),
    ),
  )

  console.log(
    `Archived ${Math.min(offset + concurrency, activities.length)} of ${activities.length}`,
  )
}

manifestActivities.sort(
  (first, second) =>
    new Date(first.startDate) -
    new Date(second.startDate),
)

const manifest = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  source: 'Intervals.icu Garmin Connect import',
  activityCount: manifestActivities.length,
  activities: manifestActivities,
}

const manifestJson =
  `${JSON.stringify(manifest, null, 2)}\n`

if (
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(
    manifestJson,
  )
) {
  throw new Error(
    'Private email data was detected in the local manifest',
  )
}

const temporaryManifestPath =
  `${manifestPath}.${process.pid}.tmp`

fs.writeFileSync(
  temporaryManifestPath,
  manifestJson,
  { mode: 0o600 },
)
fs.renameSync(
  temporaryManifestPath,
  manifestPath,
)

console.log(
  `Private archive and manifest now contain ${manifestActivities.length} activities`,
)
