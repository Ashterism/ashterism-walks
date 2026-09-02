import './style.css'

import {
  AttributionControl,
  LngLatBounds,
  Map,
  Marker,
  NavigationControl,
} from 'maplibre-gl'

import 'maplibre-gl/dist/maplibre-gl.css'

import { setupAccountMenu } from './auth.js'

const account = await setupAccountMenu()

const emptyRoute = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [] },
}

const mapStyle = () => ({
  version: 8,
  sources: {
    openstreetmap: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'openstreetmap',
      type: 'raster',
      source: 'openstreetmap',
    },
  ],
})

const map = new Map({
  container: 'map',
  attributionControl: false,
  style: mapStyle(),
  center: [0, 20],
  zoom: 1.5,
})

map.addControl(new NavigationControl(), 'top-right')
map.addControl(
  new AttributionControl({ compact: true }),
  'bottom-right',
)

const elements = {
  mapCanvas: document.querySelector('#map'),
  library: document.querySelector('.library'),
  panel: document.querySelector('#walk-panel'),
  list: document.querySelector('#walk-list'),
  filters: document.querySelector('#walk-filters'),
  filterYear: document.querySelector('#filter-year'),
  filterLength: document.querySelector('#filter-length'),
  filterStatus: document.querySelector('#filter-status'),
  title: document.querySelector('#walk-title'),
  date: document.querySelector('#walk-date'),
  distance: document.querySelector('#walk-distance'),
  movingTime: document.querySelector('#walk-moving-time'),
  ascent: document.querySelector('#walk-ascent'),
  descent: document.querySelector('#walk-descent'),
  count: document.querySelector('#walk-count'),
  status: document.querySelector('#map-status'),
  viewAll: document.querySelector('#view-all'),
  moreDetails: document.querySelector('#walk-more'),
  detail: document.querySelector('#walk-detail'),
  detailBack: document.querySelector('#detail-back'),
  detailKind: document.querySelector('#detail-kind'),
  detailTitle: document.querySelector('#detail-title'),
  detailDate: document.querySelector('#detail-date'),
  detailDistance: document.querySelector('#detail-distance'),
  detailMoving: document.querySelector('#detail-moving'),
  detailElapsed: document.querySelector('#detail-elapsed'),
  detailPace: document.querySelector('#detail-pace'),
  detailAscent: document.querySelector('#detail-ascent'),
  detailDescent: document.querySelector('#detail-descent'),
  detailMap: document.querySelector('#detail-map'),
  elevationChart: document.querySelector('#elevation-chart'),
  elevationEmpty: document.querySelector('#elevation-empty'),
  elevationFill: document.querySelector('#detail-elevation-fill'),
  elevationLine: document.querySelector('#detail-elevation-line'),
  elevationRange: document.querySelector('#detail-elevation-range'),
  profileDistance: document.querySelector('#detail-profile-distance'),
  photoGrid: document.querySelector('#detail-photo-grid'),
  detailNotes: document.querySelector('#detail-notes'),
  detailNotesCopy: document.querySelector('#detail-notes-copy'),
  detailReferences: document.querySelector('#detail-references'),
  detailSource: document.querySelector('#detail-source'),
  bookLibrary: document.querySelector('#book-library'),
  bookLibraryBack: document.querySelector('#book-library-back'),
}

let walks = []
let visibleWalks = []
let selectedId = null
let selectedRoute = null
let routeRequest = 0
let startMarker
let finishMarker
let detailMap
let detailStartMarker
let detailFinishMarker

const setBackgroundInert = (isInert) => {
  for (const element of [
    elements.mapCanvas,
    elements.library,
    elements.panel,
  ]) {
    element.inert = isInert
    if (isInert) element.setAttribute('aria-hidden', 'true')
    else element.removeAttribute('aria-hidden')
  }
}

const formatDuration = (totalSeconds) => {
  if (!Number.isFinite(totalSeconds)) return '–'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.round((totalSeconds % 3600) / 60)
  return hours === 0 ? `${minutes} min` : `${hours} hr ${minutes} min`
}

const formatDate = (dateString, long = false) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: long ? 'long' : 'short',
    year: 'numeric',
    ...(long ? { weekday: 'long' } : {}),
  }).format(new Date(dateString))

const formatDistance = (distanceKm) =>
  Number.isFinite(distanceKm) ? `${distanceKm} km` : '–'

const formatHeight = (height) =>
  Number.isFinite(height) ? `${Math.round(height)} m` : '–'

const formatPace = (movingTimeSeconds, distanceKm) => {
  if (!Number.isFinite(movingTimeSeconds) || !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return '–'
  }

  const secondsPerKilometre = Math.round(movingTimeSeconds / distanceKm)
  const minutes = Math.floor(secondsPerKilometre / 60)
  const seconds = String(secondsPerKilometre % 60).padStart(2, '0')
  return `${minutes}:${seconds} / km`
}

const fetchJson = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`)
  return response.json()
}

const routePadding = () =>
  window.innerWidth <= 720
    ? {
        top: elements.panel.hidden
          ? 70
          : Math.ceil(
              elements.panel.getBoundingClientRect().bottom -
                elements.mapCanvas.getBoundingClientRect().top +
                24,
            ),
        right: 35,
        bottom: Math.ceil(elements.library.getBoundingClientRect().height + 140),
        left: 35,
      }
    : {
        top: 70,
        right: 70,
        bottom: 70,
        left: Math.ceil(elements.library.getBoundingClientRect().right + 28),
      }

const allWalksPadding = () =>
  window.innerWidth <= 720
    ? {
        top: 35,
        right: 35,
        bottom: Math.ceil(elements.library.getBoundingClientRect().height + 40),
        left: 35,
      }
    : routePadding()

const boundsFrom = ([west, south, east, north]) =>
  new LngLatBounds([west, south], [east, north])

const showStatus = (message) => {
  elements.status.textContent = message
  elements.status.hidden = false
}

const hideStatus = () => {
  elements.status.hidden = true
}

const updateDetails = (walk) => {
  elements.title.textContent =
    walk.name || (walk.activity === 'hiking' ? 'Hike' : 'Walk')
  elements.date.textContent = formatDate(walk.date, true)
  elements.distance.textContent = formatDistance(walk.distanceKm)
  elements.movingTime.textContent = formatDuration(walk.movingTimeSeconds)
  elements.ascent.textContent = formatHeight(walk.ascentM)
  elements.descent.textContent = formatHeight(walk.descentM)
  elements.moreDetails.disabled = true
  elements.panel.hidden = false
}

const matchesLengthFilter = (walk, filter) => {
  const distance = walk.distanceKm
  if (!Number.isFinite(distance) || filter === 'all') return filter === 'all'
  if (filter === 'under-5') return distance < 5
  if (filter === '5-10') return distance >= 5 && distance < 10
  if (filter === '10-20') return distance >= 10 && distance < 20
  return filter === '20-plus' && distance >= 20
}

const walkStartFeatures = (candidates) => ({
  type: 'FeatureCollection',
  features: candidates.map((walk) => ({
    type: 'Feature',
    properties: { id: walk.id },
    geometry: { type: 'Point', coordinates: walk.start },
  })),
})

const updateWalkCount = () => {
  const filtered = visibleWalks.length !== walks.length
  const routeLabel = visibleWalks.length === 1 ? 'route' : 'routes'
  elements.count.textContent = filtered
    ? `${visibleWalks.length} of ${walks.length} ${routeLabel}`
    : `${walks.length} mapped ${walks.length === 1 ? 'route' : 'routes'}`
}

const updateFilterStatus = () => {
  const activeFilters = []
  if (elements.filterYear.value !== 'all') {
    activeFilters.push(elements.filterYear.value)
  }
  if (elements.filterLength.value !== 'all') {
    activeFilters.push(
      elements.filterLength.selectedOptions[0]?.textContent ?? 'Length',
    )
  }
  elements.filterStatus.textContent =
    activeFilters.length > 0 ? activeFilters.join(' · ') : 'All walks'
}

const renderList = () => {
  if (visibleWalks.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'walk-list__empty'
    empty.textContent = 'No walks match these filters.'
    elements.list.replaceChildren(empty)
    return
  }

  elements.list.replaceChildren(
    ...visibleWalks.map((walk) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.walkId = walk.id
      button.className = 'walk-list__button'
      button.setAttribute('aria-pressed', String(walk.id === selectedId))

      const name = document.createElement('span')
      name.className = 'walk-list__name'
      name.textContent = walk.name

      const meta = document.createElement('span')
      meta.className = 'walk-list__meta'
      meta.textContent = `${formatDate(walk.date)} · ${walk.distanceKm} km`

      button.append(name, meta)
      if (walk.provenance?.status === 'estimated') {
        const provenance = document.createElement('span')
        provenance.className = 'walk-list__provenance'
        provenance.textContent = 'Estimated route'
        button.append(provenance)
      }
      button.addEventListener('click', () => selectWalk(walk.id))
      item.append(button)
      return item
    }),
  )
}

const clearSelection = () => {
  routeRequest += 1
  selectedId = null
  selectedRoute = null
  elements.panel.hidden = true
  map.getSource('walk').setData(emptyRoute)
  startMarker.remove()
  finishMarker.remove()
  updateUrl(null)
}

const applyFilters = () => {
  const year = elements.filterYear.value
  const length = elements.filterLength.value
  visibleWalks = walks.filter(
    (walk) =>
      (year === 'all' || String(new Date(walk.date).getFullYear()) === year) &&
      matchesLengthFilter(walk, length),
  )

  updateFilterStatus()
  updateWalkCount()
  renderList()
  map.getSource('walk-starts').setData(walkStartFeatures(visibleWalks))

  if (selectedId && !visibleWalks.some((walk) => walk.id === selectedId)) {
    clearSelection()
  } else {
    syncListSelection()
  }

  if (visibleWalks.length > 0) showAllWalks()
}

const syncListSelection = ({ focus = false } = {}) => {
  const buttons = elements.list.querySelectorAll('[data-walk-id]')
  let selectedButton = null

  for (const button of buttons) {
    const isSelected = button.dataset.walkId === selectedId
    button.setAttribute('aria-pressed', String(isSelected))
    if (isSelected) selectedButton = button
  }

  if (!selectedButton) return
  selectedButton.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest',
    inline: 'nearest',
  })
  if (focus) selectedButton.focus({ preventScroll: true })
}

const updateUrl = (id, { detail = false, push = false } = {}) => {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('walk', id)
  else url.searchParams.delete('walk')

  if (detail) url.searchParams.set('view', 'details')
  else url.searchParams.delete('view')

  window.history[push ? 'pushState' : 'replaceState']({}, '', url)
}

const sample = (values, maximumPoints) => {
  if (values.length <= maximumPoints) return values
  const step = (values.length - 1) / (maximumPoints - 1)
  return Array.from(
    { length: maximumPoints },
    (_, index) => values[Math.round(index * step)],
  )
}

const detailMarkerElement = (kind) => {
  const element = document.createElement('span')
  element.className = `detail-map__marker detail-map__marker--${kind}`
  element.setAttribute('aria-label', kind === 'start' ? 'Route start' : 'Route finish')
  return element
}

const ensureDetailMap = () => {
  if (detailMap) return detailMap

  detailMap = new Map({
    container: elements.detailMap,
    attributionControl: false,
    style: mapStyle(),
    center: [0, 20],
    zoom: 1.5,
  })
  detailMap.addControl(new NavigationControl({ showCompass: false }), 'top-right')
  detailMap.addControl(new AttributionControl({ compact: true }), 'bottom-right')
  detailStartMarker = new Marker({ element: detailMarkerElement('start') })
  detailFinishMarker = new Marker({ element: detailMarkerElement('finish') })

  detailMap.on('load', () => {
    detailMap.addSource('detail-walk', { type: 'geojson', data: emptyRoute })
    detailMap.addLayer({
      id: 'detail-walk-outline',
      type: 'line',
      source: 'detail-walk',
      paint: {
        'line-color': '#fffaf1',
        'line-width': 7,
        'line-opacity': 0.92,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
    detailMap.addLayer({
      id: 'detail-walk-line',
      type: 'line',
      source: 'detail-walk',
      paint: { 'line-color': '#d7653f', 'line-width': 4 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    })
  })

  return detailMap
}

const renderDetailMap = (route, walk) => {
  const routeMap = ensureDetailMap()
  const update = () => {
    routeMap.resize()
    routeMap.getSource('detail-walk').setData(route)
    detailStartMarker.setLngLat(walk.start).addTo(routeMap)
    detailFinishMarker.setLngLat(walk.finish).addTo(routeMap)
    routeMap.fitBounds(boundsFrom(walk.bounds), {
      padding: window.innerWidth <= 720 ? 28 : 42,
      duration: 0,
      maxZoom: 15,
    })
  }

  if (routeMap.loaded() && routeMap.getSource('detail-walk')) update()
  else routeMap.once('load', update)
}

const distanceBetween = (first, second) => {
  const toRadians = (degrees) => (degrees * Math.PI) / 180
  const latitude1 = toRadians(first[1])
  const latitude2 = toRadians(second[1])
  const latitudeDelta = latitude2 - latitude1
  const longitudeDelta = toRadians(second[0] - first[0])
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

const renderElevationProfile = (coordinates, walk) => {
  let distanceKm = 0
  const elevationPoints = []

  coordinates.forEach((coordinate, index) => {
    if (index > 0) distanceKm += distanceBetween(coordinates[index - 1], coordinate)
    if (Number.isFinite(coordinate[2])) {
      elevationPoints.push({ distanceKm, altitude: coordinate[2] })
    }
  })

  if (elevationPoints.length < 2) {
    elements.elevationChart.hidden = true
    elements.elevationEmpty.hidden = false
    elements.elevationRange.textContent = ''
    return
  }

  elements.elevationChart.hidden = false
  elements.elevationEmpty.hidden = true
  const altitudes = elevationPoints.map((point) => point.altitude)
  const minimumAltitude = Math.min(...altitudes)
  const maximumAltitude = Math.max(...altitudes)
  const altitudeRange = maximumAltitude - minimumAltitude || 1
  const width = 1000
  const height = 220
  const topPadding = 12
  const bottomPadding = 8
  const usableHeight = height - topPadding - bottomPadding
  const points = sample(elevationPoints, 500).map((point) => [
    (point.distanceKm / distanceKm) * width,
    topPadding +
      (1 - (point.altitude - minimumAltitude) / altitudeRange) * usableHeight,
  ])
  const line = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')
  const fill = `${line} L${width},${height} L0,${height} Z`

  elements.elevationLine.setAttribute('d', line)
  elements.elevationFill.setAttribute('d', fill)
  elements.elevationRange.textContent = `${Math.round(minimumAltitude)}–${Math.round(maximumAltitude)} m altitude`
  elements.profileDistance.textContent = formatDistance(walk.distanceKm)
}

const renderPhotos = (photos = []) => {
  if (photos.length > 0) {
    elements.photoGrid.replaceChildren(
      ...photos.map((photo, index) => {
        const figure = document.createElement('figure')
        const image = document.createElement('img')
        image.src = photo.url
        image.alt = photo.alt ?? `Photograph ${index + 1} from this walk`
        image.loading = 'lazy'
        figure.append(image)
        if (photo.caption) {
          const caption = document.createElement('figcaption')
          caption.textContent = photo.caption
          figure.append(caption)
        }
        return figure
      }),
    )
    return
  }

  elements.photoGrid.replaceChildren(
    ...Array.from({ length: 3 }, (_, index) => {
      const placeholder = document.createElement('div')
      placeholder.className = 'photo-placeholder'
      const label = document.createElement('span')
      label.textContent = `Photo ${String(index + 1).padStart(2, '0')}`
      const note = document.createElement('p')
      note.textContent = 'A moment from the walk will live here.'
      placeholder.append(label, note)
      return placeholder
    }),
  )
}

const renderNotes = (notes, references = []) => {
  const hasNotes = typeof notes === 'string' && notes.trim() !== ''
  const safeReferences = references.filter(
    (reference) => reference?.label && reference?.url,
  )
  elements.detailNotes.hidden = !hasNotes && safeReferences.length === 0
  elements.detailNotesCopy.hidden = !hasNotes
  elements.detailNotesCopy.textContent = hasNotes ? notes : ''
  elements.detailReferences.replaceChildren(
    ...safeReferences.map((reference) => {
      const item = document.createElement('li')
      const link = document.createElement('a')
      link.href = reference.url
      link.textContent = reference.label
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      item.append(link)
      return item
    }),
  )
}

const renderDetail = (walk, route) => {
  const coordinates = route.geometry.coordinates
  elements.detailKind.textContent = walk.activity === 'hiking' ? 'Hiking' : 'Walking'
  elements.detailTitle.textContent = walk.name
  elements.detailDate.textContent = formatDate(walk.date, true)
  elements.detailDistance.textContent = formatDistance(walk.distanceKm)
  elements.detailMoving.textContent = formatDuration(walk.movingTimeSeconds)
  elements.detailElapsed.textContent = formatDuration(walk.elapsedTimeSeconds)
  elements.detailPace.textContent = formatPace(
    walk.movingTimeSeconds,
    walk.distanceKm,
  )
  elements.detailAscent.textContent = formatHeight(walk.ascentM)
  elements.detailDescent.textContent = formatHeight(walk.descentM)
  elements.detailSource.textContent =
    walk.provenance?.label ??
    `Activity data from ${walk.providers.join(' and ')} · archived by Ashterism`
  renderDetailMap(route, walk)
  renderElevationProfile(coordinates, walk)
  renderPhotos(walk.photos)
  renderNotes(walk.notes, walk.references)
}

const openDetails = ({ updateHistory = true } = {}) => {
  const walk = walks.find((candidate) => candidate.id === selectedId)
  if (!walk || !selectedRoute) return
  elements.detail.hidden = false
  renderDetail(walk, selectedRoute)
  setBackgroundInert(true)
  document.body.classList.add('detail-is-open')
  updateUrl(walk.id, { detail: true, push: updateHistory })
  elements.detail.scrollTop = 0
  elements.detailBack.focus({ preventScroll: true })
}

const closeDetails = ({ updateHistory = true } = {}) => {
  elements.detail.hidden = true
  setBackgroundInert(false)
  document.body.classList.remove('detail-is-open')
  if (updateHistory && selectedId) updateUrl(selectedId)
  elements.moreDetails.focus({ preventScroll: true })
}

const openBookLibrary = () => {
  if (!account?.isSignedIn()) return
  elements.detail.hidden = true
  elements.bookLibrary.hidden = false
  setBackgroundInert(true)
  document.body.classList.remove('detail-is-open')
  document.body.classList.add('book-library-is-open')
  elements.bookLibrary.scrollTop = 0
  elements.bookLibraryBack.focus({ preventScroll: true })
}

const closeBookLibrary = () => {
  elements.bookLibrary.hidden = true
  setBackgroundInert(false)
  document.body.classList.remove('book-library-is-open')
  document.querySelector('#account-menu-button')?.focus({ preventScroll: true })
  map.resize()
}

document.addEventListener('walk-books:open', openBookLibrary)

const selectWalk = async (
  id,
  { updateHistory = true, focusList = false } = {},
) => {
  const walk = walks.find((candidate) => candidate.id === id)
  if (!walk) return

  const request = ++routeRequest
  selectedId = walk.id
  selectedRoute = null
  syncListSelection({ focus: focusList })
  updateDetails(walk)
  showStatus('Loading route…')
  map.getSource('walk').setData(emptyRoute)
  startMarker.remove()
  finishMarker.remove()

  try {
    const route = await fetchJson(walk.routeUrl)
    if (request !== routeRequest) return

    selectedRoute = route
    elements.moreDetails.disabled = false
    map.getSource('walk').setData(route)
    startMarker.setLngLat(walk.start).addTo(map)
    finishMarker.setLngLat(walk.finish).addTo(map)
    map.fitBounds(boundsFrom(walk.bounds), {
      padding: routePadding(),
      duration: 900,
      maxZoom: 15,
    })
    if (updateHistory) updateUrl(walk.id)
    hideStatus()
  } catch (error) {
    console.error(error)
    showStatus('This route could not be loaded.')
  }
}

const showAllWalks = () => {
  routeRequest += 1
  selectedId = null
  selectedRoute = null
  syncListSelection()
  elements.detail.hidden = true
  elements.bookLibrary.hidden = true
  setBackgroundInert(false)
  document.body.classList.remove('detail-is-open')
  document.body.classList.remove('book-library-is-open')
  elements.panel.hidden = true
  map.getSource('walk').setData(emptyRoute)
  startMarker.remove()
  finishMarker.remove()

  if (window.innerWidth <= 720) {
    elements.list.scrollTo({ left: 0, behavior: 'smooth' })
  }

  const overviewWalks = visibleWalks.filter(
    (walk) => walk.includeInOverview !== false,
  )

  if (overviewWalks.length === 0) {
    updateUrl(null)
    return
  }

  const bounds = new LngLatBounds()
  overviewWalks.forEach((walk) => bounds.extend(walk.start))
  map.fitBounds(bounds, {
    padding: allWalksPadding(),
    duration: 900,
    maxZoom: 8,
  })
  updateUrl(null)
}

map.on('load', async () => {
  try {
    showStatus('Loading walks…')
    const catalogue = await fetchJson(`/data/walks.json?v=${Date.now()}`)
    walks = catalogue.walks
    if (walks.length === 0) throw new Error('The walk catalogue is empty')
    visibleWalks = walks

    updateWalkCount()

    const years = [...new Set(walks.map((walk) => new Date(walk.date).getFullYear()))]
      .filter(Number.isFinite)
      .sort((first, second) => second - first)
    elements.filterYear.append(
      ...years.map((year) => {
        const option = document.createElement('option')
        option.value = String(year)
        option.textContent = String(year)
        return option
      }),
    )

    map.addSource('walk-starts', {
      type: 'geojson',
      data: walkStartFeatures(walks),
    })

    map.addLayer({
      id: 'walk-starts',
      type: 'circle',
      source: 'walk-starts',
      paint: {
        'circle-radius': 7,
        'circle-color': '#d7653f',
        'circle-stroke-color': '#fffaf1',
        'circle-stroke-width': 2,
      },
    })

    map.addSource('walk', { type: 'geojson', data: emptyRoute })
    map.addLayer({
      id: 'walk-outline',
      type: 'line',
      source: 'walk',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#fffaf1',
        'line-width': 9,
        'line-opacity': 0.95,
      },
    })
    map.addLayer({
      id: 'walk-route',
      type: 'line',
      source: 'walk',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#d7653f', 'line-width': 5 },
    })

    startMarker = new Marker({ color: '#267255' })
    finishMarker = new Marker({ color: '#9f3829' })

    map.on('mouseenter', 'walk-starts', () => {
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', 'walk-starts', () => {
      map.getCanvas().style.cursor = ''
    })
    map.on('click', 'walk-starts', (event) => {
      const id = event.features?.[0]?.properties?.id
      if (id) selectWalk(String(id), { focusList: true })
    })

    elements.viewAll.addEventListener('click', showAllWalks)
    elements.filterYear.addEventListener('change', applyFilters)
    elements.filterLength.addEventListener('change', applyFilters)
    elements.moreDetails.addEventListener('click', () => openDetails())
    elements.detailBack.addEventListener('click', () => closeDetails())
    elements.bookLibraryBack.addEventListener('click', closeBookLibrary)

    const searchParams = new URLSearchParams(window.location.search)
    const requestedId = searchParams.get('walk')
    const initialWalk =
      walks.find((walk) => walk.id === requestedId) ?? walks[0]
    renderList()
    await selectWalk(initialWalk.id, {
      updateHistory: Boolean(requestedId),
    })

    if (searchParams.get('view') === 'details') {
      openDetails({ updateHistory: false })
    }
  } catch (error) {
    console.error(error)
    showStatus('The walks could not be loaded.')
  }
})

window.addEventListener('popstate', () => {
  const view = new URLSearchParams(window.location.search).get('view')
  if (view === 'details' && selectedRoute) {
    openDetails({ updateHistory: false })
  } else if (!elements.detail.hidden) {
    closeDetails({ updateHistory: false })
  }
})
