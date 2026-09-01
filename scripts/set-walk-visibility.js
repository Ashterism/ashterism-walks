import fs from 'node:fs'

import {
  assertSafeWalkId,
  loadCanonicalRecords,
  publicRoutePath,
  writeCanonicalRecord,
} from './lib/canonical-walks.js'

const [idArgument, visibility] = process.argv.slice(2)
const id = assertSafeWalkId(idArgument ?? '')

if (!['public', 'hidden'].includes(visibility)) {
  throw new Error('Usage: npm run visibility -- <walk-id> <public|hidden>')
}

const record = loadCanonicalRecords().find((walk) => walk.id === id)
if (!record) throw new Error(`Unknown walk: ${id}`)

writeCanonicalRecord({
  ...record,
  local: { ...record.local, visibility },
})

if (visibility === 'hidden') {
  fs.rmSync(publicRoutePath(id), { force: true })
}

await import('./build-catalogue.js')

console.log(`${id} is now ${visibility}`)
