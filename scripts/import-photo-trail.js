import fs from 'node:fs'
import path from 'node:path'

import {
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
    'Usage: npm run import:photo-trail -- /path/to/photo-month /path/to/trail.geojson [--apply]',
  )
}

const photoDirectory = fs.realpathSync(path.resolve(inputs[0]))
const trailPath = fs.realpathSync(path.resolve(inputs[1]))
const configuration = readJson('scripts/photo-trail-walks.json')
const capturedAt = new Date().toISOString()
const earthRadiusM = 6_371_000
const radians = (degrees) => (degrees * Math.PI) / 180

const distanceBetween = (first, second) => {
  const latitudeDelta = radians(second[1] - first[1])
  const longitudeDelta = radians(second[0] - first[0])
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(first[1])) *
      Math.cos(radians(second[1])) *
      Math.sin(longitudeDelta / 2) ** 2
  return earthRadiusM * 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(1 - haversine),
  )
}

const normalizeOffset = (value) =>
  value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')

const valueFrom = (text, element) =>
  text.match(new RegExp(`<${element}>([^<]+)`))?.[1] ?? null

const photoPoints = fs
  .readdirSync(photoDirectory)
  .filter((filename) => filename.endsWith('.xmp'))
  .flatMap((filename) => {
    const text = fs.readFileSync(path.join(photoDirectory, filename), 'utf8')
    const date =
      valueFrom(text, 'photoshop:DateCreated') ??
      valueFrom(text, 'xmp:CreateDate') ??
      valueFrom(text, 'exif:GPSTimeStamp')
    const latitude = Number(valueFrom(text, 'exif:GPSLatitude'))
    const longitude = Number(valueFrom(text, 'exif:GPSLongitude'))

    if (!date || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return []
    }

    return [{
      time: normalizeOffset(date),
      coordinate: [longitude, latitude],
    }]
  })
  .sort((first, second) => first.time.localeCompare(second.time))
  .filter(
    (point, index, points) =>
      index === 0 ||
      point.time !== points[index - 1].time ||
      point.coordinate.join(',') !== points[index - 1].coordinate.join(','),
  )

const trailData = readJson(trailPath)
const trailFeature = trailData.features?.[0]
if (trailFeature?.geometry?.type !== 'MultiLineString') {
  throw new Error('Expected a MultiLineString trail GeoJSON feature')
}

const segments = trailFeature.geometry.coordinates
if (segments.length !== 3) {
  throw new Error(`Expected three trail segments, found ${segments.length}`)
}

// The OSM relation export contains three continuous pieces in mixed directions.
const trailCoordinates = [
  ...segments[0],
  ...segments[2].slice().reverse(),
  ...segments[1].slice().reverse(),
]

const nearestTrailIndex = (coordinate) => {
  let bestIndex = 0
  let bestDistance = Infinity
  for (let index = 0; index < trailCoordinates.length; index += 1) {
    const distance = distanceBetween(coordinate, trailCoordinates[index])
    if (distance < bestDistance) {
      bestIndex = index
      bestDistance = distance
    }
  }
  return { index: bestIndex, distanceM: bestDistance }
}

const appendIfSeparate = (coordinates, coordinate) => {
  if (
    coordinates.length === 0 ||
    distanceBetween(coordinates.at(-1), coordinate) >= 5
  ) {
    coordinates.push(coordinate)
  }
}

const routeFor = (walk) => {
  const startMatch = nearestTrailIndex(walk.startAnchor)
  const finishMatch = nearestTrailIndex(walk.finishAnchor)
  let startIndex = startMatch.index
  const coordinates = []

  if (walk.photoConnectorUntil) {
    const connector = photoPoints.filter(
      (point) =>
        point.time >= walk.startTime &&
        point.time <= walk.photoConnectorUntil,
    )
    for (const point of connector) appendIfSeparate(coordinates, point.coordinate)
    startIndex = nearestTrailIndex(coordinates.at(-1)).index
  } else {
    appendIfSeparate(coordinates, walk.startAnchor)
  }

  if (startIndex >= finishMatch.index) {
    throw new Error(`Trail anchors are out of order for ${walk.id}`)
  }

  for (const coordinate of trailCoordinates.slice(startIndex, finishMatch.index + 1)) {
    appendIfSeparate(coordinates, coordinate)
  }
  appendIfSeparate(coordinates, walk.finishAnchor)

  let distanceM = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    distanceM += distanceBetween(coordinates[index - 1], coordinates[index])
  }
  const longitudes = coordinates.map((coordinate) => coordinate[0])
  const latitudes = coordinates.map((coordinate) => coordinate[1])

  return {
    feature: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    },
    distanceM,
    startMatchDistanceM: Math.round(startMatch.distanceM),
    finishMatchDistanceM: Math.round(finishMatch.distanceM),
    pointCount: coordinates.length,
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

let written = 0
for (const walk of configuration.walks) {
  const route = routeFor(walk)
  const checksum = sha256(JSON.stringify(route.feature))
  const dayPhotoPoints = photoPoints.filter((point) => point.time.startsWith(walk.date))
  const elapsedTimeSeconds = Math.round(
    (new Date(walk.endTime) - new Date(walk.startTime)) / 1000,
  )
  const record = {
    schemaVersion: 1,
    id: walk.id,
    local: {
      name: walk.name,
      activityType: 'Hike',
      visibility: 'public',
      photos: [],
      date: walk.startTime,
      metrics: {
        distanceM: Math.round(route.distanceM),
        elapsedTimeSeconds,
      },
      notes: walk.notes,
      references: configuration.references,
    },
    sources: {
      photoArchive: {
        status: 'archived',
        snapshot: {
          date: walk.date,
          pointCount: dayPhotoPoints.length,
          startDate: walk.startTime,
          endDate: walk.endTime,
        },
      },
      openStreetMap: {
        status: 'reference',
        relationId: configuration.trail.relationId,
        name: configuration.trail.name,
        url: configuration.trail.url,
        snapshot: {
          pointCount: route.pointCount,
          routeDistanceM: Math.round(route.distanceM),
          startAnchorDifferenceM: route.startMatchDistanceM,
          finishAnchorDifferenceM: route.finishMatchDistanceM,
          sourceChecksum: sha256(JSON.stringify(trailFeature)),
        },
      },
    },
    route: {
      activeVersion: checksum,
      source: 'photo-anchors-openstreetmap',
      status: 'estimated',
      versions: [{ checksum, source: 'photo-anchors-openstreetmap', capturedAt }],
      bounds: route.bounds,
      start: route.start,
      finish: route.finish,
    },
    review: [],
    provenance: {
      status: 'estimated',
      method: 'photo-gps-openstreetmap',
      metricsSource: 'Photo timestamps and matched trail geometry',
      routeSource: 'GPS-tagged photo anchors matched to OpenStreetMap trail geometry',
      label: 'Estimated route reconstructed from GPS-tagged photos and the mapped Pilgrimsleden trail.',
    },
  }

  console.log(
    `${walk.id}: ${(route.distanceM / 1000).toFixed(2)} km, ${route.pointCount} route points, ${dayPhotoPoints.length} photo anchors`,
  )

  if (apply) {
    writeJsonIfChanged(routeVersionPath(walk.id, checksum), route.feature)
    if (writeCanonicalRecord(record)) written += 1
  }
}

console.log(apply ? `Canonical records written: ${written}` : 'Dry run; use --apply to write records')
