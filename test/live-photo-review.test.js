import assert from 'node:assert/strict'
import test from 'node:test'
import { setupWalkPhotos } from '../src/walk-photos.js'

class Element {
  constructor() { this.children = []; this.style = { removeProperty() {} }; this.events = {}; this.attributes = {} }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  setAttribute(name, value) { this.attributes[name] = value }
  addEventListener(name, listener) { this.events[name] = listener }
  querySelector(selector) { this.nodes ??= {}; return this.nodes[selector] ??= new Element() }
  get dataset() { return this.data ??= {} }
}

test('live gallery offers a review toggle, persists choices and can undo rejection', async t => {
  const originals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch }
  const document = { body: new Element(), createElement: () => new Element() }
  globalThis.document = document
  globalThis.window = { location: { hostname: 'walks.ashterism.com' } }
  t.after(() => Object.assign(globalThis, originals))
  let asset = { id: 'image', visibility: 'authenticated', requiredRoles: ['walks.private_photos'], tags: ['walk-photo'], custom: { reviewStatus: 'unreviewed' }, variants: { thumb: { url: '/v1/assets/image/variants/thumb' }, display: { url: '/v1/assets/image/variants/display' } } }
  let patches = 0
  let listings = 0
  let listingOptions
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/v1/assets?')) { listings++; listingOptions = options; return { ok: true, json: async () => ({ assets: [asset] }) } }
    if (options.method === 'PATCH') { patches++; asset = { ...asset, ...JSON.parse(options.body) } }
    const value = asset
    return { ok: true, json: async () => value, blob: async () => new Blob(['image']) }
  }
  const grid = new Element(), reviewRoot = new Element(), reviewToggle = new Element()
  let roles = ['media.editor']
  const gallery = setupWalkPhotos({ grid, reviewRoot, reviewToggle, empty: new Element(), note: new Element(), getAccessToken: () => 'token', isSignedIn: () => true, getRoles: () => roles })
  const walk = { id: '123', photoManifestAssetId: 'manifest', photos: [] }
  await gallery.render(walk)
  assert.equal(listingOptions.headers.Authorization, 'Bearer token')
  assert.equal(reviewToggle.textContent, 'Review photos')
  assert.equal(reviewToggle.attributes['aria-expanded'], 'false')
  assert.equal(reviewRoot.dataset.open, 'false')
  assert.equal(reviewRoot.inert, true)
  assert.equal(grid.children[0].children.length, 2) // image and unreviewed badge, no controls
  reviewToggle.onclick()
  assert.equal(reviewToggle.attributes['aria-expanded'], 'true')
  assert.equal(reviewRoot.inert, false)
  let controls = grid.children[0].children.at(-1)
  assert.deepEqual(controls.children.map(button => button.textContent), ['Public', 'Private', 'Not included'])
  await controls.children[2].events.click()
  assert.equal(patches, 1)
  assert.ok(listings >= 2, 'review change reloads the Media listing')
  assert.equal(asset.custom.reviewStatus, 'reject')
  reviewToggle.onclick()
  assert.equal(grid.children.length, 0)
  reviewToggle.onclick()
  assert.equal(grid.children.length, 1)
  controls = grid.children[0].children.at(-1)
  await controls.children[1].events.click()
  assert.equal(asset.custom.reviewStatus, 'keep')
  assert.equal(asset.visibility, 'authenticated')
  gallery.clear()
  roles = ['walks.private_photos']
  await gallery.render(walk)
  assert.equal(reviewRoot.hidden, true)
  assert.equal(reviewToggle.hidden, true)
  assert.equal(grid.children[0].children.length, 2) // image and Private badge
  gallery.clear()
})

test('bulk review selects all, saves public/private, and leaves failed photos selected for retry', async t => {
  const originals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch }
  globalThis.document = { body: new Element(), createElement: () => new Element() }
  globalThis.window = { location: { hostname: 'walks.ashterism.com' } }
  t.after(() => Object.assign(globalThis, originals))
  const assets = Object.fromEntries(['a', 'b'].map(id => [id, { id, visibility: 'authenticated', requiredRoles: ['walks.private_photos'], custom: { reviewStatus: 'unreviewed' }, variants: { thumb: { url: `/v1/assets/${id}/variants/thumb` }, display: { url: `/v1/assets/${id}/variants/display` } } }]))
  let failB = false
  globalThis.fetch = async (url, options = {}) => {
    const id = /\/assets\/([^/]+)/.exec(url)?.[1]
    if (url.includes('/v1/assets?')) return { ok: true, json: async () => ({ assets: Object.values(assets) }) }
    if (options.method === 'PATCH') {
      if (failB && id === 'b') return { ok: false, status: 500, json: async () => ({ error: 'temporary error' }) }
      assets[id] = { ...assets[id], ...JSON.parse(options.body) }
    }
    return { ok: true, json: async () => assets[id], blob: async () => new Blob(['image']) }
  }
  const grid = new Element(), reviewRoot = new Element(), reviewToggle = new Element()
  const gallery = setupWalkPhotos({ grid, reviewRoot, reviewToggle, empty: new Element(), note: new Element(), getAccessToken: () => 'token', getRoles: () => ['media.editor'] })
  const walk = { id: '123', photoManifestAssetId: 'manifest', photos: [] }
  const content = () => reviewRoot.children[0].children[0]
  const tool = text => content().children[0].children.find(child => child.textContent === text)
  await gallery.render(walk)
  reviewToggle.onclick()
  assert.equal(tool('Mark Public').disabled, true)
  tool('Select all').events.click()
  assert.ok(tool('2 selected'))
  assert.equal(grid.children.every(figure => figure.dataset.selected === 'true'), true)
  await tool('Mark Public').events.click()
  assert.equal(assets.a.visibility, 'public')
  assert.equal(assets.b.visibility, 'public')
  assert.deepEqual(assets.a.requiredRoles, [])
  assert.ok(tool('0 selected'))
  tool('Select all').events.click()
  failB = true
  await tool('Mark Private').events.click()
  assert.equal(assets.a.visibility, 'authenticated')
  assert.equal(assets.b.visibility, 'public')
  assert.ok(tool('1 selected'))
  assert.match(content().children[1].textContent, /1 saved; 1 could not be saved/)
  failB = false
  await tool('Mark Private').events.click()
  assert.equal(assets.b.visibility, 'authenticated')
  assert.ok(tool('0 selected'))
  const checkbox = grid.children[0].children.find(child => child.className === 'photo-grid__select').children[0]
  checkbox.checked = true
  checkbox.events.change()
  assert.ok(tool('1 selected'))
  tool('Clear selection').events.click()
  assert.ok(tool('0 selected'))
  tool('Select all').events.click()
  await gallery.render({ ...walk, id: '456' })
  assert.equal(reviewRoot.dataset.open, 'false')
  assert.ok(tool('0 selected'))
  gallery.clear()
})

test('signed-out visitors use the same live listing and receive only the public result', async t => {
  const originals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch }
  globalThis.document = { body: new Element(), createElement: () => new Element() }
  globalThis.window = { location: { hostname: 'walks.ashterism.com' } }
  t.after(() => Object.assign(globalThis, originals))
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    return { ok: true, json: async () => ({ assets: [{
      id: 'public-photo', visibility: 'public', caption: '', alt: 'Ridge', custom: { reviewStatus: 'keep' },
      variants: { thumb: { url: '/v1/assets/public-photo/variants/thumb' }, display: { url: '/v1/assets/public-photo/variants/display' } },
    }] }) }
  }
  const grid = new Element()
  const gallery = setupWalkPhotos({ grid, reviewRoot: new Element(), reviewToggle: new Element(), empty: new Element(), note: new Element(), getAccessToken: () => null, getRoles: () => [] })
  await gallery.render({ id: '24755894108', photos: [], photoManifestAssetId: 'legacy-manifest' })
  assert.equal(grid.children.length, 1)
  assert.match(calls[0].url, /siteId=ashterism-walks/)
  assert.match(calls[0].url, /objectType=walk/)
  assert.match(calls[0].url, /objectId=24755894108/)
  assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(calls[0].options.headers.Authorization, undefined)
  gallery.clear()
})
