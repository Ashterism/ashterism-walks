import { mediaRequestUrl } from './walk-photos.js'

const REVIEW_ORIGIN = 'http://127.0.0.1:4175'
const privateRole = 'walks.private_photos'

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, options)
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.json()).error ?? '' } catch { /* ignore */ }
    throw new Error(`${detail || 'Request failed'} (${response.status})`)
  }
  return response.json()
}

const savePublication = (value) => requestJson(`${REVIEW_ORIGIN}/api/publication`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
})

const mediaRequest = (path, token, options = {}) =>
  requestJson(mediaRequestUrl(path), {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  })

const uploadAsset = async ({ collectionId, file, metadata, token }) => {
  const body = new FormData()
  body.append('metadata', JSON.stringify(metadata))
  body.append('file', file)
  return mediaRequest(`/v1/collections/${collectionId}/assets`, token, {
    method: 'POST',
    body,
  })
}

const makeDialog = () => {
  const dialog = document.createElement('dialog')
  dialog.className = 'photo-publisher'
  dialog.innerHTML = `
    <div class="photo-publisher__bar">
      <strong>Publish reviewed walk photos</strong>
      <button type="button" data-close>Close</button>
    </div>
    <div class="photo-publisher__body">
      <p data-summary>Checking the local review…</p>
      <progress data-progress value="0" max="1"></progress>
      <p data-status aria-live="polite"></p>
      <button type="button" data-publish disabled>Publish reviewed photos</button>
    </div>`
  document.body.append(dialog)
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close())
  return dialog
}

export const setupPhotoPublisher = async ({ account }) => {
  if (new URLSearchParams(window.location.search).get('publishPhotos') !== '1') return
  const dialog = makeDialog()
  const summary = dialog.querySelector('[data-summary]')
  const status = dialog.querySelector('[data-status]')
  const progress = dialog.querySelector('[data-progress]')
  const publish = dialog.querySelector('[data-publish]')
  dialog.showModal()

  if (!account?.isSignedIn()) {
    summary.textContent = 'Sign in with the account menu, then return to this importer.'
    status.textContent = 'The media service will enforce its editor/admin role.'
    return
  }

  try {
    const [session, existing] = await Promise.all([
      requestJson(`${REVIEW_ORIGIN}/api/session`),
      requestJson(`${REVIEW_ORIGIN}/api/publication`),
    ])
    const decisions = Object.entries(session.review.decisions)
      .filter(([, decision]) => decision.status === 'keep')
      .sort(([, first], [, second]) => first.capturedAt.localeCompare(second.capturedAt))
    const publicCount = decisions.filter(([, value]) => value.visibility === 'public').length
    const privateCount = decisions.length - publicCount
    const remaining = decisions.filter(([id]) => !existing.assets?.[id]).length
    summary.textContent = `${decisions.length} approved photos: ${publicCount} public and ${privateCount} private. ${remaining} still need uploading.`
    progress.max = decisions.length + 1
    progress.value = decisions.length - remaining
    publish.disabled = false

    publish.addEventListener('click', async () => {
      publish.disabled = true
      const token = account.getAccessToken()
      try {
        let publication = existing
        if (!publication.collectionId) {
          status.textContent = 'Creating the walk photo collection…'
          const collection = await mediaRequest('/v1/collections', token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: `${session.walk.name} photographs`,
              description: `Reviewed photographs linked to ${session.walk.id}.`,
            }),
          })
          publication = await savePublication({ collectionId: collection.id })
        }

        for (let index = 0; index < decisions.length; index += 1) {
          const [candidateId, decision] = decisions[index]
          if (publication.assets?.[candidateId]) continue
          status.textContent = `Uploading photograph ${index + 1} of ${decisions.length}…`
          const source = await fetch(`${REVIEW_ORIGIN}/media/${candidateId}`)
          if (!source.ok) throw new Error(`Could not read local photograph ${index + 1}`)
          const file = new File(
            [await source.blob()],
            `${session.walk.id}-${String(index + 1).padStart(2, '0')}.jpg`,
            { type: 'image/jpeg' },
          )
          const isPublic = decision.visibility === 'public'
          const asset = await uploadAsset({
            collectionId: publication.collectionId,
            file,
            token,
            metadata: {
              title: `${session.walk.name} — photograph ${index + 1}`,
              alt: `Photograph ${index + 1} from ${session.walk.name}`,
              ...(decision.caption ? { caption: decision.caption } : {}),
              visibility: isPublic ? 'public' : 'authenticated',
              requiredRoles: isPublic ? [] : [privateRole],
              tags: ['walk-photo', session.walk.id, isPublic ? 'public' : 'login-only'],
              links: [{ siteId: 'ashterism-walks', objectType: 'walk', objectId: session.walk.id }],
              custom: {
                candidateId,
                capturedAt: decision.capturedAt,
                reviewStatus: decision.status,
              },
            },
          })
          publication = await savePublication({
            asset: {
              candidateId,
              record: {
                assetId: asset.id,
                visibility: decision.visibility,
                capturedAt: decision.capturedAt,
                caption: decision.caption,
                alt: asset.alt,
              },
            },
          })
          progress.value = Object.keys(publication.assets).length
        }

        if (!publication.manifestAssetId) {
          status.textContent = 'Creating the protected private-photo manifest…'
          const privatePhotos = decisions
            .filter(([, decision]) => decision.visibility === 'private')
            .map(([candidateId]) => publication.assets[candidateId])
          const manifest = new File(
            [JSON.stringify({ schemaVersion: 1, walkId: session.walk.id, photos: privatePhotos }, null, 2)],
            `${session.walk.id}-private-photos.json`,
            { type: 'application/json' },
          )
          const manifestAsset = await uploadAsset({
            collectionId: publication.collectionId,
            file: manifest,
            token,
            metadata: {
              title: `${session.walk.name} private photo manifest`,
              visibility: 'authenticated',
              requiredRoles: [privateRole],
              tags: ['walk-photo', session.walk.id, 'manifest'],
              links: [{ siteId: 'ashterism-walks', objectType: 'walk-photo-manifest', objectId: session.walk.id }],
              custom: { walkId: session.walk.id, photoCount: privatePhotos.length },
            },
          })
          publication = await savePublication({ manifestAssetId: manifestAsset.id })
        }
        progress.value = progress.max
        status.textContent = 'Upload complete. The reviewed publication record is ready to apply to the dev walk.'
      } catch (error) {
        console.error(error)
        status.textContent = error.message
        publish.disabled = false
      }
    }, { once: true })
  } catch (error) {
    summary.textContent = 'The local photo review is not available.'
    status.textContent = `${error.message} Keep the review window open on this Mac.`
  }
}
