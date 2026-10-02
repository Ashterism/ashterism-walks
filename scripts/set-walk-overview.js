import {
  assertSafeWalkId,
  loadCanonicalRecords,
  writeCanonicalRecord,
} from './lib/canonical-walks.js'

const [idArgument, setting] = process.argv.slice(2)

if (!idArgument || !['include', 'exclude'].includes(setting)) {
  throw new Error(
    'Usage: node scripts/set-walk-overview.js <walk-id> <include|exclude>',
  )
}

const id = assertSafeWalkId(idArgument)
const record = loadCanonicalRecords().find((candidate) => candidate.id === id)

if (!record) throw new Error(`Walk not found: ${id}`)

const local = { ...record.local }
if (setting === 'exclude') local.includeInOverview = false
else delete local.includeInOverview

writeCanonicalRecord({ ...record, local })
console.log(`${id}: ${setting} in overview bounds`)
