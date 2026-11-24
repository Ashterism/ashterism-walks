import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const git = (...args) => execFileSync('git', args, { encoding: 'buffer' })

// These are Vite's checked-in inputs in this repository. Keep generated data
// under public/ in scope, while canonical-only data and CI files stay out.
export const getBuildInputs = () => {
  const raw = git('ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--',
    'index.html', 'src', 'public', 'package.json', 'package-lock.json',
    'vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.ts', 'vite.config.mts', 'vite.config.cts')
  return raw.toString().split('\0').filter(Boolean).map((entry) => {
    const [metadata, filePath] = entry.split('\t')
    return { path: filePath, object: metadata.split(' ')[2] }
  })
}

export const fingerprintBuildInputs = (inputs) => {
  const hash = createHash('sha256')
  for (const { path, object } of inputs.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(path).update('\0').update(object).update('\0')
  }
  return hash.digest('hex')
}

export const matchesPublication = (markerText, fingerprint) => {
  try {
    const marker = JSON.parse(markerText)
    return marker.version === 1 &&
      /^[a-f0-9]{64}$/.test(marker.buildInputsFingerprint) &&
      /^[a-f0-9]{40}$/.test(marker.builtCommit) &&
      marker.buildInputsFingerprint === fingerprint
  } catch {
    return false
  }
}

export const getRevision = () => ({
  version: 1,
  buildInputsFingerprint: fingerprintBuildInputs(getBuildInputs()),
  builtCommit: git('rev-parse', 'HEAD').toString().trim(),
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, outputPath] = process.argv.slice(2)
  if (command === 'fingerprint') {
    console.log(getRevision().buildInputsFingerprint)
  } else if (command === 'write' && outputPath) {
    fs.writeFileSync(outputPath, `${JSON.stringify(getRevision())}\n`)
  } else if (command === 'matches' && outputPath) {
    process.exitCode = matchesPublication(fs.readFileSync(0, 'utf8'), outputPath) ? 0 : 1
  } else {
    console.error('Usage: node scripts/publication-revision.js fingerprint | write <path>')
    process.exitCode = 2
  }
}
