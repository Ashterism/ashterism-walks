import { assertSafeWalkId } from './canonical-walks.js'
import { photoWindowFor } from './prepare-photo-candidates.js'

export const PHOTO_RETRY_WINDOW_MS = 48 * 60 * 60 * 1000

export const addedWalkIds = (diff) => [...new Set(diff.split('\n').flatMap((line) => {
  const match = line.match(/^A\s+data\/walks\/([^/]+)\.json$/)
  if (!match) return []
  try { return [assertSafeWalkId(match[1])] } catch { return [] }
}))]

export const isRecentWalk = (walk, now = Date.now()) => {
  if (walk.postRun === true) return false
  try {
    const started = Date.parse(photoWindowFor(walk).startDate)
    return Number.isFinite(started) && started <= now + 86400000 && started >= now - 7 * 86400000
  } catch {
    return false
  }
}

export const prunePhotoRetries = (state, now = Date.now()) => {
  state.pendingWalkIds = [...new Set(state.pendingWalkIds ?? [])]
  state.retryUntilByWalkId ??= {}

  for (const id of state.pendingWalkIds) {
    if (!Number.isFinite(Number(state.retryUntilByWalkId[id]))) {
      state.retryUntilByWalkId[id] = now + PHOTO_RETRY_WINDOW_MS
    }
  }

  state.pendingWalkIds = state.pendingWalkIds.filter((id) => {
    if (Number(state.retryUntilByWalkId[id]) > now) return true
    delete state.retryUntilByWalkId[id]
    return false
  })

  for (const id of Object.keys(state.retryUntilByWalkId)) {
    if (!state.pendingWalkIds.includes(id)) delete state.retryUntilByWalkId[id]
  }

  return state
}

export const queuePhotoRetry = (state, id, now = Date.now()) => {
  prunePhotoRetries(state, now)
  if (!state.pendingWalkIds.includes(id)) state.pendingWalkIds.push(id)
  if (!Number.isFinite(Number(state.retryUntilByWalkId[id]))) {
    state.retryUntilByWalkId[id] = now + PHOTO_RETRY_WINDOW_MS
  }
  return state
}
