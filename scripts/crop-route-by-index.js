import fs from 'node:fs'
import path from 'node:path'

import {
  readJson,
  routeVersionPath,
  sha256,
  writeCanonicalRecord,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const inputs = process.argv.slice(2)
const apply = inputs.includes('--apply')
const valueFor = (flag) => {
  const index = inputs.indexOf(flag)
  return index >= 0 ? inputs[index + 1] : null
}
const id = inputs.find((value) => !value.startsWith('--'))
const startIndex = Number(valueFor('--start-index'))
const reason = valueFor('--reason') ?? 'Removed travel recorded before the walk'

if (!id || !Number.isInteger(startIndex) || startIndex < 1) {
  throw new Error(
    'Usage: node scripts/crop-route-by-index.js <walk-id> --start-index <point> [--reason <text>] [--apply]',
  )
}

const recordPath = path.join('data/walks', `${id}.json`)
if (!fs.existsSync(recordPath)) throw new Error(`Unknown walk: ${id}`)
const record = readJson(recordPath)
if (!record.route?.activeVersion) throw new Error(`${id} has no active route`)

const sourcePath = routeVersionPath(id, record.route.activeVersion)
const source = readJson(sourcePath)
const originalCoordinates = source.geometry?.coordinates
if (source.geometry?.type !== 'LineString' || !Array.isArray(originalCoordinates)) {
  throw new Error(`${id} does not have a LineString route`)
}

const coordinates = originalCoordinates.slice(startIndex)
if (coordinates.length < 2) throw new Error('The crop would leave fewer than two route points')

const radians = (degrees) => (degrees * Math.PI) / 180
const distanceBetween = (first, second) => {
  const latitude1 = radians(first[1])
  const latitude2 = radians(second[1])
  const latitudeDelta = latitude2 - latitude1
  const longitudeDelta = radians(second[0] - first[0])
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

let distanceM = 0
for (let index = 1; index < coordinates.length; index += 1) {
  distanceM += distanceBetween(coordinates[index - 1], coordinates[index])
}

const feature = {
  ...source,
  geometry: { ...source.geometry, coordinates },
}
const canonicalText = `${JSON.stringify(feature, null, 2)}\n`
const checksum = sha256(canonicalText)
const capturedAt = new Date().toISOString()
const versions = [...(record.route.versions ?? [])]
if (!versions.some((version) => version.checksum === checksum)) {
  versions.push({ checksum, source: 'local-crop', capturedAt })
}

const longitudes = coordinates.map((coordinate) => coordinate[0])
const latitudes = coordinates.map((coordinate) => coordinate[1])
const updatedRecord = {
  ...record,
  local: {
    ...record.local,
    metrics: {
      ...(record.local.metrics ?? {}),
      distanceM: Math.round(distanceM),
    },
    routeEdit: {
      type: 'crop-start',
      startPointIndex: startIndex,
      reason,
    },
  },
  route: {
    ...record.route,
    activeVersion: checksum,
    source: 'local-crop',
    status: 'edited',
    versions,
    bounds: [
      Math.min(...longitudes),
      Math.min(...latitudes),
      Math.max(...longitudes),
      Math.max(...latitudes),
    ],
    start: coordinates[0].slice(0, 2),
    finish: coordinates.at(-1).slice(0, 2),
  },
  provenance: {
    status: 'edited',
    method: 'manual-crop',
    label: 'Activity route · travel before Westminster removed by Ashterism',
  },
}

console.log(
  `${id}: ${originalCoordinates.length} -> ${coordinates.length} points | ${(distanceM / 1000).toFixed(2)} km`,
)

if (!apply) {
  console.log('Dry run only; rerun with --apply to store the crop')
} else {
  writeJsonIfChanged(routeVersionPath(id, checksum), feature)
  writeCanonicalRecord(updatedRecord)
  console.log(`Stored original and cropped route versions for ${id}`)
}
