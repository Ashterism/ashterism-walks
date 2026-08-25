import fs from 'node:fs'

import {
  assertPublicValueIsSafe,
  loadCanonicalRecords,
  publicCataloguePath,
  publicRoutePath,
  readJson,
  resolvePublicFields,
  routeVersionPath,
  writeJsonIfChanged,
} from './lib/canonical-walks.js'

const walks = []
let skippedWithoutRoute = 0

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
  const properties = resolvePublicFields(record)
  const publicRoute = {
    ...storedRoute,
    properties,
  }

  assertPublicValueIsSafe(publicRoute)
  writeJsonIfChanged(publicRoutePath(record.id), publicRoute)

  walks.push({
    ...properties,
    photos: record.local.photos ?? [],
    routeUrl: `/data/routes/${record.id}.geojson`,
    bounds: record.route.bounds,
    start: record.route.start,
    finish: record.route.finish,
  })
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

console.log(`Published routes: ${walks.length}`)
console.log(`Activities without a route: ${skippedWithoutRoute}`)
