import fs from 'node:fs'
import path from 'node:path'

import {
  matchPhotoCandidates,
  routeCoordinatesFrom,
  scanMonth,
} from './photo-matching.js'

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

  const snapshot = walk.sources?.photoArchive?.snapshot
  if (!snapshot?.startDate || !snapshot?.endDate) {
    throw new Error(`${walkId} has no photo-archive time window`)
  }

  const localDate = snapshot.date ?? snapshot.startDate.slice(0, 10)
  const [year, month] = localDate.split('-')
  const monthDirectory = path.join(resolvedArchiveRoot, year, month)

  if (!fs.existsSync(monthDirectory)) {
    throw new Error(`Archive month not found: ${monthDirectory}`)
  }

  const routePath = path.resolve(
    `data/route-versions/${walkId}/${walk.route.activeVersion}.geojson`,
  )
  const route = JSON.parse(fs.readFileSync(routePath, 'utf8'))

  const candidates = matchPhotoCandidates({
    photos: scanMonth(monthDirectory, resolvedArchiveRoot),
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
