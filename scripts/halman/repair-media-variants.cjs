// Run inside the updated Media image, with the API stopped to avoid metadata races.
// Explicit manifest IDs only: this is not an archive-wide backfill.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const exists = async file => {
  try { await fs.stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const safePath = (base, relative) => {
  const full = path.resolve(base, relative);
  if (!full.startsWith(path.resolve(base) + path.sep)) throw new Error('Unsafe stored media path');
  return full;
};

async function repair({ root, manifestIds, store, apply = false, log = console.log }) {
  if (!manifestIds.length || manifestIds.some(id => !validId(id))) throw new Error('Supply explicit valid manifest UUIDs');
  const assetDir = id => {
    if (!validId(id)) throw new Error('Invalid asset UUID');
    return path.join(root, 'assets', id.slice(0, 2), id);
  };
  const readAsset = id => fs.readFile(path.join(assetDir(id), 'metadata.json'), 'utf8').then(JSON.parse);
  const seen = new Set();
  let repaired = 0;
  for (const id of manifestIds) {
    const manifestAsset = await readAsset(id);
    const manifest = JSON.parse(await fs.readFile(safePath(assetDir(id), manifestAsset.original.relativePath), 'utf8'));
    if (!Array.isArray(manifest.photos)) throw new Error('Not a walk photo manifest');
    for (const photo of manifest.photos) {
      if (seen.has(photo.assetId)) continue;
      seen.add(photo.assetId);
      const dir = assetDir(photo.assetId);
      const asset = await readAsset(photo.assetId);
      const missing = [];
      for (const name of ['thumb', 'display']) {
        const variant = asset.variants[name];
        if (!variant || !(await exists(safePath(dir, variant.relativePath)))) missing.push(name);
      }
      if (!missing.length) continue;
      log(`${apply ? 'Repairing' : 'Would repair'} ${asset.id}: ${missing.join(', ')} (${asset.original.mediaType})`);
      if (!apply) continue;
      const temporary = await fs.mkdtemp(path.join(dir, '.variant-repair-'));
      try {
        await fs.mkdir(path.join(temporary, 'variants'));
        const buffer = await fs.readFile(safePath(dir, asset.original.relativePath));
        // TypeScript private methods are ordinary methods in the compiled JS.
        const generated = await store.generateStandardVariants(temporary, buffer, asset.original.mediaType);
        if (missing.some(name => !generated[name])) throw new Error('Conversion produced no required variant');
        await fs.mkdir(path.join(dir, 'variants'), { recursive: true });
        const nonce = randomUUID();
        const updated = { ...asset, variants: { ...asset.variants }, updatedAt: new Date().toISOString() };
        for (const name of missing) {
          // Unique destinations preserve any older/orphaned variant files.
          const relativePath = path.join('variants', `${name}-repair-${nonce}.webp`);
          await fs.rename(safePath(temporary, generated[name].relativePath), path.join(dir, relativePath));
          updated.variants[name] = { ...generated[name], relativePath };
        }
        const metadataPath = path.join(dir, 'metadata.json');
        await fs.copyFile(metadataPath, path.join(dir, `metadata.before-variant-repair-${nonce}.json`));
        const metadataTemporary = path.join(dir, `metadata.${nonce}.tmp`);
        await fs.writeFile(metadataTemporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename(metadataTemporary, metadataPath);
        repaired++;
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }
  }
  log(`${apply ? 'Repaired' : 'Checked'} ${apply ? repaired : seen.size} assets.`);
  return repaired;
}

module.exports = { repair };
if (!module.parent) {
  (async () => {
    const args = process.argv.slice(2);
    const apply = args[0] === '--apply';
    const root = process.env.MEDIA_ROOT;
    if (!root) throw new Error('MEDIA_ROOT is required');
    const { MediaStore } = await import(path.join(process.cwd(), 'dist/storage.js'));
    await repair({ root, manifestIds: apply ? args.slice(1) : args, store: new MediaStore(root), apply });
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
