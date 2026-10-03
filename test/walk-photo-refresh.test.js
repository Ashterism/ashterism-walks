import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

import { refreshWindowFor, requestPhotoRefresh } from '../scripts/lib/walk-photo-refresh.js'

const walk = (startDate, elapsedTimeSeconds) => ({
  id: '24576877588', sources: { intervals: { snapshot: {
    startDate, startDateLocal: '2026-10-02T12:10:21', elapsedTimeSeconds,
    movingTimeSeconds: 300,
  } } },
})

test('Mialet refresh uses the UTC activity span with one-hour buffers', () => {
  assert.deepEqual(refreshWindowFor(walk('2026-10-02T10:10:21Z', 2842), Date.parse('2026-10-03T00:00:00Z')), {
    startDate: '2026-10-02T09:10:21.000Z', endDate: '2026-10-02T11:57:43.000Z',
  })
})

test('seven-hour hike uses elapsed time, crosses midnight, and clips the buffer at now', () => {
  assert.deepEqual(refreshWindowFor(walk('2026-10-02T21:30:00+02:00', 7 * 3600), Date.parse('2026-10-03T03:00:00Z')), {
    startDate: '2026-10-02T18:30:00.000Z', endDate: '2026-10-03T03:00:00.000Z',
  })
  assert.throws(() => refreshWindowFor(walk('2026-10-02T10:00:00', 3600)), /timezone/)
  assert.throws(() => refreshWindowFor(walk('2026-10-03T12:00:00Z', 3600), Date.parse('2026-10-03T12:30:00Z')), /finished/)
})

test('queue survives retries, rejects stale acknowledgements, and renews empty results after 30 minutes', (t) => {
  const queueRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-refresh-'))
  t.after(() => fs.rmSync(queueRoot, { recursive: true, force: true }))
  const now = Date.parse('2026-10-03T12:00:00Z')
  const args = { walk: walk('2026-10-02T10:10:21Z', 2842), queueRoot, now }
  const first = requestPhotoRefresh(args)
  assert.equal(first.ready, false)
  assert.deepEqual(requestPhotoRefresh({ ...args, now: now + 1000 }), first)
  const resultPath = path.join(queueRoot, 'results', '24576877588.json')
  fs.writeFileSync(resultPath, JSON.stringify({ status: 'complete', requestedAt: 'old', completedAt: new Date(now).toISOString() }))
  assert.equal(requestPhotoRefresh(args).ready, false)
  fs.writeFileSync(resultPath, JSON.stringify({ status: 'complete', requestedAt: first.request.requestedAt, completedAt: new Date(now).toISOString() }))
  assert.equal(requestPhotoRefresh({ ...args, retry: true, now: now + 1799000 }).ready, true)
  const renewed = requestPhotoRefresh({ ...args, retry: true, now: now + 1800000 })
  assert.equal(renewed.ready, false)
  assert.notEqual(renewed.request.requestedAt, first.request.requestedAt)
  assert.equal(requestPhotoRefresh({ ...args, now: now + 1801000 }).ready, false)
})

test('production downloader passes the full window without early-stop and preserves existing-file options', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-downloader-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'ash')
  const archive = path.join(root, 'photo')
  const bin = path.join(root, 'bin')
  for (const directory of [`${home}/.config/photo-ingest`, `${home}/photo-ingest-reports`, `${archive}/Photos`, bin]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(`${home}/.config/photo-ingest/icloud-username`, 'test@example.invalid\n')
  // Remap only host paths; run the actual wrapper against a fake Docker CLI.
  const wrapper = fs.readFileSync(new URL('../scripts/ashserver/run_icloud_sync.sh', import.meta.url), 'utf8')
    .replaceAll('/home/ash', home).replaceAll('/mnt/photo', archive)
  fs.writeFileSync(`${root}/run_icloud_sync.sh`, wrapper)
  for (const command of ['mountpoint', 'flock']) {
    fs.writeFileSync(`${bin}/${command}`, '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  }
  fs.writeFileSync(`${bin}/docker`, '#!/bin/bash\nprintf "%s\\n" "$@" > "$DOCKER_ARGUMENTS"\n', { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_ARGUMENTS: `${root}/arguments` }
  const run = (...args) => execFileSync('bash', [`${root}/run_icloud_sync.sh`, ...args], { env, stdio: 'pipe' })
  run('window', '2026-10-02T09:10:21.000Z', '2026-10-02T17:10:21.000Z')
  const options = fs.readFileSync(`${root}/arguments`, 'utf8').split('\n')
  assert.equal(options[options.indexOf('--skip-created-before') + 1], '2026-10-02T09:10:21.000Z')
  assert.equal(options[options.indexOf('--skip-created-after') + 1], '2026-10-02T17:10:21.000Z')
  assert.equal(options.includes('--until-found'), false)
  assert.equal(options[options.indexOf('--file-match-policy') + 1], 'name-id7')
  assert.equal(options.includes('--xmp-sidecar'), true)
  assert.equal(options.includes('--delete-after-download'), false)
  assert.equal(fs.existsSync(`${home}/photo-ingest-reports/icloud/latest.log`), false)
  run('watch-pass', '2026')
  const watchOptions = fs.readFileSync(`${root}/arguments`, 'utf8').split('\n')
  assert.equal(watchOptions[watchOptions.indexOf('--until-found') + 1], '100')
  assert.equal(watchOptions.includes('--watch-with-interval'), false)
  assert.equal(fs.existsSync(`${home}/photo-ingest-reports/icloud/latest.log`), true)
})
