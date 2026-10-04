import crypto from 'node:crypto'
import fs from 'node:fs'
import { requestMediaJson, uploadMediaAsset, MEDIA_API_BASE_URL, PRIVATE_PHOTO_ROLE } from '../../src/media-publication.js'
import { readJson, resolvePublicFields, writeCanonicalRecord } from './canonical-walks.js'

const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const savePrivate = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export const reconciledPhoto = (candidateId, previous, asset) => {
  const status = asset.custom?.reviewStatus ?? 'unreviewed'
  if (!['unreviewed', 'keep', 'reject'].includes(status)) throw new Error('Invalid Media review status')
  if (asset.id !== previous.assetId) throw new Error('Media asset ID mismatch')
  const isPublic = status === 'keep' && asset.visibility === 'public' && !asset.requiredRoles?.length
  return {
    candidateId, ...previous,
    visibility: isPublic ? 'public' : 'private',
    reviewStatus: status,
    caption: asset.caption ?? '',
    rotation: asset.custom?.rotation ?? 0,
    alt: asset.alt ?? previous.alt,
  }
}

export const reconcilePhotoReviews = async ({
  walk, publicationPath, token, request = requestMediaJson, upload = uploadMediaAsset,
  writeWalk = writeCanonicalRecord,
}) => {
  const publication = readJson(publicationPath)
  if (publication.walkId !== walk.id) throw new Error('Publication ledger walk mismatch')
  const photos = []
  for (const [candidateId, previous] of Object.entries(publication.assets ?? {})) {
    const asset = await request(`/v1/assets/${previous.assetId}`, token)
    const photo = reconciledPhoto(candidateId, previous, asset)
    if (photo.visibility === 'public' && !asset.variants?.display) throw new Error('Approved public photo has no display variant')
    photos.push(photo)
  }
  if (!photos.length) return false
  photos.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)))
  const reviewFingerprint = fingerprint(photos)
  // Keep rejected assets in the protected manifest so editors can undo rejection.
  // The normal viewer hides them. Never put their archive paths in public photos.
  const manifest = { schemaVersion: 1, walkId: walk.id, photos: photos.filter(photo => photo.visibility !== 'public') }
  const manifestFingerprint = fingerprint(manifest)
  let manifestAssetId = publication.manifestAssetId
  if (manifestFingerprint !== publication.manifestFingerprint) {
    const asset = await upload({
      collectionId: publication.collectionId, token,
      filename: `${walk.id}-private-photos.json`,
      file: new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' }),
      metadata: {
        title: `${resolvePublicFields(walk).name} private photo manifest`,
        visibility: 'authenticated', requiredRoles: [PRIVATE_PHOTO_ROLE],
        tags: ['walk-photo', walk.id, 'manifest'],
        links: [{ siteId: 'ashterism-walks', objectType: 'walk-photo-manifest', objectId: walk.id }],
        custom: { walkId: walk.id, photoCount: manifest.photos.length, manifestFingerprint },
      },
    })
    manifestAssetId = asset.id
  }
  walk.local ??= {}
  walk.local.photos = photos.filter(photo => photo.visibility === 'public').map(photo => ({
    assetId: photo.assetId,
    url: `${MEDIA_API_BASE_URL}/v1/assets/${photo.assetId}/variants/display`,
    alt: photo.alt, capturedAt: photo.capturedAt,
    ...(photo.caption ? { caption: photo.caption } : {}),
    ...(photo.rotation ? { rotation: photo.rotation } : {}),
  }))
  walk.local.photoManifestAssetId = manifestAssetId
  // Write private state before the canonical file. Reconstruct the canonical
  // fields on every poll, so an interrupted write remains recoverable.
  publication.assets = Object.fromEntries(photos.map(({ candidateId, ...photo }) => [candidateId, photo]))
  Object.assign(publication, { manifestAssetId, manifestFingerprint, remoteReviewFingerprint: reviewFingerprint, updatedAt: new Date().toISOString() })
  savePrivate(publicationPath, publication)
  const reviewPath = publicationPath.replace(/\.publication\.json$/, '.json')
  const review = fs.existsSync(reviewPath) ? readJson(reviewPath) : { schemaVersion: 1, walkId: walk.id, decisions: {} }
  for (const photo of photos) review.decisions[photo.candidateId] = {
    ...review.decisions[photo.candidateId], archiveRelativePath: photo.archiveRelativePath,
    capturedAt: photo.capturedAt, status: photo.reviewStatus,
    visibility: photo.visibility, rotation: photo.rotation, caption: photo.caption,
  }
  review.updatedAt = new Date().toISOString()
  savePrivate(reviewPath, review)
  return writeWalk(walk)
}
