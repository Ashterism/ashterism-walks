import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { preparePhotoCandidates } from './lib/prepare-photo-candidates.js'
import { preparePhotoPublication } from './lib/prepare-photo-publication.js'
import { mediaServiceToken } from './lib/media-service-token.js'

const inputs = process.argv.slice(2)
const walkId = inputs.find((input) => !input.startsWith('--'))
const option = (name, fallback) => {
  const index = inputs.indexOf(name)
  return index === -1 ? fallback : inputs[index + 1]
}

if (!walkId) {
  throw new Error(
    'Usage: npm run photos:prepare -- <walk-id> [--archive <path>] [--state-dir <path>]',
  )
}

const result = preparePhotoCandidates({
  walkId,
  archiveRoot: option('--archive', '/Volumes/photo/Photos'),
})

console.log(`${result.candidates.length} photo candidates found for ${result.walkName}`)
const prepared = await preparePhotoPublication({
  ...result,
  walkId,
  token: process.env.ASHTERIX_MEDIA_TOKEN ?? await mediaServiceToken(),
  mediaBaseUrl: process.env.ASHTERIX_MEDIA_BASE_URL,
  privateDirectory: path.resolve(option('--state-dir', 'private/photo-reviews')),
  onProgress: (message) => console.log(`${message}…`),
})

execFileSync(process.execPath, ['scripts/build-catalogue.js'], { stdio: 'inherit' })
console.log(
  `Prepared ${prepared.manifest.photos.length} private/unreviewed photographs ` +
  `(${prepared.uploaded} uploaded, ${prepared.reused} reused).`,
)
console.log(`Protected manifest: ${prepared.publication.manifestAssetId}`)
