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

export default {
  async fetch() {
    return Response.json({
      service: 'ashterism-walks-sync',
      status: 'ok',
      schedule: 'every 15 minutes',
    })
  },

  async scheduled(controller, env) {
    const startedAt = new Date(controller.scheduledTime).toISOString()
    console.log(JSON.stringify({ event: 'sync_dispatch_started', startedAt }))

    await dispatchSync(env.GITHUB_TOKEN)

    console.log(JSON.stringify({ event: 'sync_dispatch_completed', startedAt }))
  },
}
