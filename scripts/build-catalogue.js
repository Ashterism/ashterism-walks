import fs from 'node:fs'

import {
  assertPublicValueIsSafe,
  loadCanonicalRecords,
  publicCataloguePath,
  publicRoutePath,
  publicTripsPath,
  readJson,
  resolvePublicFields,
  routeVersionPath,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const tripData = readJson('data/trips.json')
const tripIds = new Set()
const tripByWalkId = new Map()

for (const trip of tripData.trips) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trip.id)) {
    throw new Error(`Unsafe trip identifier: ${trip.id}`)
  }
  if (tripIds.has(trip.id)) throw new Error(`Duplicate trip identifier: ${trip.id}`)
  tripIds.add(trip.id)

  for (const walkId of trip.walkIds) {
    if (tripByWalkId.has(walkId)) {
      throw new Error(`Walk ${walkId} belongs to more than one trip`)
    }
    tripByWalkId.set(walkId, trip)
  }
}

const walks = []
let skippedWithoutRoute = 0
const publishedWalkIds = new Set()

for (const record of loadCanonicalRecords()) {
  if (record.local.visibility !== 'public') continue

  const activeVersion = record.route?.activeVersion

  if (!activeVersion) {
    skippedWithoutRoute += 1
    continue
  }

  const versionPath = routeVersionPath(record.id, activeVersion)

  if (!fs.existsSync(versionPath)) {
    throw new Error(
      `Active route version is missing for walk ${record.id}`,
    )
  }

  const storedRoute = readJson(versionPath)
  const trip = tripByWalkId.get(record.id)
  const tags = [...new Set([...(record.local.tags ?? []), ...(trip?.tags ?? [])])]
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean)
    .sort()
  const properties = resolvePublicFields(record)
  const catalogueMetadata = {
    ...(tags.length > 0 ? { tags } : {}),
    ...(trip ? { tripId: trip.id } : {}),
    ...(record.local.includeInOverview === false
      ? { includeInOverview: false }
      : {}),
  }
  const publicRoute = {
    ...storedRoute,
    properties,
  }

  assertPublicValueIsSafe(publicRoute)
  writeJsonIfChanged(publicRoutePath(record.id), publicRoute)

  walks.push({
    ...properties,
    ...catalogueMetadata,
    photos: record.local.photos ?? [],
    routeUrl: `/data/routes/${record.id}.geojson?v=${activeVersion}`,
    bounds: record.route.bounds,
    start: record.route.start,
    finish: record.route.finish,
  })
  publishedWalkIds.add(record.id)
}

for (const [walkId, trip] of tripByWalkId) {
  if (!publishedWalkIds.has(walkId)) {
    throw new Error(`Trip ${trip.id} contains an unpublished walk: ${walkId}`)
  }
}

walks.sort(
  (first, second) => new Date(second.date) - new Date(first.date),
)

const catalogue = {
  walkCount: walks.length,
  skippedWithoutRoute,
  walks,
}

assertPublicValueIsSafe(catalogue)
writeJsonIfChanged(publicCataloguePath, catalogue)

const publicTrips = {
  schemaVersion: tripData.schemaVersion,
  trips: tripData.trips.map((trip) => ({
    ...trip,
    walkCount: trip.walkIds.length,
  })),
}
assertPublicValueIsSafe(publicTrips)
writeJsonIfChanged(publicTripsPath, publicTrips)

console.log(`Published routes: ${walks.length}`)
console.log(`Activities without a route: ${skippedWithoutRoute}`)
