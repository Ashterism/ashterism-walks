import assert from 'node:assert/strict'
import test from 'node:test'

import { fingerprintBuildInputs, getBuildInputs, matchesPublication } from '../scripts/publication-revision.js'

test('publication fingerprint is deterministic and follows only Vite build inputs', () => {
  const first = getBuildInputs()
  assert.ok(first.some(({ path }) => path === 'src/main.js'))
  assert.ok(first.some(({ path }) => path === 'public/data/walks.json'))
  assert.ok(!first.some(({ path }) => path.startsWith('data/')))
  assert.ok(!first.some(({ path }) => path.startsWith('.github/')))
  assert.equal(fingerprintBuildInputs([...first]), fingerprintBuildInputs([...first].reverse()))
})

test('publication fingerprint changes when a public build input changes', () => {
  const initial = [{ path: 'src/main.js', object: 'a' }]
  assert.notEqual(
    fingerprintBuildInputs(initial),
    fingerprintBuildInputs([{ path: 'src/main.js', object: 'b' }]),
  )
})

test('only a valid live marker for the exact input fingerprint confirms publication', () => {
  const fingerprint = 'a'.repeat(64)
  const marker = JSON.stringify({ version: 1, buildInputsFingerprint: fingerprint, builtCommit: 'b'.repeat(40) })
  assert.equal(matchesPublication(marker, fingerprint), true)
  assert.equal(matchesPublication(marker, 'c'.repeat(64)), false)
  assert.equal(matchesPublication('{invalid', fingerprint), false)
  assert.equal(matchesPublication(JSON.stringify({ version: 2, buildInputsFingerprint: fingerprint, builtCommit: 'b'.repeat(40) }), fingerprint), false)
  assert.equal(matchesPublication(JSON.stringify({ version: 1, buildInputsFingerprint: fingerprint, builtCommit: 'invalid' }), fingerprint), false)
  assert.equal(matchesPublication('', fingerprint), false)
})
