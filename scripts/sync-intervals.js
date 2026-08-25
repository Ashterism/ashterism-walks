import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  findCanonicalActivityMatch,
  loadCanonicalRecords,
  providerFingerprint,
  routeVersionPath,
} from './lib/canonical-walks.js'

const apiRoot = 'https://intervals.icu/api/v1'
const archiveDirectory = 'private/garmin/activities'
const historyDirectory = 'private/garmin/history'
const manifestPath = 'private/garmin/manifest.json'
const overridesPath = 'scripts/intervals-activity-overrides.json'
const keychainAccount = 'ashterism-walks'
const keychainService = 'intervals.icu'
const allowedTypes = new Set(['hike', 'walk'])
const refreshLatest = process.argv.includes('--refresh-latest')
const archiveStats = { downloaded: 0, refreshed: 0, reused: 0 }

const activityOverrides = JSON.parse(
  fs.readFileSync(overridesPath, 'utf8'),
)

const getApiKey = () => {
  const environmentKey = process.env.INTERVALS_ICU_API_KEY?.trim()
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
      // Automated environments use the environment variable above.
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
    throw new Error(`Intervals request failed with HTTP ${response.status}`)
  }

  return response
}

const sha256 = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex')

const isFit = (buffer) =>
  buffer.length >= 12 &&
  buffer.subarray(8, 12).toString('ascii') === '.FIT'

const existingRecords = loadCanonicalRecords()
const existingByIntervalsId = new Map(
  existingRecords
    .filter((record) => record.sources.intervals?.activityId != null)
    .map((record) => [
      String(record.sources.intervals.activityId),
      record,
    ]),
)

const safeIdFor = (activity, existingRecord) => {
  if (existingRecord?.id) return String(existingRecord.id)

  const externalId = String(activity.external_id ?? '')
  if (/^\d+$/.test(externalId)) return externalId

  const intervalsMatch = String(activity.id).match(/^i(\d+)$/)
  if (!intervalsMatch) {
    throw new Error('An activity did not have a safe usable identifier')
  }

  return `intervals-${intervalsMatch[1]}`
}

const archiveFitCandidate = async (activity, id) => {
  const filename = `${id}_ACTIVITY.fit`
  const filePath = path.join(archiveDirectory, filename)
  const existingBuffer = fs.existsSync(filePath)
    ? fs.readFileSync(filePath)
    : null
  const response = await request(
    `${apiRoot}/activity/${encodeURIComponent(activity.id)}/fit-file`,
  )
  const buffer = Buffer.from(await response.arrayBuffer())

  if (!isFit(buffer)) {
    throw new Error(
      `Intervals activity ${activity.id} did not return a FIT file`,
    )
  }

  const changed =
    !existingBuffer || sha256(existingBuffer) !== sha256(buffer)

  if (existingBuffer && changed) {
    const activityHistoryDirectory = path.join(historyDirectory, id)
    fs.mkdirSync(activityHistoryDirectory, {
      recursive: true,
      mode: 0o700,
    })
    const previousPath = path.join(
      activityHistoryDirectory,
      `${sha256(existingBuffer)}.fit`,
    )
    if (!fs.existsSync(previousPath)) {
      fs.writeFileSync(previousPath, existingBuffer, { mode: 0o600 })
    }
  }

  if (changed) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, buffer, { mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  }

  if (existingBuffer) archiveStats.refreshed += 1
  else archiveStats.downloaded += 1

  return { filename, sha256: sha256(buffer) }
}

const tomorrow = new Date()
tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)

const activitiesUrl = new URL(`${apiRoot}/athlete/0/activities`)
activitiesUrl.searchParams.set('oldest', '2000-01-01')
activitiesUrl.searchParams.set('newest', tomorrow.toISOString().slice(0, 10))

const activitiesResponse = await request(activitiesUrl)
const allActivities = await activitiesResponse.json()

if (!Array.isArray(allActivities)) {
  throw new Error('Intervals returned an unexpected activities response')
}

const observedActivities = allActivities.filter(
  (activity) =>
    activity.source === 'GARMIN_CONNECT' &&
    activity.file_type === 'fit',
)

const eligibleActivities = observedActivities
  .map((activity) => ({
    ...activity,
    effectiveType:
      activityOverrides[activity.id]?.type ?? activity.type,
  }))
  .filter((activity) =>
    allowedTypes.has(String(activity.effectiveType).toLowerCase()),
  )

const latestActivity = eligibleActivities.reduce(
  (latest, activity) =>
    !latest || new Date(activity.start_date) > new Date(latest.start_date)
      ? activity
      : latest,
  null,
)

fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 })

console.log(
  `Intervals returned ${eligibleActivities.length} Garmin walk/hike FIT activities`,
)

const manifestActivities = []

for (const activity of eligibleActivities) {
  const intervalsActivityId = String(activity.id)
  const existingRecord =
    existingByIntervalsId.get(intervalsActivityId) ??
    findCanonicalActivityMatch(existingRecords, {
      startDate: activity.start_date ?? activity.start_date_local,
      distanceM: activity.distance ?? null,
    })
  const id = safeIdFor(activity, existingRecord)
  const fingerprint = providerFingerprint(
    activity,
    activity.effectiveType,
  )
  const activeVersion = existingRecord?.route?.activeVersion
  const activeVersionExists =
    !activeVersion ||
    fs.existsSync(routeVersionPath(id, activeVersion))
  const forceThisActivity =
    refreshLatest && activity.id === latestActivity?.id
  const providerChanged =
    existingRecord?.sources.intervals?.fingerprint != null &&
    existingRecord.sources.intervals.fingerprint !== fingerprint
  const shouldDownload =
    !existingRecord ||
    !activeVersionExists ||
    providerChanged ||
    forceThisActivity

  const candidate = shouldDownload
    ? await archiveFitCandidate(activity, id)
    : null

  if (!candidate) archiveStats.reused += 1

  manifestActivities.push({
    id,
    intervalsActivityId,
    garminActivityId: /^\d+$/.test(String(activity.external_id ?? ''))
      ? String(activity.external_id)
      : null,
    providerFingerprint: fingerprint,
    type: activity.effectiveType,
    startDate: activity.start_date ?? activity.start_date_local,
    startDateLocal: activity.start_date_local ?? null,
    name: activity.name ?? null,
    source: activity.source,
    deviceName: activity.device_name ?? null,
    distanceM: activity.distance ?? null,
    movingTimeSeconds: activity.moving_time ?? null,
    elapsedTimeSeconds: activity.elapsed_time ?? null,
    ascentM: activity.total_elevation_gain ?? null,
    candidateFilename: candidate?.filename ?? null,
    candidateSha256: candidate?.sha256 ?? null,
  })
}

manifestActivities.sort(
  (first, second) => new Date(first.startDate) - new Date(second.startDate),
)

const manifest = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  source: 'Intervals.icu Garmin Connect import',
  completeProviderSnapshot: true,
  observedIntervalsActivityIds: observedActivities.map((activity) =>
    String(activity.id),
  ),
  activityCount: manifestActivities.length,
  activities: manifestActivities,
}

const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(manifestJson)) {
  throw new Error('Private email data was detected in the local manifest')
}

const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`
fs.writeFileSync(temporaryManifestPath, manifestJson, { mode: 0o600 })
fs.renameSync(temporaryManifestPath, manifestPath)

console.log(
  `Private sync manifest now contains ${manifestActivities.length} eligible activities`,
)
console.log(
  `FIT candidates: ${archiveStats.downloaded} new, ${archiveStats.refreshed} refreshed, ${archiveStats.reused} unchanged`,
)
