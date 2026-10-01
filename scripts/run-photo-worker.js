import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { readJson } from './lib/canonical-walks.js'
import { mediaServiceToken } from './lib/media-service-token.js'
import { addedWalkIds, isRecentWalk } from './lib/new-walk-photo-worker.js'
import { preparePhotoCandidates } from './lib/prepare-photo-candidates.js'
import { preparePhotoPublication } from './lib/prepare-photo-publication.js'

const option = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}
const archiveRoot = option('--archive')
const stateRoot = option('--state-dir')
if (!archiveRoot || !stateRoot) {
  throw new Error('Usage: node scripts/run-photo-worker.js --archive /volume1/photo/Photos --state-dir /volume1/docker/ashterism-walks-photo-worker/state')
}

const branch = 'main'
const stateDirectory = path.resolve(stateRoot)
const statePath = path.join(stateDirectory, 'worker.json')
const lockPath = path.join(stateDirectory, 'worker.lock')
fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const saveState = (state) => {
  const temporary = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, statePath)
}

const acquireLock = () => {
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    return
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const previous = Number(fs.readFileSync(lockPath, 'utf8').trim())
  try {
    if (Number.isInteger(previous) && previous > 0) process.kill(previous, 0)
    throw new Error(`Photo worker is already running (${previous})`)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  fs.unlinkSync(lockPath)
  fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
}

acquireLock()
try {
  if (git('branch', '--show-current') !== branch) throw new Error('Run the worker from a main-branch checkout')
  if (git('status', '--porcelain')) throw new Error('Worker checkout has uncommitted changes')

  git('fetch', 'origin', branch)
  git('rebase', `origin/${branch}`)
  const head = git('rev-parse', 'HEAD')
  if (!fs.existsSync(statePath)) {
    saveState({ schemaVersion: 1, seenCommit: head, pendingWalkIds: [] })
    console.log(`Watching new walks after ${head}`)
  } else {
    const state = readJson(statePath)
    if (!Array.isArray(state.pendingWalkIds) || !state.seenCommit) throw new Error('Invalid worker state')
    if (spawnSync('git', ['merge-base', '--is-ancestor', state.seenCommit, head]).status !== 0) {
      throw new Error('Main history changed; inspect worker state before continuing')
    }
    const diff = git('diff', '--name-status', '--diff-filter=A', `${state.seenCommit}..${head}`, '--', 'data/walks')
    for (const id of addedWalkIds(diff)) {
      const walk = readJson(path.join('data/walks', `${id}.json`))
      if (isRecentWalk(walk) && !state.pendingWalkIds.includes(id)) state.pendingWalkIds.push(id)
    }
    state.seenCommit = head
    saveState(state)

    for (const walkId of [...state.pendingWalkIds]) {
      let result
      try {
        result = preparePhotoCandidates({ walkId, archiveRoot })
      } catch (error) {
        console.warn(`${walkId}: waiting for route/archive: ${error.message}`)
        continue
      }
      if (!result.candidates.length) {
        console.log(`${walkId}: no matching archive photos yet; will retry`)
        continue
      }

      const prepared = await preparePhotoPublication({
        ...result,
        walkId,
        token: await mediaServiceToken(),
        privateDirectory: path.join(stateDirectory, 'publication-ledger'),
        onProgress: (message) => console.log(`${walkId}: ${message}`),
      })
      execFileSync(process.execPath, ['scripts/build-catalogue.js'], { stdio: 'inherit' })
      git('add', '--', `data/walks/${walkId}.json`, 'public/data/walks.json')
      if (spawnSync('git', ['diff', '--cached', '--quiet']).status === 1) {
        git('commit', '-m', `Prepare private photos for ${walkId}`)
        git('push', 'origin', 'HEAD:main')
      }
      state.pendingWalkIds = state.pendingWalkIds.filter((id) => id !== walkId)
      state.seenCommit = git('rev-parse', 'HEAD')
      saveState(state)
      console.log(`${walkId}: ${prepared.manifest.photos.length} private photos prepared`)
    }
  }
} finally {
  fs.unlinkSync(lockPath)
}
