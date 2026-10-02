import {
  assertPublicValueIsSafe,
  assertSafeWalkId,
  loadCanonicalRecords,
  writeCanonicalRecord,
} from './lib/canonical-walks.js'

const [idArgument, ...nameParts] = process.argv.slice(2)
const id = assertSafeWalkId(idArgument ?? '')
const suppliedName = nameParts.join(' ').trim()

if (!suppliedName) {
  throw new Error(
    'Usage: npm run rename -- <walk-id> <new name> (use --clear to restore the provider name)',
  )
}

const record = loadCanonicalRecords().find((walk) => walk.id === id)
if (!record) throw new Error(`Unknown walk: ${id}`)

const name = suppliedName === '--clear' ? null : suppliedName
if (name && name.length > 200) {
  throw new Error('Walk names must be 200 characters or fewer')
}

const updated = {
  ...record,
  local: { ...record.local, name },
}

assertPublicValueIsSafe(updated)
writeCanonicalRecord(updated)
await import('./build-catalogue.js')

console.log(name ? `Renamed ${id} to “${name}”` : `Restored provider name for ${id}`)
