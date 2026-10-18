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

test('discovers late photo candidates without replacing prior assets or review decisions', async (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-photo-retry-'))
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
    requests.push({ type: 'upload', ...request })
    return { id: uuidFor(nextId++), alt: request.metadata.alt }
  }
  const patchAsset = async (request) => {
    requests.push({ type: 'patch', ...request })
    return { id: request.assetId, alt: request.metadata.alt }
  }
  const writeWalks = []
  let savedWalk = { id: '24755894108', local: { photos: [] } }
  const writeWalk = (walk) => {
    const changed = JSON.stringify(savedWalk) !== JSON.stringify(walk)
    savedWalk = structuredClone(walk)
    writeWalks.push(changed)
    return changed
  }
  const privateDirectory = path.join(temporary, 'existing-publication-ledger')
  const walkId = savedWalk.id
  const candidates = Array.from({ length: 43 }, (_, index) => ({
    id: `candidate-${String(index + 1).padStart(2, '0')}`,
    archiveRelativePath: `2026/10/photo-${index + 1}.jpg`,
    mediaPath,
    capturedAtIso: new Date(Date.parse('2026-10-17T10:00:00Z') + index * 60_000).toISOString(),
    extension: '.jpg',
  }))
  const prepare = (walk, foundCandidates) => preparePhotoPublication({
    walkId,
    walkName: 'Bussière-Galant',
    walk,
    candidates: foundCandidates,
    token: 'editor-token',
    mediaBaseUrl: 'https://media.example.test',
    privateDirectory,
    writeWalk,
    createCollection,
    uploadAsset,
    patchAsset,
  })

  const first = await prepare(structuredClone(savedWalk), candidates.slice(0, 5))
  assert.equal(first.uploaded, 5)

  const reviewPath = path.join(privateDirectory, `${walkId}.json`)
  const publicationPath = path.join(privateDirectory, `${walkId}.publication.json`)
  const review = {
    schemaVersion: 1,
    walkId,
    decisions: {
      [candidates[0].id]: { status: 'keep', visibility: 'public', caption: 'Public choice', rotation: 0 },
      [candidates[1].id]: { status: 'keep', visibility: 'private', caption: 'Private choice', rotation: 0 },
      [candidates[2].id]: { status: 'reject', visibility: 'private', caption: '', rotation: 0 },
    },
  }
  fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`)
  const publication = JSON.parse(fs.readFileSync(publicationPath, 'utf8'))
  publication.assets[candidates[0].id] = { ...publication.assets[candidates[0].id], reviewStatus: 'keep', visibility: 'public', caption: 'Public choice' }
  publication.assets[candidates[1].id] = { ...publication.assets[candidates[1].id], reviewStatus: 'keep', visibility: 'private', caption: 'Private choice' }
  publication.assets[candidates[2].id] = { ...publication.assets[candidates[2].id], reviewStatus: 'reject', visibility: 'private' }
  fs.writeFileSync(publicationPath, `${JSON.stringify(publication, null, 2)}\n`)
  const priorAssets = structuredClone(publication.assets)
  const photoUploadsBefore = requests.filter(request => request.type === 'upload' && request.metadata.custom?.candidateId).length

  const second = await prepare(structuredClone(savedWalk), candidates)
  const photoUploadsAfter = requests.filter(request => request.type === 'upload' && request.metadata.custom?.candidateId).length
  assert.equal(second.uploaded, 38)
  assert.equal(second.updated, 0)
  assert.equal(requests.some(request => request.type === 'patch'), false, 'existing Media decisions are never overwritten by a stale ledger')
  assert.equal(photoUploadsAfter - photoUploadsBefore, 38)
  assert.deepEqual(second.manifest.photos.map(photo => photo.candidateId).includes(candidates[0].id), false)
  assert.ok(second.manifest.photos.some(photo => photo.candidateId === candidates[1].id && photo.reviewStatus === 'keep'))
  assert.ok(!second.manifest.photos.some(photo => photo.candidateId === candidates[2].id))
  const afterExpansion = JSON.parse(fs.readFileSync(publicationPath, 'utf8'))
  for (const candidate of candidates.slice(0, 3)) {
    assert.deepEqual(afterExpansion.assets[candidate.id], priorAssets[candidate.id])
  }

  const beforeRepeatRequests = requests.length
  const beforeRepeatPublication = fs.readFileSync(publicationPath, 'utf8')
  const beforeRepeatReview = fs.readFileSync(reviewPath, 'utf8')
  const third = await prepare(structuredClone(savedWalk), candidates)
  assert.equal(third.uploaded, 0)
  assert.equal(third.updated, 0)
  assert.equal(third.walkChanged, false)
  assert.equal(requests.length, beforeRepeatRequests)
  assert.equal(fs.readFileSync(publicationPath, 'utf8'), beforeRepeatPublication)
  assert.equal(fs.readFileSync(reviewPath, 'utf8'), beforeRepeatReview)
  assert.equal(writeWalks.at(-1), false)
})
