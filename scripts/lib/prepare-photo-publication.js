import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  createMediaCollection,
  MEDIA_API_BASE_URL,
  patchMediaAsset,
  PRIVATE_PHOTO_ROLE,
  uploadMediaAsset,
} from '../../src/media-publication.js'
import {
  readJson,
  writeCanonicalRecord,
} from './canonical-walks.js'

const mediaTypeFor = (extension) => ({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
})[extension] ?? 'application/octet-stream'

const readOptionalJson = (filePath, fallback) =>
  fs.existsSync(filePath) ? readJson(filePath) : fallback

const writePrivateJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

const defaultDecision = (candidate) => ({
  archiveRelativePath: candidate.archiveRelativePath,
  capturedAt: candidate.capturedAtIso,
  status: 'unreviewed',
  visibility: 'private',
  rotation: 0,
  caption: '',
})

const assetMetadata = ({ walkId, walkName, candidate, decision, index }) => {
  const isPublic = decision.status === 'keep' && decision.visibility === 'public'
  return {
    title: `${walkName} — photograph ${index + 1}`,
    alt: `Photograph ${index + 1} from ${walkName}`,
    caption: decision.caption,
    visibility: isPublic ? 'public' : 'authenticated',
    requiredRoles: isPublic ? [] : [PRIVATE_PHOTO_ROLE],
    tags: ['walk-photo', walkId, isPublic ? 'public' : 'login-only'],
    links: [{ siteId: 'ashterism-walks', objectType: 'walk', objectId: walkId }],
    custom: {
      candidateId: candidate.id,
      archiveRelativePath: candidate.archiveRelativePath,
      capturedAt: candidate.capturedAtIso,
      reviewStatus: decision.status,
      rotation: decision.rotation ?? 0,
    },
  }
}

const publicationRecord = ({ asset, candidate, decision, metadata }) => ({
  assetId: asset.id,
  visibility: metadata.visibility === 'public' ? 'public' : 'private',
  capturedAt: candidate.capturedAtIso,
  caption: decision.caption,
  alt: asset.alt ?? metadata.alt,
  reviewStatus: decision.status,
  rotation: decision.rotation ?? 0,
  archiveRelativePath: candidate.archiveRelativePath,
})

const recordNeedsPatch = (record, decision, metadata) =>
  record.visibility !== (metadata.visibility === 'public' ? 'public' : 'private') ||
  record.reviewStatus !== decision.status ||
  record.caption !== decision.caption ||
  record.rotation !== (decision.rotation ?? 0) ||
  record.alt !== metadata.alt ||
  record.archiveRelativePath !== metadata.custom.archiveRelativePath

const manifestPayload = ({ walkId, candidates, decisions, assets }) => ({
  schemaVersion: 1,
  walkId,
  photos: candidates
    .filter((candidate) => {
      const decision = decisions[candidate.id]
      return decision.status !== 'reject' &&
        !(decision.status === 'keep' && decision.visibility === 'public')
    })
    .map((candidate) => ({
      candidateId: candidate.id,
      ...assets[candidate.id],
    })),
})

const fingerprintFor = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

export const preparePhotoPublication = async ({
  walkId,
  walkName,
  walk,
  candidates,
  token,
  mediaBaseUrl = MEDIA_API_BASE_URL,
  privateDirectory = path.resolve('private/photo-reviews'),
  onProgress = () => {},
  writeWalk = writeCanonicalRecord,
  createCollection = createMediaCollection,
  uploadAsset = uploadMediaAsset,
  patchAsset = patchMediaAsset,
}) => {
  if (!token) {
    throw new Error(
      'Set ASHTERIX_MEDIA_TOKEN to a current Media editor/admin access token',
    )
  }

  const reviewPath = path.join(privateDirectory, `${walkId}.json`)
  const publicationPath = path.join(privateDirectory, `${walkId}.publication.json`)
  const review = readOptionalJson(reviewPath, { decisions: {} })
  const publication = readOptionalJson(publicationPath, {
    schemaVersion: 2,
    walkId,
    collectionId: null,
    manifestAssetId: null,
    manifestFingerprint: null,
    updatedAt: null,
    assets: {},
  })
  publication.schemaVersion = 2
  publication.assets ??= {}

  const decisions = Object.fromEntries(candidates.map((candidate) => [
    candidate.id,
    review.decisions?.[candidate.id] ?? defaultDecision(candidate),
  ]))
  const included = candidates.filter(
    (candidate) => decisions[candidate.id].status !== 'reject',
  )

  const savePublication = () => {
    publication.updatedAt = new Date().toISOString()
    writePrivateJson(publicationPath, publication)
  }

  if (!publication.collectionId) {
    onProgress('Creating the walk photo collection')
    const collection = await createCollection({
      title: `${walkName} photographs`,
      description: `Photographs linked to ${walkId}.`,
      token,
      baseUrl: mediaBaseUrl,
    })
    publication.collectionId = collection.id
    savePublication()
  }

  let uploaded = 0
  let updated = 0
  for (const [index, candidate] of included.entries()) {
    const decision = decisions[candidate.id]
    const metadata = assetMetadata({ walkId, walkName, candidate, decision, index })
    const existing = publication.assets[candidate.id]

    if (!existing) {
      onProgress(`Uploading photograph ${index + 1} of ${included.length}`)
      const contents = fs.readFileSync(candidate.mediaPath)
      const file = new Blob([contents], { type: mediaTypeFor(candidate.extension) })
      const asset = await uploadAsset({
        collectionId: publication.collectionId,
        file,
        filename: `${walkId}-${candidate.id}${candidate.extension}`,
        metadata,
        token,
        baseUrl: mediaBaseUrl,
      })
      publication.assets[candidate.id] = publicationRecord({
        asset,
        candidate,
        decision,
        metadata,
      })
      uploaded += 1
      savePublication()
      continue
    }

    if (recordNeedsPatch(existing, decision, metadata)) {
      onProgress(`Updating photograph ${index + 1} of ${included.length}`)
      const asset = await patchAsset({
        assetId: existing.assetId,
        metadata,
        token,
        baseUrl: mediaBaseUrl,
      })
      publication.assets[candidate.id] = publicationRecord({
        asset,
        candidate,
        decision,
        metadata,
      })
      updated += 1
      savePublication()
    }
  }

  const manifest = manifestPayload({
    walkId,
    candidates,
    decisions,
    assets: publication.assets,
  })
  const manifestFingerprint = fingerprintFor(manifest)
  if (
    !publication.manifestAssetId ||
    publication.manifestFingerprint !== manifestFingerprint
  ) {
    onProgress('Uploading the protected photo manifest')
    const file = new Blob(
      [`${JSON.stringify(manifest, null, 2)}\n`],
      { type: 'application/json' },
    )
    const asset = await uploadAsset({
      collectionId: publication.collectionId,
      file,
      filename: `${walkId}-private-photos.json`,
      token,
      baseUrl: mediaBaseUrl,
      metadata: {
        title: `${walkName} private photo manifest`,
        visibility: 'authenticated',
        requiredRoles: [PRIVATE_PHOTO_ROLE],
        tags: ['walk-photo', walkId, 'manifest'],
        links: [{
          siteId: 'ashterism-walks',
          objectType: 'walk-photo-manifest',
          objectId: walkId,
        }],
        custom: {
          walkId,
          photoCount: manifest.photos.length,
          manifestFingerprint,
        },
      },
    })
    publication.manifestAssetId = asset.id
    publication.manifestFingerprint = manifestFingerprint
    savePublication()
  }

  const publicCandidates = candidates.filter((candidate) => {
    const decision = decisions[candidate.id]
    return decision.status === 'keep' && decision.visibility === 'public'
  })
  walk.local.photos = publicCandidates.map((candidate) => {
    const decision = decisions[candidate.id]
    const asset = publication.assets[candidate.id]
    return {
      assetId: asset.assetId,
      url: `${mediaBaseUrl}/v1/assets/${asset.assetId}/variants/display`,
      alt: asset.alt,
      ...(decision.caption ? { caption: decision.caption } : {}),
      capturedAt: candidate.capturedAtIso,
      ...(decision.rotation ? { rotation: decision.rotation } : {}),
    }
  })
  walk.local.photoManifestAssetId = publication.manifestAssetId
  const walkChanged = writeWalk(walk)

  return {
    publication,
    manifest,
    uploaded,
    updated,
    reused: included.length - uploaded,
    walkChanged,
  }
}
