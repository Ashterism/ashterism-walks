import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  matchPhotoCandidates,
  routeCoordinatesFrom,
  scanMonth,
} from './lib/photo-matching.js'

const execute = promisify(execFile)
const inputs = process.argv.slice(2)
const option = (name, fallback) => {
  const index = inputs.indexOf(name)
  return index === -1 ? fallback : inputs[index + 1]
}

const walkId = option('--walk', 'photo-20220417')
const archiveRoot = path.resolve(option('--archive', '/Volumes/photo/Photos'))
const port = Number(option('--port', '4175'))
const walkPath = path.resolve(`data/walks/${walkId}.json`)

if (!fs.existsSync(walkPath)) throw new Error(`Unknown walk: ${walkId}`)
const walk = JSON.parse(fs.readFileSync(walkPath, 'utf8'))
const snapshot = walk.sources?.photoArchive?.snapshot
if (!snapshot?.startDate || !snapshot?.endDate) {
  throw new Error(`${walkId} has no photo-archive time window`)
}

const localDate = snapshot.date ?? snapshot.startDate.slice(0, 10)
const [year, month] = localDate.split('-')
const monthDirectory = path.join(archiveRoot, year, month)
if (!fs.existsSync(monthDirectory)) throw new Error(`Archive month not found: ${monthDirectory}`)

const routePath = path.resolve(
  `data/route-versions/${walkId}/${walk.route.activeVersion}.geojson`,
)
const route = JSON.parse(fs.readFileSync(routePath, 'utf8'))
const candidates = matchPhotoCandidates({
  photos: scanMonth(monthDirectory, archiveRoot),
  routeCoordinates: routeCoordinatesFrom(route),
  startTime: Date.parse(snapshot.startDate),
  endTime: Date.parse(snapshot.endDate),
})

const privateDirectory = path.resolve('private/photo-reviews')
const decisionPath = path.join(privateDirectory, `${walkId}.json`)
const cacheDirectory = path.join(privateDirectory, 'cache', walkId)
fs.mkdirSync(privateDirectory, { recursive: true })
fs.mkdirSync(cacheDirectory, { recursive: true })

const emptyReview = {
  schemaVersion: 1,
  walkId,
  updatedAt: null,
  decisions: {},
}
const review = fs.existsSync(decisionPath)
  ? JSON.parse(fs.readFileSync(decisionPath, 'utf8'))
  : emptyReview
const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))

const saveReview = () => {
  review.updatedAt = new Date().toISOString()
  const temporary = `${decisionPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(review, null, 2)}\n`)
  fs.renameSync(temporary, decisionPath)
}

const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

const serveMedia = async (response, candidate, thumbnail = false) => {
  if (!candidate) return json(response, 404, { error: 'Unknown photograph' })
  const convert =
    thumbnail || candidate.extension === '.heic' || candidate.extension === '.heif'
  let source = candidate.mediaPath
  let contentType = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }[candidate.extension]

  if (convert) {
    source = path.join(
      cacheDirectory,
      `${candidate.id}${thumbnail ? '-thumb' : ''}.jpg`,
    )
    contentType = 'image/jpeg'
    if (!fs.existsSync(source)) {
      await execute('/usr/bin/sips', [
        ...(thumbnail ? ['-Z', '640'] : []),
        '-s',
        'format',
        'jpeg',
        candidate.mediaPath,
        '--out',
        source,
      ])
    }
  }

  response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' })
  fs.createReadStream(source).pipe(response)
}

const readBody = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const normaliseDecision = (decision) => {
  const candidate = candidateById.get(decision.id)
  if (!candidate) throw new Error('Unknown photograph')
  if (!['unreviewed', 'keep', 'reject'].includes(decision.status)) {
    throw new Error('Invalid status')
  }
  if (!['public', 'private'].includes(decision.visibility)) {
    throw new Error('Invalid visibility')
  }
  const rotation = Number(decision.rotation)
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new Error('Invalid rotation')
  }
  return {
    id: decision.id,
    value: {
      archiveRelativePath: candidate.archiveRelativePath,
      capturedAt: candidate.capturedAtIso,
      status: decision.status,
      visibility: decision.visibility,
      rotation,
      caption: String(decision.caption ?? '').trim(),
      reviewedAt: new Date().toISOString(),
    },
  }
}

const clientPath = path.resolve('scripts/photo-review-ui.html')
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return response.end(fs.readFileSync(clientPath))
    }
    if (request.method === 'GET' && url.pathname === '/api/session') {
      return json(response, 200, {
        walk: { id: walk.id, name: walk.local.name, date: localDate },
        candidates: candidates.map(({ mediaPath, ...candidate }) => candidate),
        review,
      })
    }
    if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
      return serveMedia(
        response,
        candidateById.get(url.pathname.split('/').pop()),
        url.searchParams.get('size') === 'thumb',
      )
    }
    if (request.method === 'POST' && url.pathname === '/api/decision') {
      const decision = await readBody(request)
      const normalised = normaliseDecision(decision)
      review.decisions[normalised.id] = normalised.value
      saveReview()
      return json(response, 200, { ok: true, updatedAt: review.updatedAt })
    }
    if (request.method === 'POST' && url.pathname === '/api/decisions') {
      const body = await readBody(request)
      if (!Array.isArray(body.decisions) || body.decisions.length === 0) {
        return json(response, 400, { error: 'No decisions supplied' })
      }
      const normalised = body.decisions.map(normaliseDecision)
      normalised.forEach(({ id, value }) => { review.decisions[id] = value })
      saveReview()
      return json(response, 200, {
        ok: true,
        count: normalised.length,
        updatedAt: review.updatedAt,
      })
    }
    return json(response, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(response, 500, { error: error.message })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Photo review: http://127.0.0.1:${port}`)
  console.log(`${candidates.length} candidates for ${walk.local.name}`)
  console.log(`Decisions: ${decisionPath}`)
})
