import { canReviewPhotos, photoFromAsset, savePhotoReview } from './photo-review.js'

export const MEDIA_API_BASE_URL = 'https://media.ashterism.com'
export const LOCAL_REVIEW_ORIGIN = 'http://127.0.0.1:4175'

export const publicPhotoEta = (savedAt = new Date()) => {
  const base = savedAt instanceof Date ? savedAt : new Date(savedAt)
  if (Number.isNaN(base.getTime())) throw new Error('Invalid save time')
  const expected = new Date(base.getTime() + 30 * 60000)
  const buffered = new Date(base.getTime() + 45 * 60000)
  const format = (value) => value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return { expected, buffered, expectedLabel: format(expected), bufferedLabel: format(buffered) }
}

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
  reviewToggle,
  getAccessToken,
  isSignedIn,
  getRoles,
}) => {
  let renderRequest = 0
  let objectUrls = []
  let viewerPhotos = []
  let viewerIndex = 0
  let reviewMode = false
  let currentWalkId = null
  let loadedPhotos = []
  let savingReview = false
  let reviewMessage = ''
  const selectedPhotos = new Set()
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
    if (saveDecision && photo.assetId) {
      const select = document.createElement('label')
      select.className = 'photo-grid__select'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selectedPhotos.has(photo.assetId)
      checkbox.dataset.assetId = photo.assetId
      checkbox.disabled = savingReview
      checkbox.setAttribute('aria-label', `Select photograph ${index + 1}`)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedPhotos.add(photo.assetId)
        else selectedPhotos.delete(photo.assetId)
        renderMediaReview(currentReviewWalk)
        grid.querySelector(`input[data-asset-id="${photo.assetId}"]`)?.focus?.()
      })
      figure.dataset.selected = String(checkbox.checked)
      select.append(checkbox)
      figure.append(select)
    }
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
    if (saveDecision && (photo.assetId || photo.candidateId)) {
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
        button.disabled = savingReview
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
    if (currentWalkId !== walk.id) {
      currentWalkId = walk.id
      reviewMode = false
      reviewMessage = ''
      selectedPhotos.clear()
    }
    const request = ++renderRequest
    clearObjectUrls()
    reviewRoot.hidden = true
    if (reviewToggle) reviewToggle.hidden = true
    reviewRoot.className = 'photo-review'
    reviewRoot.inert = false
    reviewRoot.setAttribute('aria-hidden', 'false')
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
      const sources = [...new Map([...publicPhotos.filter(photo => photo.assetId), ...(manifest.photos ?? [])]
        .map(photo => [photo.assetId, photo])).values()]
      const privatePhotos = await Promise.all(
        sources.map(async (photo) => {
          const metadataResponse = await fetch(mediaRequestUrl(`/v1/assets/${photo.assetId}`), {
            headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
          })
          assertMediaResponse(metadataResponse, 'image')
          const currentPhoto = photoFromAsset(photo, await metadataResponse.json())
          const response = await fetch(mediaRequestUrl(privateDisplayPath(photo.assetId)), {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
          })
          assertMediaResponse(response, 'image')
          const url = URL.createObjectURL(await response.blob())
          objectUrls.push(url)
          return { ...currentPhoto, url }
        }),
      )
      if (request !== renderRequest) return
      loadedPhotos = [...publicPhotos.filter(photo => !photo.assetId), ...privatePhotos]
      renderMediaReview(walk)
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

  let currentReviewWalk
  const saveMediaDecisions = async (photos, change, walk) => {
    if (savingReview || !photos.length) return
    savingReview = true
    const token = getAccessToken?.()
    let saved = 0
    const failures = []
    try {
      for (const [index, photo] of photos.entries()) {
        if (currentWalkId !== walk.id) break
        reviewMessage = `Saving ${index + 1} of ${photos.length}…`
        renderMediaReview(walk)
        try {
          const asset = await savePhotoReview({ photo, change, token })
          saved++
          if (currentWalkId !== walk.id) break
          loadedPhotos = loadedPhotos.map(item => item.assetId === photo.assetId ? photoFromAsset(item, asset) : item)
          selectedPhotos.delete(photo.assetId)
        } catch (error) { failures.push(error.message) }
      }
      if (currentWalkId === walk.id) reviewMessage = failures.length
        ? `${saved} saved; ${failures.length} could not be saved. ${failures[0]}`
        : (() => {
          const eta = publicPhotoEta()
          return `Saved ${saved} ${saved === 1 ? 'photograph' : 'photographs'}. Expected publicly by about ${eta.expectedLabel}; allow until ${eta.bufferedLabel} before checking.`
        })()
    } finally {
      savingReview = false
      if (currentWalkId === walk.id) renderMediaReview(walk)
    }
  }

  const renderMediaReview = (walk) => {
    currentReviewWalk = walk
    const editor = canReviewPhotos(getRoles?.())
    if (!editor) reviewMode = false
    emptyTitle.textContent = 'No included photographs'
    emptyCopy.textContent = editor
      ? 'Use Review photos to include a photograph again.'
      : 'No photographs from this walk are currently included.'
    reviewRoot.replaceChildren()
    reviewRoot.hidden = !editor
    reviewRoot.className = 'photo-review photo-review--accordion'
    reviewRoot.dataset.open = String(reviewMode)
    reviewRoot.inert = !reviewMode
    reviewRoot.setAttribute('aria-hidden', String(!reviewMode))
    reviewRoot.setAttribute('role', 'region')
    reviewRoot.setAttribute('aria-labelledby', 'detail-photo-review-toggle')
    if (reviewToggle) {
      reviewToggle.hidden = !editor
      reviewToggle.disabled = savingReview
      reviewToggle.textContent = 'Review photos'
      reviewToggle.dataset.open = String(reviewMode)
      reviewToggle.setAttribute('aria-expanded', String(reviewMode))
      reviewToggle.onclick = () => {
        reviewMode = !reviewMode
        renderMediaReview(walk)
      }
    }
    if (editor) {
      const inner = document.createElement('div')
      inner.className = 'photo-review__inner'
      const content = document.createElement('div')
      content.className = 'photo-review__content'
      const toolbar = document.createElement('div')
      toolbar.className = 'photo-review__tools'
      const selectable = loadedPhotos.filter(photo => photo.assetId)
      const selected = selectable.filter(photo => selectedPhotos.has(photo.assetId))
      const addTool = (text, action, disabled = false) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = text
        button.disabled = savingReview || disabled
        button.addEventListener('click', action)
        toolbar.append(button)
      }
      addTool('Select all', () => {
        selectable.forEach(photo => selectedPhotos.add(photo.assetId))
        renderMediaReview(walk)
      }, !selectable.length)
      addTool('Clear selection', () => {
        selectedPhotos.clear()
        renderMediaReview(walk)
      }, !selected.length)
      const count = document.createElement('span')
      count.textContent = `${selected.length} selected`
      toolbar.append(count)
      addTool('Mark Public', () => saveMediaDecisions(selected, { status: 'keep', visibility: 'public' }, walk), !selected.length)
      addTool('Mark Private', () => saveMediaDecisions(selected, { status: 'keep', visibility: 'private' }, walk), !selected.length)
      const done = document.createElement('button')
      done.type = 'button'
      done.className = 'photo-review__done'
      done.textContent = 'Done reviewing'
      done.disabled = savingReview
      done.addEventListener('click', () => {
        reviewMode = false
        renderMediaReview(walk)
        reviewToggle?.focus()
      })
      const message = document.createElement('span')
      message.setAttribute('role', 'status')
      message.textContent = reviewMessage || (reviewMode
        ? 'Choose Public, Private or Not included below each photograph. Originals are never deleted.'
        : 'Photographs remain private until explicitly marked Public.')
      content.append(toolbar, message, done)
      inner.append(content)
      reviewRoot.append(inner)
    }
    display(loadedPhotos.filter(photo => reviewMode || photo.reviewStatus !== 'reject'),
      '', reviewMode && editor ? (photo, change) => saveMediaDecisions([photo], change, walk) : null)
  }

  return { render, clear: clearObjectUrls }
}
