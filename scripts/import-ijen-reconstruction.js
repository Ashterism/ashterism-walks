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
const inputs = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))

if (inputs.length !== 1) {
  throw new Error(
    'Usage: node scripts/import-ijen-reconstruction.js /path/to/ijen-osm.xml [--apply]',
  )
}

const osmPath = fs.realpathSync(path.resolve(inputs[0]))
const xml = fs.readFileSync(osmPath, 'utf8')
const id = 'withings-202508110129'
const osmWays = {
  main: { id: '488089675', name: 'Track to Kawah Ijen Crater' },
  crater: { id: '47504584', name: 'Blue Fire Trek' },
  sunrise: { id: '220191413', name: 'Sunrise View Trek' },
}
const timelineSunriseAnchor = [114.246519, -8.054384]

const nodes = new Map()
for (const match of xml.matchAll(
  /<node id="(\d+)"[^>]* lat="([-\d.]+)" lon="([-\d.]+)"(?:\s*\/>|>[\s\S]*?<\/node>)/g,
)) {
  nodes.set(match[1], [Number(match[3]), Number(match[2])])
}

const ways = new Map()
for (const match of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
  const wayId = match[1]
  if (!Object.values(osmWays).some((way) => way.id === wayId)) continue
  const references = [...match[2].matchAll(/<nd ref="(\d+)"/g)]
    .map((reference) => reference[1])
  const coordinates = references.map((reference) => nodes.get(reference))
  if (coordinates.some((coordinate) => !coordinate)) {
    throw new Error(`OpenStreetMap way ${wayId} refers to a missing node`)
  }
  ways.set(wayId, coordinates)
}

for (const way of Object.values(osmWays)) {
  if (!ways.has(way.id)) {
    throw new Error(`OpenStreetMap way ${way.id} (${way.name}) was not found`)
  }
}

const distanceBetween = (first, second) => {
  const radians = Math.PI / 180
  const latitudeDelta = (second[1] - first[1]) * radians
  const longitudeDelta = (second[0] - first[0]) * radians
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(first[1] * radians) *
      Math.cos(second[1] * radians) *
      Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.asin(Math.sqrt(haversine))
}

const mainTrail = ways.get(osmWays.main.id)
const craterTrail = ways.get(osmWays.crater.id)
const sunriseTrailFromJunction = [...ways.get(osmWays.sunrise.id)].reverse()
const sunriseAnchorIndex = sunriseTrailFromJunction.reduce(
  (bestIndex, coordinate, index, coordinates) =>
    distanceBetween(coordinate, timelineSunriseAnchor) <
    distanceBetween(coordinates[bestIndex], timelineSunriseAnchor)
      ? index
      : bestIndex,
  0,
)
const sunriseTrail = sunriseTrailFromJunction.slice(0, sunriseAnchorIndex + 1)

const appendWithoutDuplicate = (target, addition) => {
  const first = addition[0]
  const last = target.at(-1)
  target.push(
    ...(last && first && last[0] === first[0] && last[1] === first[1]
      ? addition.slice(1)
      : addition),
  )
}

const coordinates = [...mainTrail]
appendWithoutDuplicate(coordinates, craterTrail)
appendWithoutDuplicate(coordinates, [...craterTrail].reverse())
appendWithoutDuplicate(coordinates, sunriseTrail)
appendWithoutDuplicate(coordinates, [...sunriseTrail].reverse())
appendWithoutDuplicate(coordinates, [...mainTrail].reverse())

const routeDistanceM = coordinates.slice(1).reduce(
  (total, coordinate, index) =>
    total + distanceBetween(coordinates[index], coordinate),
  0,
)
const longitudes = coordinates.map((coordinate) => coordinate[0])
const latitudes = coordinates.map((coordinate) => coordinate[1])
const bounds = [
  Math.min(...longitudes),
  Math.min(...latitudes),
  Math.max(...longitudes),
  Math.max(...latitudes),
]
const feature = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates },
}
const checksum = sha256(`${JSON.stringify(feature, null, 2)}\n`)
const existing = loadCanonicalRecords().find((record) => record.id === id)
const capturedAt = existing?.route?.versions?.find(
  (version) => version.checksum === checksum,
)?.capturedAt ?? new Date().toISOString()
const versions = [...(existing?.route?.versions ?? [])]
if (!versions.some((version) => version.checksum === checksum)) {
  versions.push({
    checksum,
    source: 'openstreetmap-reconstruction',
    capturedAt,
  })
}

const record = {
  schemaVersion: 1,
  id,
  local: {
    name: 'Mount Ijen',
    activityType: 'Hike',
    date: '2025-08-11',
    visibility: 'public',
    photos: existing?.local?.photos ?? [],
    notes:
      'Night hike from Paltuding up Mount Ijen, down into the crater for the blue fire, back to the rim and along to a sunrise viewpoint, then down to Paltuding. The route is reconstructed from private watch and Timeline evidence using mapped trail geometry.',
    references: [
      {
        label: 'Mount Ijen trail map — OpenStreetMap',
        url: 'https://www.openstreetmap.org/#map=15/-8.0612/114.2384',
      },
      {
        label: 'OpenStreetMap copyright and licence',
        url: 'https://www.openstreetmap.org/copyright',
      },
    ],
    metrics: {
      distanceM: Math.round(routeDistanceM),
      movingTimeSeconds: 14032,
      elapsedTimeSeconds: 20305,
      ascentM: 547,
      descentM: 583,
    },
  },
  sources: {
    companionWithings: {
      status: 'private-source-reviewed',
      snapshot: {
        name: 'Mount Ijen',
        type: 'Hike',
        startDate: '2025-08-10T18:29:20.000Z',
        startDateLocal: '2025-08-11T01:29:20+07:00',
        recordedActivityStartDate: '2025-08-10T19:40:04.000Z',
        recordedActivityEndDate: '2025-08-11T00:07:45.000Z',
        distanceM: 9902.52734375,
        movingTimeSeconds: 12120,
        elapsedTimeSeconds: 16061,
        steps: 13814,
        recordedGpsPointCount: 2256,
        denseGpsPointCount: 2255,
        denseGpsLineDistanceM: 2578,
      },
    },
    garminMonitoring: {
      status: 'archived-in-private-garmin-export',
      snapshot: {
        startDate: '2025-08-10T18:29:20.000Z',
        endDate: '2025-08-11T00:07:45.000Z',
        steps: 18226,
        stepDistanceEstimateM: 14761,
        movingTimeSeconds: 14032,
        elapsedTimeSeconds: 20305,
        ascentM: 547,
        descentM: 583,
        maximumHeartRate: 170,
      },
    },
    googleTimeline: {
      status: 'archived',
      archivedFilename: 'location-history.json',
      snapshot: {
        visitStartDate: '2025-08-10T18:29:20.653Z',
        visitEndDate: '2025-08-10T22:40:31.002Z',
        sunriseAnchorPointCount: 6,
        sunriseAnchor: timelineSunriseAnchor,
      },
    },
    openStreetMap: {
      status: 'reference',
      sourceRetrievedDate: '2026-08-30',
      licence: 'Open Database License',
      ways: Object.values(osmWays),
      snapshot: {
        pointCount: coordinates.length,
        routeDistanceM: Math.round(routeDistanceM),
        sunriseAnchorDifferenceM: Math.round(
          distanceBetween(sunriseTrail.at(-1), timelineSunriseAnchor),
        ),
      },
    },
  },
  route: {
    activeVersion: checksum,
    source: 'openstreetmap-reconstruction',
    status: 'estimated',
    versions,
    bounds,
    start: coordinates[0],
    finish: coordinates.at(-1),
    ascentM: 547,
    descentM: 583,
  },
  review: [],
  provenance: {
    status: 'estimated',
    method:
      'companion-withings-garmin-monitoring-google-timeline-openstreetmap',
    metricsSource: 'Garmin monitoring and reconstructed trail geometry',
    routeSource:
      'OpenStreetMap GPS-surveyed trails anchored by companion Withings GPS and Google Timeline',
    label:
      'Estimated route reconstructed from companion Withings GPS, Garmin monitoring, Google Timeline and OpenStreetMap trail geometry.',
  },
}

if (apply) {
  writeJsonIfChanged(routeVersionPath(id, checksum), feature)
  writeCanonicalRecord(record)
  await import('./build-catalogue.js')
}

console.log(
  `${apply ? 'Imported' : 'Would import'} ${id}: ${(routeDistanceM / 1000).toFixed(2)} km, ${coordinates.length} route points`,
)
if (!apply) console.log('Dry run only; rerun with --apply to write the reconstruction')
