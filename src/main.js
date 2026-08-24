import './style.css'

import {
  AttributionControl,
  LngLatBounds,
  Map,
  Marker,
  NavigationControl,
} from 'maplibre-gl'

import 'maplibre-gl/dist/maplibre-gl.css'

const emptyRoute = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [] },
}

const map = new Map({
  container: 'map',
  attributionControl: false,
  style: {
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
  },
  center: [0, 20],
  zoom: 1.5,
})

map.addControl(new NavigationControl(), 'top-right')
map.addControl(
  new AttributionControl({ compact: true }),
  'bottom-right',
)

const elements = {
  panel: document.querySelector('#walk-panel'),
  list: document.querySelector('#walk-list'),
  title: document.querySelector('#walk-title'),
  date: document.querySelector('#walk-date'),
  distance: document.querySelector('#walk-distance'),
  movingTime: document.querySelector('#walk-moving-time'),
  ascent: document.querySelector('#walk-ascent'),
  descent: document.querySelector('#walk-descent'),
  count: document.querySelector('#walk-count'),
  status: document.querySelector('#map-status'),
  viewAll: document.querySelector('#view-all'),
}

let walks = []
let selectedId = null
let routeRequest = 0
let startMarker
let finishMarker

const formatDuration = (totalSeconds) => {
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

const fetchJson = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`)
  return response.json()
}

const routePadding = () =>
  window.innerWidth <= 720
    ? { top: 70, right: 35, bottom: 270, left: 35 }
    : { top: 70, right: 70, bottom: 70, left: 440 }

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
  elements.title.textContent = walk.name || (walk.activity === 'hiking' ? 'Hike' : 'Walk')
  elements.date.textContent = formatDate(walk.date, true)
  elements.distance.textContent = `${walk.distanceKm} km`
  elements.movingTime.textContent = formatDuration(walk.movingTimeSeconds)
  elements.ascent.textContent = `${walk.ascentM} m`
  elements.descent.textContent = `${walk.descentM} m`
  elements.panel.hidden = false
}

const renderList = () => {
  elements.list.replaceChildren(
    ...walks.map((walk) => {
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
      button.addEventListener('click', () => selectWalk(walk.id))
      item.append(button)
      return item
    }),
  )
}

const updateUrl = (id) => {
  const url = new URL(window.location.href)
  url.searchParams.set('walk', id)
  window.history.replaceState({}, '', url)
}

const selectWalk = async (id, { updateHistory = true } = {}) => {
  const walk = walks.find((candidate) => candidate.id === id)
  if (!walk) return

  const request = ++routeRequest
  selectedId = walk.id
  renderList()
  updateDetails(walk)
  showStatus('Loading route…')
  map.getSource('walk').setData(emptyRoute)
  startMarker.remove()
  finishMarker.remove()

  try {
    const route = await fetchJson(walk.routeUrl)
    if (request !== routeRequest) return

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
  renderList()
  elements.panel.hidden = true
  map.getSource('walk').setData(emptyRoute)
  startMarker.remove()
  finishMarker.remove()

  const bounds = new LngLatBounds()
  walks.forEach((walk) => bounds.extend(walk.start))
  map.fitBounds(bounds, {
    padding: window.innerWidth <= 720 ? 70 : 110,
    duration: 900,
    maxZoom: 8,
  })

  const url = new URL(window.location.href)
  url.searchParams.delete('walk')
  window.history.replaceState({}, '', url)
}

map.on('load', async () => {
  try {
    showStatus('Loading walks…')
    const catalogue = await fetchJson('/data/walks.json')
    walks = catalogue.walks
    if (walks.length === 0) throw new Error('The walk catalogue is empty')

    elements.count.textContent = `${walks.length} mapped ${walks.length === 1 ? 'route' : 'routes'}`

    map.addSource('walk-starts', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: walks.map((walk) => ({
          type: 'Feature',
          properties: { id: walk.id },
          geometry: { type: 'Point', coordinates: walk.start },
        })),
      },
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
      paint: { 'line-color': '#fffaf1', 'line-width': 9, 'line-opacity': 0.95 },
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

    map.on('mouseenter', 'walk-starts', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'walk-starts', () => { map.getCanvas().style.cursor = '' })
    map.on('click', 'walk-starts', (event) => {
      const id = event.features?.[0]?.properties?.id
      if (id) selectWalk(String(id))
    })

    elements.viewAll.addEventListener('click', showAllWalks)
    const requestedId = new URLSearchParams(window.location.search).get('walk')
    const initialWalk = walks.find((walk) => walk.id === requestedId) ?? walks[0]
    await selectWalk(initialWalk.id, { updateHistory: Boolean(requestedId) })
  } catch (error) {
    console.error(error)
    showStatus('The walks could not be loaded.')
  }
})
