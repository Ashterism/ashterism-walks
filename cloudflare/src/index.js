import { handlePreferences } from './preferences.js'

const dispatchUrl =
  'https://api.github.com/repos/Ashterism/ashterism-walks/actions/workflows/site.yml/dispatches'

export const dispatchSync = async (githubToken, fetchImpl = fetch) => {
  const response = await fetchImpl(dispatchUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ashterism-walks-cloudflare-scheduler',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: JSON.stringify({ ref: 'main' }),
  })

  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 500)
    throw new Error(
      `GitHub workflow dispatch failed with HTTP ${response.status}: ${responseBody}`,
    )
  }
}

export const isDispatchHour = (scheduledTime) => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(scheduledTime)))
  return hour >= 6 && hour <= 23
}

export default {
  async fetch(request, env) {
    if (request && new URL(request.url).pathname === '/api/preferences') {
      return handlePreferences(request, env)
    }
    return Response.json({
      service: 'ashterism-walks-sync',
      status: 'ok',
      schedule: 'hourly; dispatch 06:00–23:00 Europe/London',
    })
  },

  async scheduled(controller, env) {
    const startedAt = new Date(controller.scheduledTime).toISOString()
    if (!isDispatchHour(controller.scheduledTime)) {
      console.log(JSON.stringify({ event: 'sync_dispatch_skipped', startedAt, reason: 'outside_dispatch_window' }))
      return
    }
    console.log(JSON.stringify({ event: 'sync_dispatch_started', startedAt }))

    await dispatchSync(env.GITHUB_TOKEN)

    console.log(JSON.stringify({ event: 'sync_dispatch_completed', startedAt }))
  },
}
