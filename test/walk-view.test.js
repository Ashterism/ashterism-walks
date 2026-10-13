import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { activityLabel, isWalkVisible } from '../src/walk-visibility.js'

// Run the actual view code against a small DOM/MapLibre fixture. No production
// hooks are needed, and assertions cover agreement between its view surfaces.
class Element {
  hidden = true
  value = 'all'
  children = []
  dataset = {}
  attributes = {}
  events = {}
  selectedOptions = [{ textContent: 'Under 5 km' }]
  classList = { add() {}, remove() {} }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(name, value) { this.attributes[name] = value }
  removeAttribute(name) { delete this.attributes[name] }
  addEventListener(event, callback) { this.events[event] = callback }
  scrollIntoView() {}
  focus() {}
  getBoundingClientRect() { return { right: 300, height: 300 } }
  querySelectorAll() { return this.children.flatMap((item) => item.children) }
}
class Bounds {
  points = []
  constructor(...points) { this.points = points }
  extend(point) { this.points.push(point); return this }
}
class FakeMap {
  sources = new Map()
  events = {}
  camera = { center: [0, 20], zoom: 1.5 }
  addControl() {}
  addLayer() {}
  addSource(id, source) { this.sources.set(id, { ...source, setData(data) { this.data = data } }) }
  getSource(id) { return this.sources.get(id) }
  on(event, ...args) { this.events[event] = args.at(-1) }
  once() {}
  loaded() { return true }
  fitBounds(bounds) { this.lastFit = bounds; this.fitCalls = (this.fitCalls ?? 0) + 1; this.camera = { center: bounds.points[0], zoom: 8 } }
  resize() {}
}
class Marker {
  setLngLat() { return this }
  addTo() { return this }
  remove() {}
}
const fixtureWalk = (id, activity, providers, date, distanceKm, extra = {}) => ({
  id, name: id, activity, providers, date, distanceKm,
  start: [Number(id), 1], finish: [Number(id), 2], bounds: [0, 0, 1, 2], routeUrl: `/route/${id}`,
  ...extra,
})

test('map markers, list, counts, selection and fit bounds use the same preference and filters', async () => {
  const records = [
    fixtureWalk('1', 'hiking', ['Garmin'], '2026-01-01', 3),
    fixtureWalk('2', 'walking', ['Garmin'], '2026-02-01', 4),
    fixtureWalk('3', 'walking', ['Garmin'], '2026-03-01', 2, { postRun: true }),
    fixtureWalk('4', 'walking', ['Strava'], '2020-01-01', 12),
  ]
  const elements = new Map(), listeners = {}, body = new Element()
  const get = (selector) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector) }
  const document = { querySelector: get, createElement: () => new Element(), body, addEventListener: (event, fn) => { listeners[event] = fn } }
  const window = { innerWidth: 1200, location: { href: 'https://walks.ashterism.com/', search: '' }, history: { replaceState() {}, pushState() {} }, addEventListener() {} }
  let showWalks = false
  const account = { getShowWalks: () => showWalks, getAccessToken: () => null, getRoles: () => [], isSignedIn: () => true }
  const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('document', 'window', 'Map', 'Marker', 'LngLatBounds', 'AttributionControl', 'NavigationControl',
    'setupAccountMenu', 'setupPhotoPublisher', 'setupBookLibrary', 'setupWalkPhotos', 'fetch', 'activityLabel', 'isWalkVisible',
    `${source.slice(source.indexOf('const account ='))}\nreturn { map, selectWalk, openDetails, selected: () => selectedId };`)
  const route = { geometry: { coordinates: [[0, 0], [1, 1]] }, properties: {} }
  const view = await run(document, window, FakeMap, Marker, Bounds, class {}, class {},
    async () => account, async () => {}, () => ({}), () => ({ render() {} }),
    async (url) => Response.json(url.startsWith('/data/walks') ? { walks: records } : route), activityLabel, isWalkVisible)
  await view.map.events.load()
  const shown = () => get('#walk-list').children.flatMap((item) => item.children.map((button) => button.dataset.walkId)).filter(Boolean)
  const markers = () => view.map.getSource('walk-starts').data.features.map((feature) => feature.properties.id)
  const assertView = (ids, count) => {
    assert.deepEqual(shown(), ids); assert.deepEqual(markers(), ids)
    assert.equal(get('#walk-count').textContent, count)
  }
  assertView(['1', '4'], '2 mapped routes')
  assert.deepEqual(view.map.lastFit.points, [[1, 1], [4, 1]])
  const initialFitCalls = view.map.fitCalls
  const initialCamera = structuredClone(view.map.camera)
  await view.selectWalk('2'); assert.equal(view.selected(), null)
  showWalks = true; listeners['walk-preferences:change']()
  assertView(['1', '2', '3', '4'], '4 mapped routes')
  assert.equal(view.map.fitCalls, initialFitCalls, 'showing walks must preserve map position')
  assert.deepEqual(view.map.camera, initialCamera, 'showing walks must preserve map centre and zoom')
  await view.selectWalk('3'); view.openDetails()
  assert.equal(get('#detail-kind').textContent, 'WALKING · POST-RUN')
  assert.equal(get('#walk-detail').hidden, false)
  const selectedFitCalls = view.map.fitCalls
  const selectedCamera = structuredClone(view.map.camera)
  showWalks = false; listeners['walk-preferences:change']()
  assertView(['1', '4'], '2 mapped routes')
  assert.equal(view.map.fitCalls, selectedFitCalls, 'hiding a selected walk must preserve map position')
  assert.deepEqual(view.map.camera, selectedCamera, 'hiding a selected walk must preserve centre and zoom')
  assert.equal(view.selected(), null); assert.equal(get('#walk-detail').hidden, true)
  showWalks = true; listeners['walk-preferences:change']()
  assert.equal(view.map.fitCalls, selectedFitCalls, 'showing walks again must preserve map position')
  assert.deepEqual(view.map.camera, selectedCamera)
  await view.selectWalk('2')
  const selectedVisibleFitCalls = view.map.fitCalls
  const selectedVisibleCamera = structuredClone(view.map.camera)
  showWalks = false; listeners['walk-preferences:change']()
  assert.equal(view.selected(), null); assert.equal(view.map.fitCalls, selectedVisibleFitCalls)
  assert.deepEqual(view.map.camera, selectedVisibleCamera)
  showWalks = true; listeners['walk-preferences:change']()
  assert.equal(view.map.fitCalls, selectedVisibleFitCalls)
  assert.deepEqual(view.map.camera, selectedVisibleCamera)
  get('#filter-year').value = '2026'; get('#filter-length').value = 'under-5'
  get('#filter-year').events.change(); get('#filter-length').events.change()
  assertView(['1', '2', '3'], '3 of 4 routes')
  const filteredFitCalls = view.map.fitCalls
  assert.deepEqual(view.map.lastFit.points, [[1, 1], [2, 1], [3, 1]], 'year and length filters retain their existing auto-fit')
  showWalks = false; listeners['walk-preferences:change']()
  assertView(['1'], '1 of 2 route')
  assert.equal(view.map.fitCalls, filteredFitCalls, 'preference change after filters must not refit')
  assert.deepEqual(view.map.lastFit.points, [[1, 1], [2, 1], [3, 1]])
  const filterFitCalls = view.map.fitCalls
  get('#view-all').events.click()
  assert.equal(view.map.fitCalls, filterFitCalls + 1, 'Fit all walks button continues to fit the map')
  await view.selectWalk('1'); view.openDetails()
  assert.equal(get('#detail-kind').textContent, 'Hiking')
})
