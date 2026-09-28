export const MEDIA_API_BASE_URL = 'https://media.ashterism.com'

export const mediaRequestUrl = (path, location = window.location) => {
  if (!path?.startsWith('/v1/')) throw new Error('Invalid Ashterix Media path')
  return location.hostname === 'dev.walks.ashterism.com'
    ? `/media-proxy${path}`
    : new URL(path, `${MEDIA_API_BASE_URL}/`).toString()
}

const privateManifestPath = (assetId) => `/v1/assets/${assetId}/content`
const privateDisplayPath = (assetId) => `/v1/assets/${assetId}/variants/display`

export const setupWalkPhotos = ({ grid, note, empty, getAccessToken }) => {
  let renderRequest = 0
  let objectUrls = []
  const emptyTitle = empty.querySelector('strong')
  const emptyCopy = empty.querySelector('span')

  const clearObjectUrls = () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url))
    objectUrls = []
  }

  const figureFor = (photo, index) => {
    const figure = document.createElement('figure')
    const image = document.createElement('img')
    image.src = photo.url
    image.alt = photo.alt ?? `Photograph ${index + 1} from this walk`
    image.loading = 'lazy'
    figure.append(image)
    if (photo.visibility === 'private') {
      const badge = document.createElement('span')
      badge.className = 'photo-grid__visibility'
      badge.textContent = 'Login only'
      figure.append(badge)
    }
    if (photo.caption) {
      const caption = document.createElement('figcaption')
      caption.textContent = photo.caption
      figure.append(caption)
    }
    return figure
  }

  const display = (photos, suffix = '') => {
    const sorted = [...photos].sort((a, b) =>
      String(a.capturedAt ?? '').localeCompare(String(b.capturedAt ?? '')),
    )
    grid.replaceChildren(...sorted.map(figureFor))
    grid.hidden = sorted.length === 0
    empty.hidden = sorted.length > 0
    note.hidden = sorted.length === 0 && !suffix
    note.textContent = sorted.length
      ? `${sorted.length} ${sorted.length === 1 ? 'photograph' : 'photographs'}${suffix}`
      : suffix
  }

  const render = async (walk) => {
    const request = ++renderRequest
    clearObjectUrls()
    const publicPhotos = walk.photos ?? []
    emptyTitle.textContent = walk.photoManifestAssetId
      ? 'Sign in to see this walk’s photographs'
      : 'No photographs from this walk'
    emptyCopy.textContent = walk.photoManifestAssetId
      ? 'Public photographs appear for everyone; login-only photographs are fetched securely after sign-in.'
      : 'The route and elevation still tell the story.'

    const token = getAccessToken?.()
    if (!walk.photoManifestAssetId || !token) {
      display(
        publicPhotos,
        walk.photoManifestAssetId ? ' · sign in for login-only photographs' : '',
      )
      return
    }

    display(publicPhotos, ' · loading login-only photographs…')
    try {
      const manifestResponse = await fetch(
        mediaRequestUrl(privateManifestPath(walk.photoManifestAssetId)),
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
      )
      if (!manifestResponse.ok) throw new Error(`Manifest request failed: ${manifestResponse.status}`)
      const manifest = await manifestResponse.json()
      const privatePhotos = await Promise.all(
        (manifest.photos ?? []).map(async (photo) => {
          const response = await fetch(mediaRequestUrl(privateDisplayPath(photo.assetId)), {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`Photo request failed: ${response.status}`)
          const url = URL.createObjectURL(await response.blob())
          objectUrls.push(url)
          return { ...photo, url, visibility: 'private' }
        }),
      )
      if (request !== renderRequest) return
      display([...publicPhotos, ...privatePhotos])
    } catch (error) {
      console.error('Could not load login-only photographs', error)
      if (request === renderRequest) display(publicPhotos, ' · login-only photographs unavailable')
    }
  }

  return { render, clear: clearObjectUrls }
}
