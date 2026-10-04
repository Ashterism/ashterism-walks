import assert from 'node:assert/strict'
import test from 'node:test'
import { canReviewPhotos, reviewPatchFor, savePhotoReview } from '../src/photo-review.js'

const asset = { id: 'asset-1', tags: ['walk-photo', '123', 'login-only'], custom: { candidateId: 'candidate', rotation: 90, reviewStatus: 'unreviewed' } }
test('only Media editor/admin roles enable review; viewing alone does not', () => {
  assert.equal(canReviewPhotos(['walks.private_photos', 'admin']), false)
  assert.equal(canReviewPhotos(['media.editor']), true)
  assert.equal(canReviewPhotos(['media.admin']), true)
})
test('public approval removes private roles; private/rejected decisions never expose images', () => {
  const publicPatch = reviewPatchFor(asset, { status: 'keep', visibility: 'public' })
  assert.equal(publicPatch.visibility, 'public')
  assert.deepEqual(publicPatch.requiredRoles, [])
  assert.equal(publicPatch.custom.candidateId, 'candidate')
  assert.equal(publicPatch.custom.rotation, 90)
  assert.deepEqual(publicPatch.tags, ['walk-photo', '123', 'public'])
  for (const change of [{ status: 'keep', visibility: 'private' }, { status: 'reject', visibility: 'public' }]) {
    const patch = reviewPatchFor(asset, change)
    assert.equal(patch.visibility, 'authenticated')
    assert.deepEqual(patch.requiredRoles, ['walks.private_photos'])
    assert.equal(patch.custom.reviewStatus, change.status)
  }
  assert.throws(() => reviewPatchFor(asset, { status: 'delete', visibility: 'public' }))
})
test('review persistence uses existing asset and server-enforced writer endpoint', async () => {
  let saved
  await savePhotoReview({
    photo: { assetId: 'asset-1' }, change: { status: 'reject', visibility: 'private' }, token: 'writer',
    request: async (path, token) => { assert.equal(path, '/v1/assets/asset-1'); assert.equal(token, 'writer'); return asset },
    patch: async input => { saved = input; return input.metadata },
  })
  assert.equal(saved.assetId, 'asset-1')
  assert.equal(saved.metadata.custom.reviewStatus, 'reject')
  await assert.rejects(savePhotoReview({ photo: {}, change: {}, token: null }), /Sign in/)
  await assert.rejects(savePhotoReview({ photo: { assetId: 'asset-1' }, change: { status: 'keep', visibility: 'public' }, token: 'viewer', request: async () => asset, patch: async () => { throw new Error('403 writer role required') } }), /403/)
})
