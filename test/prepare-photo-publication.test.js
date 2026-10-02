import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { preparePhotoPublication } from '../scripts/lib/prepare-photo-publication.js'

const uuidFor = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`

test('prepares private candidates once and reuses their publication on rerun', async (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-photo-publication-'))
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const mediaPath = path.join(temporary, 'source.jpg')
  fs.writeFileSync(mediaPath, 'photograph')

  const requests = []
  let nextId = 1
  const createCollection = async (request) => {
    requests.push({ type: 'collection', ...request })
    return { id: uuidFor(nextId++) }
  }
  const uploadAsset = async (request) => {
    requests.push({ type: 'asset', ...request })
    return {
      id: uuidFor(nextId++),
      alt: request.metadata.alt,
    }
  }

  const walk = { id: 'intervals-1', local: { photos: [] } }
  const candidate = {
    id: 'candidate-1',
    archiveRelativePath: '2026/09/source.jpg',
    mediaPath,
    capturedAtIso: '2026-09-30T12:00:00.000Z',
    extension: '.jpg',
  }
  const writtenWalks = []
  const options = {
    walkId: walk.id,
    walkName: 'Test walk',
    walk,
    candidates: [candidate],
    token: 'editor-token',
    mediaBaseUrl: 'https://media.example.test',
    privateDirectory: path.join(temporary, 'state'),
    writeWalk: (value) => { writtenWalks.push(structuredClone(value)); return true },
    createCollection,
    uploadAsset,
  }

  const first = await preparePhotoPublication(options)
  const second = await preparePhotoPublication(options)

  assert.equal(first.uploaded, 1)
  assert.equal(second.uploaded, 0)
  assert.equal(second.reused, 1)
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map(({ type }) => type), ['collection', 'asset', 'asset'])
  assert.ok(requests.every(({ token }) => token === 'editor-token'))
  assert.equal(requests[1].collectionId, uuidFor(1))
  assert.equal(requests[1].metadata.visibility, 'authenticated')
  assert.equal(requests[1].metadata.custom.reviewStatus, 'unreviewed')
  assert.equal(requests[1].metadata.custom.archiveRelativePath, '2026/09/source.jpg')
  assert.equal(first.manifest.photos[0].archiveRelativePath, '2026/09/source.jpg')
  assert.equal(first.manifest.photos[0].reviewStatus, 'unreviewed')
  assert.deepEqual(writtenWalks.at(-1).local.photos, [])
  assert.equal(writtenWalks.at(-1).local.photoManifestAssetId, uuidFor(3))

  const saved = JSON.parse(fs.readFileSync(
    path.join(temporary, 'state', `${walk.id}.publication.json`),
    'utf8',
  ))
  assert.equal(saved.assets[candidate.id].archiveRelativePath, '2026/09/source.jpg')
  assert.doesNotMatch(JSON.stringify(saved), /\/Volumes\//)
})
