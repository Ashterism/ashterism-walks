import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const canonicalDirectory = 'data/walks'
export const routeVersionsDirectory = 'data/route-versions'
export const publicRoutesDirectory = 'public/data/routes'
export const publicCataloguePath = 'public/data/walks.json'

export const safeWalkIdPattern = /^(?:\d+|intervals-\d+|strava-\d+)$/

export const assertSafeWalkId = (id) => {
  const value = String(id)

  if (!safeWalkIdPattern.test(value)) {
    throw new Error(`Unsafe Ashterism walk identifier: ${value}`)
  }

  return value
}

export const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex')

export const readJson = (filePath) =>
  JSON.parse(fs.readFileSync(filePath, 'utf8'))

export const writeJsonIfChanged = (filePath, value) => {
  const json = `${JSON.stringify(value, null, 2)}\n`

  if (
    fs.existsSync(filePath) &&
    fs.readFileSync(filePath, 'utf8') === json
  ) {
    return false
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, json)
  fs.renameSync(temporaryPath, filePath)
  return true
}

export const assertPublicValueIsSafe = (value) => {
  const output = JSON.stringify(value)

  if (
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(output) ||
    output.includes('/Users/')
  ) {
    throw new Error('Private information was detected in public data')
  }
}

export const loadCanonicalRecords = () => {
  if (!fs.existsSync(canonicalDirectory)) return []

  return fs
    .readdirSync(canonicalDirectory)
    .filter((filename) => filename.endsWith('.json'))
    .sort()
    .map((filename) => {
      const record = readJson(path.join(canonicalDirectory, filename))
      assertSafeWalkId(record.id)
      return record
    })
}

export const writeCanonicalRecord = (record) => {
  assertPublicValueIsSafe(record)
  const id = assertSafeWalkId(record.id)
  return writeJsonIfChanged(
    path.join(canonicalDirectory, `${id}.json`),
    record,
  )
}

export const routeVersionPath = (id, checksum) =>
  path.join(
    routeVersionsDirectory,
    assertSafeWalkId(id),
    `${checksum}.geojson`,
  )

export const publicRoutePath = (id) =>
  path.join(
    publicRoutesDirectory,
    `${assertSafeWalkId(id)}.geojson`,
  )

export const providerFingerprint = (activity, effectiveType) => {
  const snapshot = {
    id: activity.id,
    type: effectiveType,
    name: activity.name ?? null,
    startDate: activity.start_date ?? null,
    startDateLocal: activity.start_date_local ?? null,
    distanceM: activity.distance ?? null,
    movingTimeSeconds: activity.moving_time ?? null,
    elapsedTimeSeconds: activity.elapsed_time ?? null,
    ascentM: activity.total_elevation_gain ?? null,
    source: activity.source ?? null,
    fileType: activity.file_type ?? null,
    deviceName: activity.device_name ?? null,
    providerRevision:
      activity.icu_sync_date ??
      activity.updated ??
      activity.analyzed ??
      activity.last_modified ??
      null,
  }

  return sha256(JSON.stringify(snapshot))
}

export const publicActivityType = (type) =>
  String(type).toLowerCase() === 'hike' ||
  String(type).toLowerCase() === 'hiking'
    ? 'hiking'
    : 'walking'

export const providerSnapshotFor = (record) =>
  record.sources.intervals?.snapshot ?? record.sources.strava?.snapshot ?? {}

export const findCanonicalActivityMatch = (
  records,
  { startDate, distanceM },
) => {
  const candidateTime = new Date(startDate).getTime()
  if (!Number.isFinite(candidateTime)) return null

  const matches = records
    .map((record) => {
      const snapshot = providerSnapshotFor(record)
      const recordTime = new Date(
        snapshot.startDate ?? snapshot.startDateLocal,
      ).getTime()
      const recordDistance = Number(snapshot.distanceM)
      const timeDifferenceSeconds = Math.abs(candidateTime - recordTime) / 1000
      const distanceDifferenceRatio =
        Number.isFinite(recordDistance) && recordDistance > 0
          ? Math.abs(Number(distanceM) - recordDistance) / recordDistance
          : Infinity

      return { record, timeDifferenceSeconds, distanceDifferenceRatio }
    })
    .filter(
      (match) =>
        match.timeDifferenceSeconds <= 300 &&
        match.distanceDifferenceRatio <= 0.1,
    )
    .sort(
      (first, second) =>
        first.timeDifferenceSeconds - second.timeDifferenceSeconds ||
        first.distanceDifferenceRatio - second.distanceDifferenceRatio,
    )

  if (matches.length === 0) return null
  if (
    matches.length > 1 &&
    matches[0].timeDifferenceSeconds === matches[1].timeDifferenceSeconds &&
    matches[0].distanceDifferenceRatio === matches[1].distanceDifferenceRatio
  ) {
    return null
  }

  return matches[0].record
}

export const providerStatusFor = (
  providerActivityId,
  observedProviderIds,
  eligibleProviderIds,
) => {
  if (eligibleProviderIds.has(providerActivityId)) return 'active'
  if (observedProviderIds.has(providerActivityId)) return 'ineligible'
  return 'missing'
}

export const resolvePublicFields = (record) => {
  const snapshot = providerSnapshotFor(record)
  const activity = publicActivityType(
    record.local.activityType ?? snapshot.type,
  )
  const providers = []
  if (
    record.sources.garmin ||
    record.sources.intervals?.snapshot?.source === 'GARMIN_CONNECT'
  ) {
    providers.push('Garmin')
  }
  if (record.sources.strava) providers.push('Strava')

  return {
    id: record.id,
    activity,
    name:
      record.local.name ??
      snapshot.name ??
      (activity === 'hiking' ? 'Hike' : 'Walk'),
    date: snapshot.startDate ?? snapshot.startDateLocal,
    distanceKm:
      snapshot.distanceM == null
        ? null
        : Math.round((snapshot.distanceM / 1000) * 100) / 100,
    movingTimeSeconds: snapshot.movingTimeSeconds,
    elapsedTimeSeconds: snapshot.elapsedTimeSeconds,
    ascentM:
      snapshot.ascentM == null
        ? null
        : Math.round(snapshot.ascentM),
    descentM: record.route?.descentM ?? null,
    providers,
  }
}

export const withProviderStatus = (record, status, changedAt) => {
  const current = record.sources.intervals.status

  if (current === status) return record

  const review = new Set(record.review ?? [])
  review.delete('source-missing')
  review.delete('source-no-longer-eligible')

  if (status === 'missing') review.add('source-missing')
  if (status === 'ineligible') {
    review.add('source-no-longer-eligible')
  }

  return {
    ...record,
    sources: {
      ...record.sources,
      intervals: {
        ...record.sources.intervals,
        status,
        statusChangedAt: changedAt,
      },
    },
    review: [...review].sort(),
  }
}

export const preserveRouteAfterInvalidCandidate = (route) =>
  route?.activeVersion
    ? { ...route, status: 'cached-after-invalid-source' }
    : null
