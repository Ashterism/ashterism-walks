export const MEDIA_API_BASE_URL = 'https://media.ashterism.com'
export const LOCAL_REVIEW_ORIGIN = 'http://127.0.0.1:4175'

export const mediaRequestUrl = (path, location = window.location) => {
  if (!path?.startsWith('/v1/')) throw new Error('Invalid Ashterix Media path')
  return location.hostname === 'dev.walks.ashterism.com'
    ? `/media-proxy${path}`
    : new URL(path, `${MEDIA_API_BASE_URL}/`).toString()
}

const privateManifestPath = (assetId) => `/v1/assets/${assetId}/content`
const privateDisplayPath = (assetId) => `/v1/assets/${assetId}/variants/display`

export const privatePhotoFailureFor = (error) => {
  if (error.status === 401) return {
    title: 'Your photo sign-in needs refreshing',
    copy: 'Sign out, then sign in again to renew access to private photographs.',
    note: ' · private photo access rejected (401)',
  }
  if (error.status === 403) return {
    title: 'Photo access was denied',
    copy: 'You are signed in, but the media service has not granted this account access to these photographs.',
    note: ' · private photo permission denied (403)',
  }
  return {
    title: 'Private photographs could not be loaded',
    copy: error.status
      ? `The ${error.stage === 'manifest' ? 'photo list' : 'image'} request returned ${error.status}. Your sign-in is still active.`
      : 'The media request could not complete. Your sign-in is still active; please try again shortly.',
    note: ` · private photographs unavailable${error.status ? ` (${error.stage}: ${error.status})` : ' (connection failed)'}`,
  }
}

const assertMediaResponse = (response, stage) => {
  if (!response.ok) {
    const error = new Error(`${stage} request failed: ${response.status}`)
    Object.assign(error, { status: response.status, stage })
    throw error
  }
}

export const reviewDecisionFor = (session, candidate) =>
  session.review?.decisions?.[candidate.id] ?? {
    status: 'unreviewed',
    visibility: 'private',
    rotation: 0,
    caption: '',
  }

export const setupWalkPhotos = ({
  grid,
  note,
  empty,
  reviewRoot,
  getAccessToken,
  isSignedIn,
}) => {
  let renderRequest = 0
  let objectUrls = []
  let viewerPhotos = []
  let viewerIndex = 0
  const emptyTitle = empty.querySelector('strong')
  const emptyCopy = empty.querySelector('span')
  const viewer = document.createElement('dialog')
  viewer.className = 'photo-viewer'
  viewer.innerHTML = `
    <div class="photo-viewer__bar">
      <p>Photograph</p>
      <button type="button" aria-label="Close full-size photograph">Close</button>
    </div>
    <div class="photo-viewer__stage">
      <button class="photo-viewer__previous" type="button" aria-label="Previous photograph">‹</button>
      <img alt="" />
      <button class="photo-viewer__next" type="button" aria-label="Next photograph">›</button>
    </div>`
  document.body.append(viewer)
  const viewerTitle = viewer.querySelector('p')
  const viewerImage = viewer.querySelector('img')
  const viewerClose = viewer.querySelector('.photo-viewer__bar button')
  const viewerPrevious = viewer.querySelector('.photo-viewer__previous')
  const viewerNext = viewer.querySelector('.photo-viewer__next')
  viewerClose.addEventListener('click', () => viewer.close())
  viewer.addEventListener('click', (event) => {
    if (event.target === viewer) viewer.close()
  })

  const showViewerPhoto = (index) => {
    if (!viewerPhotos.length) return
    viewerIndex = (index + viewerPhotos.length) % viewerPhotos.length
    const photo = viewerPhotos[viewerIndex]
    viewerImage.src = photo.fullUrl ?? photo.url
    viewerImage.alt = photo.alt ?? `Photograph ${viewerIndex + 1}`
    viewerTitle.textContent = `Photograph ${viewerIndex + 1} of ${viewerPhotos.length}`
    viewerPrevious.hidden = viewerPhotos.length < 2
    viewerNext.hidden = viewerPhotos.length < 2
    if (photo.rotation) viewerImage.style.transform = `rotate(${photo.rotation}deg)`
    else viewerImage.style.removeProperty('transform')
  }

  viewerPrevious.addEventListener('click', () => showViewerPhoto(viewerIndex - 1))
  viewerNext.addEventListener('click', () => showViewerPhoto(viewerIndex + 1))
  viewer.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') showViewerPhoto(viewerIndex - 1)
    if (event.key === 'ArrowRight') showViewerPhoto(viewerIndex + 1)
  })

  const clearObjectUrls = () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url))
    objectUrls = []
  }

  const figureFor = (photo, index, saveDecision) => {
    const figure = document.createElement('figure')
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'photo-grid__open'
    open.setAttribute('aria-label', `Open photograph ${index + 1} full size`)
    const image = document.createElement('img')
    image.src = photo.url
    image.alt = photo.alt ?? `Photograph ${index + 1} from this walk`
    image.loading = 'lazy'
    if (photo.rotation) image.style.transform = `rotate(${photo.rotation}deg)`
    open.append(image)
    open.addEventListener('click', () => {
      showViewerPhoto(index)
      viewer.showModal()
    })
    figure.append(open)
    if (photo.reviewStatus === 'unreviewed') {
      const badge = document.createElement('span')
      badge.className = 'photo-grid__visibility photo-grid__visibility--review'
      badge.textContent = 'Needs review'
      figure.append(badge)
    } else if (photo.visibility === 'private') {
      const badge = document.createElement('span')
      badge.className = 'photo-grid__visibility'
      badge.textContent = 'Private'
      figure.append(badge)
    }
    if (photo.caption) {
      const caption = document.createElement('figcaption')
      caption.textContent = photo.caption
      figure.append(caption)
    }
    if (saveDecision) {
      const controls = document.createElement('div')
      controls.className = 'photo-grid__review-controls'
      const choices = [
        ['Public', { status: 'keep', visibility: 'public' }],
        ['Private', { status: 'keep', visibility: 'private' }],
        ['Not included', { status: 'reject', visibility: 'private' }],
      ]
      for (const [label, change] of choices) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        button.dataset.selected = String(
          photo.reviewStatus === change.status &&
          (change.status === 'reject' || photo.visibility === change.visibility),
        )
        button.addEventListener('click', () => saveDecision(photo, change))
        controls.append(button)
      }
      figure.append(controls)
    }
    return figure
  }

  const display = (photos, suffix = '', saveDecision = null) => {
    const sorted = [...photos].sort((a, b) =>
      String(a.capturedAt ?? '').localeCompare(String(b.capturedAt ?? '')),
    )
    viewerPhotos = sorted
    grid.replaceChildren(...sorted.map((photo, index) => figureFor(photo, index, saveDecision)))
    grid.hidden = sorted.length === 0
    empty.hidden = sorted.length > 0
    note.hidden = sorted.length === 0 && !suffix
    note.textContent = sorted.length
      ? `${sorted.length} ${sorted.length === 1 ? 'photograph' : 'photographs'}${suffix}`
      : suffix
  }

  const localSessionFor = async (walk) => {
    if (window.location.hostname !== 'dev.walks.ashterism.com') return null
    try {
      const response = await fetch(`${LOCAL_REVIEW_ORIGIN}/api/session`, { cache: 'no-store' })
      if (!response.ok) return null
      const session = await response.json()
      return session.walk?.id === walk.id ? session : null
    } catch {
      return null
    }
  }

  const saveLocalDecision = async (photo, change, walk) => {
    const response = await fetch(`${LOCAL_REVIEW_ORIGIN}/api/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: photo.candidateId,
        status: change.status,
        visibility: change.visibility,
        rotation: photo.rotation ?? 0,
        caption: photo.caption ?? '',
      }),
    })
    if (!response.ok) throw new Error(`Review update failed: ${response.status}`)
    await render(walk)
  }

  const renderLocalReview = (session, walk) => {
    const reviewed = Object.values(session.review?.decisions ?? {})
      .filter((decision) => decision.status !== 'unreviewed').length
    if (!isSignedIn?.()) {
      reviewRoot.hidden = false
      reviewRoot.textContent = `${session.candidates.length} matched photographs are waiting. Sign in with the account menu to view and review them.`
      return false
    }

    const photos = session.candidates
      .map((candidate) => {
        const decision = reviewDecisionFor(session, candidate)
        return {
          candidateId: candidate.id,
          url: `${LOCAL_REVIEW_ORIGIN}/media/${candidate.id}?size=thumb`,
          fullUrl: `${LOCAL_REVIEW_ORIGIN}/media/${candidate.id}`,
          alt: `Matched photograph from ${session.walk.name}`,
          capturedAt: candidate.capturedAtIso,
          caption: decision.caption,
          rotation: decision.rotation,
          reviewStatus: decision.status,
          visibility: decision.visibility,
        }
      })
      .filter((photo) => photo.reviewStatus !== 'reject')

    reviewRoot.hidden = false
    reviewRoot.textContent = `${reviewed} of ${session.candidates.length} reviewed. Matched photographs remain Private until explicitly marked Public.`
    display(
      photos,
      ` · ${session.candidates.length - reviewed} need review`,
      (photo, change) => saveLocalDecision(photo, change, walk),
    )
    return true
  }

  const render = async (walk) => {
    const request = ++renderRequest
    clearObjectUrls()
    reviewRoot.hidden = true
    reviewRoot.textContent = ''
    const publicPhotos = walk.photos ?? []
    emptyTitle.textContent = walk.photoManifestAssetId
      ? 'Sign in to see this walk’s photographs'
      : 'No photographs from this walk'
    emptyCopy.textContent = walk.photoManifestAssetId
      ? 'Public photographs appear for everyone; private photographs are fetched securely after sign-in.'
      : 'The route and elevation still tell the story.'

    const localSession = await localSessionFor(walk)
    if (request !== renderRequest) return
    if (localSession && renderLocalReview(localSession, walk)) return

    const token = getAccessToken?.()
    if (!walk.photoManifestAssetId || !token) {
      display(
        publicPhotos,
        walk.photoManifestAssetId ? ' · sign in for private photographs' : '',
      )
      return
    }

    emptyTitle.textContent = 'Loading this walk’s photographs'
    emptyCopy.textContent = 'Fetching private photographs securely using your sign-in.'
    display(publicPhotos, ' · loading private photographs…')
    try {
      const manifestResponse = await fetch(
        mediaRequestUrl(privateManifestPath(walk.photoManifestAssetId)),
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      )
      assertMediaResponse(manifestResponse, 'manifest')
      const manifest = await manifestResponse.json()
      const privatePhotos = await Promise.all(
        (manifest.photos ?? []).map(async (photo) => {
          const response = await fetch(mediaRequestUrl(privateDisplayPath(photo.assetId)), {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
          })
          assertMediaResponse(response, 'image')
          const url = URL.createObjectURL(await response.blob())
          objectUrls.push(url)
          return { ...photo, url, visibility: 'private' }
        }),
      )
      if (request !== renderRequest) return
      display([...publicPhotos, ...privatePhotos])
    } catch (error) {
      console.error('Could not load private photographs', error)
      if (request === renderRequest) {
        const failure = privatePhotoFailureFor(error)
        emptyTitle.textContent = failure.title
        emptyCopy.textContent = failure.copy
        display(publicPhotos, failure.note)
      }
    }
  }

  return { render, clear: clearObjectUrls }
}
