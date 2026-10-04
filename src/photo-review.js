import { patchMediaAsset, requestMediaJson, PRIVATE_PHOTO_ROLE } from './media-publication.js'

export const canReviewPhotos = (roles = []) =>
  roles.includes('media.admin') || roles.includes('media.editor')

export const photoFromAsset = (photo, asset) => ({
  ...photo,
  caption: asset.caption ?? '',
  rotation: asset.custom?.rotation ?? 0,
  reviewStatus: asset.custom?.reviewStatus ?? 'unreviewed',
  visibility: asset.visibility === 'public' ? 'public' : 'private',
})

export const reviewPatchFor = (asset, change) => {
  if (!['keep', 'reject'].includes(change.status) || !['public', 'private'].includes(change.visibility)) {
    throw new Error('Invalid photo review decision')
  }
  const isPublic = change.status === 'keep' && change.visibility === 'public'
  return {
    visibility: isPublic ? 'public' : 'authenticated',
    requiredRoles: isPublic ? [] : [PRIVATE_PHOTO_ROLE],
    tags: [...(asset.tags ?? []).filter(tag => !['public', 'login-only'].includes(tag)), isPublic ? 'public' : 'login-only'],
    custom: { ...asset.custom, reviewStatus: change.status, reviewedAt: new Date().toISOString() },
  }
}

export const savePhotoReview = async ({ photo, change, token, request = requestMediaJson, patch = patchMediaAsset }) => {
  if (!token) throw new Error('Sign in before reviewing photographs')
  const asset = await request(`/v1/assets/${photo.assetId}`, token)
  // Media enforces its write roles; UI visibility is not the security boundary.
  return patch({ assetId: photo.assetId, metadata: reviewPatchFor(asset, change), token })
}
