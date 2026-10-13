// Set to the existing scheduler's deployed URL; no browser persistence is used.
export const PREFERENCES_URL = 'https://ashterism-walks-sync.ashleybladon.workers.dev/api/preferences'

export const createWalkPreferences = ({ getAccessToken, onChange, fetchImpl = fetch }) => {
  let generation = 0
  let state = { showWalks: false, busy: false, error: '' }
  const emit = (change) => { state = { ...state, ...change }; onChange(state) }
  const reset = () => {
    generation += 1
    emit({ showWalks: false, busy: false, error: '' })
  }
  const request = async (token, method, showWalks) => {
    const response = await fetchImpl(PREFERENCES_URL, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}) },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      ...(method === 'PUT' ? { body: JSON.stringify({ showWalks }) } : {}),
    })
    if (response.status === 401) throw new Error('Sign out and back in to load your setting.')
    if (!response.ok) throw new Error('Preference request failed')
    const body = await response.json()
    if (typeof body.showWalks !== 'boolean') throw new Error('Invalid preference response')
    return body.showWalks
  }
  const load = async () => {
    reset()
    const token = getAccessToken()
    if (!token) return
    const current = generation
    emit({ busy: true })
    try {
      const showWalks = await request(token, 'GET')
      if (current === generation) emit({ showWalks, busy: false })
    } catch (error) {
      if (current === generation) emit({ busy: false, error: error.message.startsWith('Sign out') ? error.message : 'Could not load your setting. Change it to try saving again.' })
    }
  }
  const set = async (showWalks) => {
    const token = getAccessToken()
    if (!token || state.busy) return
    const previous = state.showWalks
    const current = generation
    emit({ showWalks, busy: true, error: '' })
    try {
      const saved = await request(token, 'PUT', showWalks)
      if (current === generation) emit({ showWalks: saved, busy: false })
    } catch {
      if (current === generation) emit({ showWalks: previous, busy: false, error: 'Could not save your setting. Please try again.' })
    }
  }
  return { load, set, reset, getShowWalks: () => state.showWalks }
}
