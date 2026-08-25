import fs from 'node:fs'

import {
  loadCanonicalRecords,
  publicRoutePath,
  readJson,
  routeVersionPath,
  sha256,
  writeCanonicalRecord,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const manifest = readJson('private/garmin/manifest.json')
const overrides = readJson('scripts/intervals-activity-overrides.json')

if (loadCanonicalRecords().length > 0) {
  throw new Error('Canonical walk records already exist')
}

for (const activity of manifest.activities) {
  const id = String(activity.id)
  const publicPath = publicRoutePath(id)
  let route = null

  if (fs.existsSync(publicPath)) {
    const routeText = fs.readFileSync(publicPath, 'utf8')
    const routeGeoJson = JSON.parse(routeText)
    const canonicalRouteText = `${JSON.stringify(routeGeoJson, null, 2)}\n`
    const checksum = sha256(canonicalRouteText)
    writeJsonIfChanged(
      routeVersionPath(id, checksum),
      routeGeoJson,
    )

    route = {
      activeVersion: checksum,
      source: 'intervals',
      status: 'current',
      versions: [
        {
          checksum,
          source: 'intervals',
          capturedAt: null,
        },
      ],
      bounds: [],
      start: routeGeoJson.geometry.coordinates[0].slice(0, 2),
      finish:
        routeGeoJson.geometry.coordinates.at(-1).slice(0, 2),
      descentM: routeGeoJson.properties.descentM ?? null,
    }

    const longitudes = routeGeoJson.geometry.coordinates.map(
      (coordinate) => coordinate[0],
    )
    const latitudes = routeGeoJson.geometry.coordinates.map(
      (coordinate) => coordinate[1],
    )
    route.bounds = [
      Math.min(...longitudes),
      Math.min(...latitudes),
      Math.max(...longitudes),
      Math.max(...latitudes),
    ]
  }

  const intervalsActivityId = String(activity.intervalsActivityId)
  const overriddenType = overrides[intervalsActivityId]?.type ?? null
  const record = {
    schemaVersion: 1,
    id,
    local: {
      name: null,
      activityType: overriddenType,
      visibility: 'public',
    },
    sources: {
      garmin: /^\d+$/.test(id) ? { activityId: id } : null,
      intervals: {
        activityId: intervalsActivityId,
        status: 'active',
        statusChangedAt: null,
        fingerprint: null,
        snapshot: {
          name: activity.name ?? null,
          type: activity.type,
          startDate: activity.startDate,
          startDateLocal: null,
          distanceM: activity.distanceM,
          movingTimeSeconds: activity.movingTimeSeconds,
          elapsedTimeSeconds: activity.elapsedTimeSeconds,
          ascentM: activity.ascentM,
          source: activity.source,
        },
      },
    },
    route,
    review: route ? [] : ['route-unavailable'],
  }

  writeCanonicalRecord(record)
}

console.log(`Migrated ${manifest.activities.length} canonical walk records`)
