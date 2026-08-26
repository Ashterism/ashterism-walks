import {
  assertPublicValueIsSafe,
  assertSafeWalkId,
  loadCanonicalRecords,
  writeCanonicalRecord,
} from './lib/canonical-walks.js'

const [idArgument, ...noteParts] = process.argv.slice(2)
const id = assertSafeWalkId(idArgument ?? '')
const suppliedNotes = noteParts.join(' ').trim()

if (!suppliedNotes) {
  throw new Error(
    'Usage: npm run notes -- <walk-id> <notes> (use --clear to remove notes)',
  )
}

const record = loadCanonicalRecords().find((walk) => walk.id === id)
if (!record) throw new Error(`Unknown walk: ${id}`)

const notes = suppliedNotes === '--clear' ? null : suppliedNotes
if (notes && notes.length > 2000) {
  throw new Error('Walk notes must be 2,000 characters or fewer')
}

const updated = {
  ...record,
  local: { ...record.local, notes },
}

assertPublicValueIsSafe(updated)
writeCanonicalRecord(updated)
await import('./build-catalogue.js')

console.log(notes ? `Updated notes for ${id}` : `Removed notes from ${id}`)
