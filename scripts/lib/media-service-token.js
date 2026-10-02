const zitadelIssuer = 'https://ashterix-mkjzns.eu1.zitadel.cloud'
const mediaProjectId = '389018638520205980'

export const mediaServiceScopes = [
  'openid',
  `urn:zitadel:iam:org:project:id:${mediaProjectId}:aud`,
  'urn:zitadel:iam:org:projects:roles',
].join(' ')

export const mediaServiceToken = async ({
  clientId = process.env.ZITADEL_MEDIA_CLIENT_ID,
  clientSecret = process.env.ZITADEL_MEDIA_CLIENT_SECRET,
  fetchImpl = fetch,
} = {}) => {
  if (!clientId || !clientSecret) {
    throw new Error(
      'Set ZITADEL_MEDIA_CLIENT_ID and ZITADEL_MEDIA_CLIENT_SECRET for the Media service account',
    )
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const response = await fetchImpl(`${zitadelIssuer}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: mediaServiceScopes,
    }),
  })
  if (!response.ok) {
    throw new Error(`Media service-account token request failed (${response.status})`)
  }

  const result = await response.json()
  if (result.token_type?.toLowerCase() !== 'bearer' ||
      typeof result.access_token !== 'string' ||
      result.access_token.split('.').length !== 3) {
    throw new Error('Media service account must issue JWT bearer access tokens')
  }
  return result.access_token
}
