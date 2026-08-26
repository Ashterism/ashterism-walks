import fs from 'node:fs'
import path from 'node:path'

import {
  loadCanonicalRecords,
  routeVersionPath,
  sha256,
  writeCanonicalRecord,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const apply = process.argv.includes('--apply')
const gpxArgument = process.argv.slice(2).find((value) => !value.startsWith('--'))
if (!gpxArgument) {
  throw new Error('Usage: node scripts/refine-rota-vicentina.js /path/to/salema-luz.gpx [--apply]')
}

const id = 'withings-4215888585'
const record = loadCanonicalRecords().find((walk) => walk.id === id)
if (!record) throw new Error(`Unknown walk: ${id}`)

const gpxPath = fs.realpathSync(path.resolve(gpxArgument))
const gpx = fs.readFileSync(gpxPath, 'utf8')
const coordinates = [...gpx.matchAll(/<trkpt lat="([\d.-]+)" lon="([\d.-]+)">[\s\S]*?<ele>([\d.-]+)<\/ele>/g)]
  .map((match) => [Number(match[2]), Number(match[1]), Number(match[3])])
if (coordinates.length < 100) throw new Error('The official GPX has too few route points')

const radians = (degrees) => (degrees * Math.PI) / 180
const distanceBetween = (first, second) => {
  const latitude1 = radians(first[1])
  const latitude2 = radians(second[1])
  const latitudeDelta = latitude2 - latitude1
  const longitudeDelta = radians(second[0] - first[0])
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}
const nearestIndex = (points, target) => points.reduce(
  (best, point, index) => {
    const distance = distanceBetween(point, target)
    return distance < best.distance ? { index, distance } : best
  },
  { index: -1, distance: Infinity },
)

const startAnchor = record.route.start
const finishAnchor = record.route.finish
const forwardCost = distanceBetween(coordinates[0], startAnchor) +
  distanceBetween(coordinates.at(-1), finishAnchor)
const reverseCost = distanceBetween(coordinates.at(-1), startAnchor) +
  distanceBetween(coordinates[0], finishAnchor)
const oriented = reverseCost < forwardCost ? [...coordinates].reverse() : coordinates
const startMatch = nearestIndex(oriented, startAnchor)
const finishMatch = nearestIndex(oriented, finishAnchor)
if (startMatch.index >= finishMatch.index) throw new Error('Could not orient and trim the official route')
if (startMatch.distance > 1000 || finishMatch.distance > 1000) {
  throw new Error('The official route does not match the Timeline anchors closely enough')
}

const trimmed = oriented.slice(startMatch.index, finishMatch.index + 1)
trimmed[0] = [...startAnchor, trimmed[0][2]]
trimmed[trimmed.length - 1] = [...finishAnchor, trimmed.at(-1)[2]]
const feature = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: trimmed },
}
const canonicalText = `${JSON.stringify(feature, null, 2)}\n`
const checksum = sha256(canonicalText)
const longitudes = trimmed.map((point) => point[0])
const latitudes = trimmed.map((point) => point[1])
let distanceM = 0
let ascentM = 0
let descentM = 0
for (let index = 1; index < trimmed.length; index += 1) {
  distanceM += distanceBetween(trimmed[index - 1], trimmed[index])
  const elevationChange = trimmed[index][2] - trimmed[index - 1][2]
  if (elevationChange > 0) ascentM += elevationChange
  else descentM -= elevationChange
}

const capturedAt = new Date().toISOString()
const versions = [...(record.route.versions ?? [])]
if (!versions.some((version) => version.checksum === checksum)) {
  versions.push({ checksum, source: 'rota-vicentina', capturedAt })
}
const updated = {
  ...record,
  sources: {
    ...record.sources,
    rotaVicentina: {
      status: 'reference',
      routeId: '801765498',
      name: 'Salema » Luz',
      direction: 'reverse',
      url: 'https://rotavicentina.com/en/walking/salema-luz-2/',
      snapshot: {
        pointCount: coordinates.length,
        matchedPointCount: trimmed.length,
        routeDistanceM: Math.round(distanceM),
        startAnchorDifferenceM: Math.round(startMatch.distance),
        finishAnchorDifferenceM: Math.round(finishMatch.distance),
        sourceChecksum: sha256(gpx),
      },
    },
  },
  route: {
    activeVersion: checksum,
    source: 'rota-vicentina',
    status: 'estimated',
    versions,
    bounds: [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)],
    start: trimmed[0].slice(0, 2),
    finish: trimmed.at(-1).slice(0, 2),
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
  },
  provenance: {
    status: 'estimated',
    method: 'withings-google-timeline-rota-vicentina',
    metricsSource: 'Withings',
    routeSource: 'Official Rota Vicentina GPX matched to Google Timeline anchors',
    label: 'Estimated route compiled from Withings activity data, Google Timeline anchors and official Rota Vicentina trail geometry.',
  },
}

if (apply) {
  writeJsonIfChanged(routeVersionPath(id, checksum), feature)
  writeCanonicalRecord(updated)
  const archivePath = 'private/rota-vicentina/salema-luz.gpx'
  fs.mkdirSync(path.dirname(archivePath), { recursive: true, mode: 0o700 })
  fs.copyFileSync(gpxPath, archivePath)
  fs.chmodSync(archivePath, 0o600)
  await import('./build-catalogue.js')
}

console.log(`${apply ? 'Updated' : 'Would update'} ${id}: ${trimmed.length} points, ${(distanceM / 1000).toFixed(2)} km, ${Math.round(ascentM)} m ascent, ${Math.round(descentM)} m descent`)
