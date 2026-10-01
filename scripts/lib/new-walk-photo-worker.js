import { assertSafeWalkId } from './canonical-walks.js'
import { photoWindowFor } from './prepare-photo-candidates.js'

export const addedWalkIds = (diff) => [...new Set(diff.split('\n').flatMap((line) => {
  const match = line.match(/^A\s+data\/walks\/([^/]+)\.json$/)
  if (!match) return []
  try { return [assertSafeWalkId(match[1])] } catch { return [] }
}))]

export const isRecentWalk = (walk, now = Date.now()) => {
  try {
    const started = Date.parse(photoWindowFor(walk).startDate)
    return Number.isFinite(started) && started <= now + 86400000 && started >= now - 7 * 86400000
  } catch {
    return false
  }
}
