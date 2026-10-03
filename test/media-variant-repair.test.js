import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
const { repair } = createRequire(import.meta.url)('../scripts/halman/repair-media-variants.cjs')

const manifestId = '6b738b17-8fdf-4b96-82a0-80a3b92d297a'
const assetId = 'ecb66d6a-91da-49d2-aa11-924dc09562ef'
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-variant-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = id => path.join(root, 'assets', id.slice(0, 2), id)
  for (const id of [manifestId, assetId]) await fs.mkdir(path.join(dir(id), 'original'), { recursive: true })
  const asset = {
    id: assetId, visibility: 'authenticated', requiredRoles: ['walks.private_photos'],
    custom: { reviewStatus: 'unreviewed' }, variants: {},
    original: { mediaType: 'image/heic', relativePath: 'original/source.heic' },
  }
  await fs.writeFile(path.join(dir(assetId), 'metadata.json'), JSON.stringify(asset))
  await fs.writeFile(path.join(dir(assetId), 'original/source.heic'), 'unchanged-original')
  await fs.writeFile(path.join(dir(manifestId), 'metadata.json'), JSON.stringify({ original: { relativePath: 'original/manifest.json' } }))
  await fs.writeFile(path.join(dir(manifestId), 'original/manifest.json'), JSON.stringify({ photos: [{ assetId }] }))
  const store = {
    async generateStandardVariants(temporary, buffer, mediaType) {
      assert.equal(buffer.toString(), 'unchanged-original')
      assert.equal(mediaType, 'image/heic')
      const entries = []
      for (const name of ['thumb', 'display']) {
        const relativePath = `variants/${name}.webp`
        await fs.writeFile(path.join(temporary, relativePath), name)
        entries.push([name, { name, mediaType: 'image/webp', relativePath }])
      }
      return Object.fromEntries(entries)
    },
  }
  return { root, dir, asset, store, manifestIds: [manifestId], log: () => {} }
}

test('repairs existing asset IDs without changing originals, permissions or review; rerun is a no-op', async t => {
  const input = await fixture(t)
  assert.equal(await repair({ ...input, apply: true }), 1)
  const record = JSON.parse(await fs.readFile(path.join(input.dir(assetId), 'metadata.json')))
  assert.equal(record.id, assetId)
  assert.equal(record.visibility, 'authenticated')
  assert.deepEqual(record.requiredRoles, ['walks.private_photos'])
  assert.deepEqual(record.custom, { reviewStatus: 'unreviewed' })
  assert.deepEqual(record.original, input.asset.original)
  for (const name of ['thumb', 'display']) {
    assert.equal(await fs.readFile(path.join(input.dir(assetId), record.variants[name].relativePath), 'utf8'), name)
  }
  assert.equal(await repair({ ...input, apply: true }), 0)
  assert.equal(await fs.readFile(path.join(input.dir(assetId), 'original/source.heic'), 'utf8'), 'unchanged-original')
  assert.ok((await fs.readdir(input.dir(assetId))).some(name => name.startsWith('metadata.before-variant-repair-')))
})

test('dry-run changes nothing', async t => {
  const input = await fixture(t)
  assert.equal(await repair(input), 0)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(input.dir(assetId), 'metadata.json'))), input.asset)
  assert.deepEqual((await fs.readdir(input.dir(assetId))).sort(), ['metadata.json', 'original'])
})

test('failed conversion leaves metadata intact and cleans staging', async t => {
  const input = await fixture(t)
  input.store.generateStandardVariants = async () => { throw new Error('bad HEIC') }
  await assert.rejects(repair({ ...input, apply: true }), /bad HEIC/)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(input.dir(assetId), 'metadata.json'))), input.asset)
  assert.deepEqual((await fs.readdir(input.dir(assetId))).sort(), ['metadata.json', 'original'])
})

test('explicit scope required; preserves healthy variant during partial repair', async t => {
  const input = await fixture(t)
  await assert.rejects(repair({ ...input, manifestIds: [] }), /explicit valid/)
  await assert.rejects(repair({ ...input, manifestIds: ['../oops'] }), /explicit valid/)
  await fs.mkdir(path.join(input.dir(assetId), 'variants'))
  await fs.writeFile(path.join(input.dir(assetId), 'variants/thumb.webp'), 'existing-thumb')
  input.asset.variants.thumb = { name: 'thumb', mediaType: 'image/webp', relativePath: 'variants/thumb.webp' }
  await fs.writeFile(path.join(input.dir(assetId), 'metadata.json'), JSON.stringify(input.asset))
  assert.equal(await repair({ ...input, apply: true }), 1)
  const record = JSON.parse(await fs.readFile(path.join(input.dir(assetId), 'metadata.json')))
  assert.deepEqual(record.variants.thumb, input.asset.variants.thumb)
  assert.equal(await fs.readFile(path.join(input.dir(assetId), 'variants/thumb.webp'), 'utf8'), 'existing-thumb')
})
