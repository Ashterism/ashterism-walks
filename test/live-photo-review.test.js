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
  let asset = { id: 'image', visibility: 'authenticated', requiredRoles: ['walks.private_photos'], tags: ['walk-photo'], custom: { reviewStatus: 'unreviewed' } }
  let patches = 0
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'PATCH') { patches++; asset = { ...asset, ...JSON.parse(options.body) } }
    const value = url.includes('/manifest/content')
      ? { photos: [{ assetId: 'image', candidateId: 'candidate', reviewStatus: 'unreviewed' }] } : asset
    return { ok: true, json: async () => value, blob: async () => new Blob(['image']) }
  }
  const grid = new Element(), reviewRoot = new Element(), reviewToggle = new Element()
  let roles = ['media.editor']
  const gallery = setupWalkPhotos({ grid, reviewRoot, reviewToggle, empty: new Element(), note: new Element(), getAccessToken: () => 'token', isSignedIn: () => true, getRoles: () => roles })
  const walk = { id: '123', photoManifestAssetId: 'manifest', photos: [] }
  await gallery.render(walk)
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
