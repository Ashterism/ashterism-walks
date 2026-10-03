import fs from 'node:fs'
import path from 'node:path'

import { assertSafeWalkId } from './canonical-walks.js'
import { photoWindowFor } from './prepare-photo-candidates.js'

const utcTime = (value) => {
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value ?? '')) throw new Error('Walk time must include a timezone')
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error('Invalid walk time')
  return time
}

export const refreshWindowFor = (walk, now = Date.now()) => {
  const snapshot = photoWindowFor(walk)
  const start = utcTime(snapshot.startDate)
  const end = utcTime(snapshot.endDate)
  if (end < start || end > now) throw new Error('Walk has not finished yet')
  return {
    startDate: new Date(start - 3600000).toISOString(),
    endDate: new Date(Math.min(end + 3600000, now)).toISOString(),
  }
}

const writeJson = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o660 })
  fs.renameSync(temporary, file)
}

// A request persists across worker restarts. Only the ashserver consumer writes
// its acknowledgement, after a successful download AND verified archive ingest.
export const requestPhotoRefresh = ({ walk, queueRoot, now = Date.now(), retry = false }) => {
  const id = assertSafeWalkId(walk.id)
  for (const directory of ['requests', 'results']) {
    fs.mkdirSync(path.join(queueRoot, directory), { recursive: true, mode: 0o770 })
  }
  const requestPath = path.join(queueRoot, 'requests', `${id}.json`)
  const resultPath = path.join(queueRoot, 'results', `${id}.json`)
  let request = fs.existsSync(requestPath) ? JSON.parse(fs.readFileSync(requestPath, 'utf8')) : null
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null
  const completed = request && result?.status === 'complete' && result.requestedAt === request.requestedAt
  if (!request || (retry && completed && now - Date.parse(result.completedAt) >= 1800000)) {
    request = { schemaVersion: 1, walkId: id, ...refreshWindowFor(walk, now), requestedAt: new Date(now).toISOString() }
    writeJson(requestPath, request)
    return { ready: false, request }
  }
  return { ready: Boolean(completed), request }
}
