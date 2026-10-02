import fs from 'node:fs'
import path from 'node:path'

import {
  matchPhotoCandidates,
  routeCoordinatesFrom,
  scanMonth,
} from './photo-matching.js'

export const photoWindowFor = (walk) => {
  const archived = walk.sources?.photoArchive?.snapshot
  if (archived?.startDate && archived?.endDate) return archived

  const activity = walk.sources?.intervals?.snapshot
  const startTime = Date.parse(activity?.startDate)
  const elapsedSeconds = Number(activity?.elapsedTimeSeconds)
  if (!Number.isFinite(startTime) || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    throw new Error(`${walk.id} has no usable walk time window`)
  }

  return {
    date: activity.startDateLocal?.slice(0, 10) ?? activity.startDate.slice(0, 10),
    startDate: activity.startDate,
    endDate: new Date(startTime + elapsedSeconds * 1000).toISOString(),
  }
}

export const preparePhotoCandidates = ({
  walkId,
  archiveRoot = '/Volumes/photo/Photos',
}) => {
  const resolvedArchiveRoot = path.resolve(archiveRoot)
  const walkPath = path.resolve(`data/walks/${walkId}.json`)

  if (!fs.existsSync(walkPath)) {
    throw new Error(`Unknown walk: ${walkId}`)
  }

  const walk = JSON.parse(fs.readFileSync(walkPath, 'utf8'))
  const walkName =
    walk.local.name ??
    walk.sources?.intervals?.snapshot?.name ??
    walk.id

  const snapshot = photoWindowFor(walk)

  const localDate = snapshot.date ?? snapshot.startDate.slice(0, 10)
  const [year, month] = localDate.split('-')
  const monthDirectory = path.join(resolvedArchiveRoot, year, month)
  if (!fs.existsSync(monthDirectory)) {
    throw new Error(`Archive month not found: ${monthDirectory}`)
  }

  const localStart = Date.parse(`${localDate}T00:00:00Z`)
  const duration = Date.parse(snapshot.endDate) - Date.parse(snapshot.startDate)
  const monthDirectories = new Set()
  for (
    let day = localStart - 86400000;
    day <= localStart + duration + 86400000;
    day += 86400000
  ) {
    const date = new Date(day).toISOString()
    const directory = path.join(resolvedArchiveRoot, date.slice(0, 4), date.slice(5, 7))
    if (fs.existsSync(directory)) monthDirectories.add(directory)
  }

  const routePath = path.resolve(
    `data/route-versions/${walkId}/${walk.route.activeVersion}.geojson`,
  )
  const route = JSON.parse(fs.readFileSync(routePath, 'utf8'))

  const candidates = matchPhotoCandidates({
    photos: [...monthDirectories].flatMap((directory) =>
      scanMonth(directory, resolvedArchiveRoot)),
    routeCoordinates: routeCoordinatesFrom(route),
    startTime: Date.parse(snapshot.startDate),
    endTime: Date.parse(snapshot.endDate),
  })

  return {
    walk,
    walkName,
    snapshot,
    localDate,
    archiveRoot: resolvedArchiveRoot,
    monthDirectory,
    routePath,
    candidates,
  }
}
