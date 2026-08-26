import fs from 'node:fs'
import path from 'node:path'

import {
  loadCanonicalRecords,
  providerSnapshotFor,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const inputs = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
const writeReport = process.argv.includes('--write')
if (inputs.length !== 2) {
  throw new Error(
    'Usage: node scripts/analyse-withings-timeline.js /path/to/withings-export /path/to/location-history.json [--write]',
  )
}

const withingsDirectory = fs.realpathSync(path.resolve(inputs[0]))
const timelinePath = fs.realpathSync(path.resolve(inputs[1]))
const activitiesPath = path.join(withingsDirectory, 'activities.csv')

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
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ''))
    rows.push(row)
  }
  return rows
}

const rows = parseCsv(
  fs.readFileSync(activitiesPath, 'utf8').replace(/^\uFEFF/, ''),
)
const headers = rows.shift()
const column = (name) => {
  const index = headers.indexOf(name)
  if (index < 0) throw new Error(`Withings column is missing: ${name}`)
  return index
}
const columns = {
  from: column('from'),
  to: column('to'),
  type: column('Activity type'),
  data: column('Data'),
}
const numberOrNull = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
const activityRows = rows
  .filter((row) => ['Walking', 'Hiking'].includes(row[columns.type]))
  .map((row, index) => {
    const data = JSON.parse(row[columns.data])
    return {
      rowNumber: index + 2,
      activityType: row[columns.type],
      from: row[columns.from],
      to: row[columns.to],
      startTime: new Date(row[columns.from]).getTime(),
      endTime: new Date(row[columns.to]).getTime(),
      distanceM: numberOrNull(data.distance) ?? 0,
      movingTimeSeconds: numberOrNull(data.effduration),
      steps: numberOrNull(data.steps),
    }
  })
  .filter((row) => Number.isFinite(row.startTime) && Number.isFinite(row.endTime))
  .sort((first, second) => first.startTime - second.startTime)

const localDate = (row) => row.from.slice(0, 10)
const groups = []
for (const row of activityRows) {
  const previous = groups.at(-1)
  const gapMinutes = previous ? (row.startTime - previous.endTime) / 60_000 : Infinity
  if (
    previous &&
    previous.date === localDate(row) &&
    previous.activityType === row.activityType &&
    gapMinutes <= 90
  ) {
    previous.rows.push(row)
    previous.endTime = Math.max(previous.endTime, row.endTime)
  } else {
    groups.push({
      date: localDate(row),
      activityType: row.activityType,
      startTime: row.startTime,
      endTime: row.endTime,
      rows: [row],
    })
  }
}

const parseGeoPoint = (value) => {
  const match = String(value ?? '').match(/^geo:([-\d.]+),([-\d.]+)$/)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? [longitude, latitude]
    : null
}
const timeline = JSON.parse(fs.readFileSync(timelinePath, 'utf8'))
const timelinePoints = timeline
  .flatMap((entry) =>
    (entry.timelinePath ?? []).flatMap((point) => {
      const coordinate = parseGeoPoint(point.point)
      const offsetMinutes = Number(point.durationMinutesOffsetFromStartTime)
      const startTime = new Date(entry.startTime).getTime()
      return coordinate && Number.isFinite(offsetMinutes) && Number.isFinite(startTime)
        ? [{ time: startTime + offsetMinutes * 60_000, coordinate }]
        : []
    }),
  )
  .sort((first, second) => first.time - second.time)

const radians = (degrees) => (degrees * Math.PI) / 180
const distanceBetween = (first, second) => {
  const latitude1 = radians(first[1])
  const latitude2 = radians(second[1])
  const latitudeDelta = latitude2 - latitude1
  const longitudeDelta = radians(second[0] - first[0])
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}
const routeForWindow = (startTime, endTime) => {
  const tolerance = 5 * 60_000
  const points = timelinePoints
    .filter((point) => point.time >= startTime - tolerance && point.time <= endTime + tolerance)
    .filter(
      (point, index, all) =>
        index === 0 ||
        point.time !== all[index - 1].time ||
        point.coordinate.join(',') !== all[index - 1].coordinate.join(','),
    )
    .filter(
      (point, index, all) =>
        index === 0 || point.coordinate.join(',') !== all[index - 1].coordinate.join(','),
    )
  let lineDistanceM = 0
  for (let index = 1; index < points.length; index += 1) {
    lineDistanceM += distanceBetween(points[index - 1].coordinate, points[index].coordinate)
  }
  return {
    pointCount: points.length,
    lineDistanceM: Math.round(lineDistanceM),
    start: points[0]?.coordinate ?? null,
    finish: points.at(-1)?.coordinate ?? null,
  }
}

const canonicalRecords = loadCanonicalRecords()
const canonicalWindows = canonicalRecords.map((record) => {
  const snapshot = providerSnapshotFor(record)
  const startTime = new Date(snapshot.startDate ?? snapshot.startDateLocal).getTime()
  const elapsedSeconds = numberOrNull(snapshot.elapsedTimeSeconds) ??
    numberOrNull(snapshot.movingTimeSeconds) ?? 0
  return {
    id: record.id,
    name: record.local.name ?? snapshot.name ?? 'Walk',
    startTime,
    endTime: startTime + elapsedSeconds * 1000,
    distanceM: numberOrNull(snapshot.distanceM),
  }
})
const knownWithingsWindows = new Set(
  canonicalRecords.flatMap((record) =>
    (record.sources.withings?.components ?? []).map(
      (component) => `${component.from}|${component.to}`,
    ),
  ),
)

const candidates = groups
  .map((group) => {
    const distanceM = group.rows.reduce((sum, row) => sum + row.distanceM, 0)
    const movingValues = group.rows
      .map((row) => row.movingTimeSeconds)
      .filter((value) => value != null && value > 0)
    const movingTimeSeconds = movingValues.length > 0
      ? movingValues.reduce((sum, value) => sum + value, 0)
      : Math.round((group.endTime - group.startTime) / 1000)
    const route = routeForWindow(group.startTime, group.endTime)
    const distanceRatio = distanceM > 0 ? route.lineDistanceM / distanceM : 0
    const componentRoutes = group.rows.map((row) =>
      routeForWindow(row.startTime, row.endTime),
    )
    const segmentedRoute = {
      pointCount: componentRoutes.reduce((sum, item) => sum + item.pointCount, 0),
      lineDistanceM: componentRoutes.reduce((sum, item) => sum + item.lineDistanceM, 0),
      start: componentRoutes.find((item) => item.start)?.start ?? null,
      finish: componentRoutes.findLast((item) => item.finish)?.finish ?? null,
    }
    const segmentedDistanceRatio = distanceM > 0
      ? segmentedRoute.lineDistanceM / distanceM
      : 0
    const exactKnownRows = group.rows.filter((row) =>
      knownWithingsWindows.has(`${row.from}|${row.to}`),
    ).length
    const matches = canonicalWindows
      .map((walk) => {
        const startDifferenceMinutes = Math.abs(walk.startTime - group.startTime) / 60_000
        const overlapMilliseconds = Math.max(
          0,
          Math.min(walk.endTime, group.endTime) - Math.max(walk.startTime, group.startTime),
        )
        const groupDuration = Math.max(group.endTime - group.startTime, 1)
        const overlapRatio = overlapMilliseconds / groupDuration
        const distanceDifferenceRatio = walk.distanceM && distanceM
          ? Math.abs(walk.distanceM - distanceM) / distanceM
          : null
        return { ...walk, startDifferenceMinutes, overlapRatio, distanceDifferenceRatio }
      })
      .filter(
        (walk) =>
          walk.startDifferenceMinutes <= 30 ||
          walk.overlapRatio >= 0.35 ||
          (walk.startDifferenceMinutes <= 180 && walk.distanceDifferenceRatio <= 0.15),
      )
      .sort((first, second) =>
        second.overlapRatio - first.overlapRatio ||
        first.startDifferenceMinutes - second.startDifferenceMinutes,
      )
      .slice(0, 3)
      .map(({ id, name, startDifferenceMinutes, overlapRatio, distanceDifferenceRatio }) => ({
        id,
        name,
        startDifferenceMinutes: Math.round(startDifferenceMinutes),
        overlapRatio: Math.round(overlapRatio * 100) / 100,
        distanceDifferenceRatio:
          distanceDifferenceRatio == null
            ? null
            : Math.round(distanceDifferenceRatio * 100) / 100,
      }))
    const quality = segmentedRoute.pointCount >= 8 && segmentedDistanceRatio >= 0.55 && segmentedDistanceRatio <= 1.35
      ? 'high'
      : segmentedRoute.pointCount >= 5 && segmentedDistanceRatio >= 0.4 && segmentedDistanceRatio <= 1.6
        ? 'medium'
        : 'low'
    return {
      date: group.date,
      activityType: group.activityType,
      from: new Date(group.startTime).toISOString(),
      to: new Date(group.endTime).toISOString(),
      componentCount: group.rows.length,
      sourceRows: group.rows.map(({ rowNumber, from, to, distanceM }) => ({
        rowNumber,
        from,
        to,
        distanceM: Math.round(distanceM),
      })),
      distanceM: Math.round(distanceM),
      movingTimeSeconds: Math.round(movingTimeSeconds),
      averageSpeedKph: Math.round((distanceM / movingTimeSeconds) * 3.6 * 100) / 100,
      route,
      distanceRatio: Math.round(distanceRatio * 100) / 100,
      segmentedRoute,
      segmentedDistanceRatio: Math.round(segmentedDistanceRatio * 100) / 100,
      componentRoutes: componentRoutes.map((item, index) => ({
        ...item,
        sourceRowNumber: group.rows[index].rowNumber,
        sourceDistanceM: Math.round(group.rows[index].distanceM),
      })),
      quality,
      exactKnownRows,
      likelyDuplicate: exactKnownRows > 0 || matches.length > 0,
      matches,
    }
  })
  .filter((candidate) => candidate.distanceM >= 5_000)
  .sort((first, second) => first.date.localeCompare(second.date))

const unresolved = candidates.filter((candidate) => !candidate.likelyDuplicate)
const summary = {
  generatedAt: new Date().toISOString(),
  sourceActivityRows: activityRows.length,
  groupedWalksOver5Km: candidates.length,
  likelyDuplicates: candidates.length - unresolved.length,
  unresolved: unresolved.length,
  unresolvedHighQuality: unresolved.filter((candidate) => candidate.quality === 'high').length,
  unresolvedMediumQuality: unresolved.filter((candidate) => candidate.quality === 'medium').length,
}
const report = { schemaVersion: 1, summary, candidates: unresolved }
if (writeReport) {
  writeJsonIfChanged('private/withings-timeline-candidates.json', report)
}

console.log(JSON.stringify(summary, null, 2))
for (const candidate of unresolved.filter((item) => item.quality !== 'low')) {
  console.log([
    candidate.quality.padEnd(6),
    candidate.activityType.padEnd(7),
    candidate.date,
    `${(candidate.distanceM / 1000).toFixed(2)} km`,
    `${candidate.componentCount} parts`,
    `${candidate.segmentedRoute.pointCount} points`,
    `ratio ${candidate.segmentedDistanceRatio.toFixed(2)}`,
    `start ${candidate.segmentedRoute.start?.join(',') ?? 'none'}`,
  ].join(' | '))
}
if (writeReport) console.log('Private report: private/withings-timeline-candidates.json')
