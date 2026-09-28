import path from 'node:path'

import {
  assertSafeWalkId,
  readJson,
  writeCanonicalRecord,
} from './lib/canonical-walks.js'

const inputs = process.argv.slice(2)
const walkIndex = inputs.indexOf('--walk')
const walkId = assertSafeWalkId(walkIndex === -1 ? 'photo-20220417' : inputs[walkIndex + 1])
const review = readJson(path.join('private/photo-reviews', `${walkId}.json`))
const publication = readJson(path.join('private/photo-reviews', `${walkId}.publication.json`))
const record = readJson(path.join('data/walks', `${walkId}.json`))

const kept = Object.entries(review.decisions)
  .filter(([, decision]) => decision.status === 'keep')
  .sort(([, first], [, second]) => first.capturedAt.localeCompare(second.capturedAt))

const missing = kept.filter(([id]) => !publication.assets?.[id])
if (missing.length) throw new Error(`${missing.length} approved photographs have not been uploaded`)
if (!publication.manifestAssetId) throw new Error('The protected photo manifest has not been uploaded')

record.local.photos = kept
  .filter(([, decision]) => decision.visibility === 'public')
  .map(([id, decision]) => {
    const asset = publication.assets[id]
    return {
      assetId: asset.assetId,
      url: `https://media.ashterism.com/v1/assets/${asset.assetId}/variants/display`,
      alt: asset.alt,
      ...(decision.caption ? { caption: decision.caption } : {}),
      capturedAt: decision.capturedAt,
    }
  })
record.local.photoManifestAssetId = publication.manifestAssetId

writeCanonicalRecord(record)
console.log(`Published ${record.local.photos.length} public photographs and a protected manifest for ${walkId}`)
