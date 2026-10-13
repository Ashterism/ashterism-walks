import { createRemoteJWKSet, jwtVerify } from 'jose'

export const ISSUER = 'https://ashterix-mkjzns.eu1.zitadel.cloud'
export const AUDIENCE = '388903513951875876'
const keys = createRemoteJWKSet(new URL(`${ISSUER}/oauth/v2/keys`))

export const verifyAccessToken = async (token, keySet = keys) => {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat'],
  })
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Missing subject')
  return payload.sub
}

// The only storage key comes from the verified token, never a request parameter.
export const handlePreferences = async (request, env, verify = verifyAccessToken) => {
  const origin = request.headers.get('Origin')
  const allowed = (env.WALKS_ORIGINS ?? '').split(',').includes(origin)
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Origin' }
  if (!allowed) return Response.json({ error: 'Origin not allowed' }, { status: 403, headers })
  Object.assign(headers, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  })
  const reply = (body, status = 200) => Response.json(body, { status, headers })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (!['GET', 'PUT'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405)
  const bearer = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1]
  let subject
  try {
    if (!bearer) throw new Error('Missing token')
    subject = await verify(bearer)
  } catch {
    return reply({ error: 'Invalid or expired access token' }, 401)
  }
  if (!env.WALK_PREFERENCES) return reply({ error: 'Preferences unavailable' }, 503)
  const key = `walks:${subject}`
  try {
    if (request.method === 'GET') {
      const saved = await env.WALK_PREFERENCES.get(key, 'json')
      return reply({ showWalks: saved?.showWalks === true })
    }
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
      return reply({ error: 'Expected JSON' }, 415)
    }
    // One boolean only; reject caller-supplied identities and extra settings.
    const raw = await request.text()
    if (raw.length > 128) return reply({ error: 'Invalid preference' }, 400)
    let body
    try { body = JSON.parse(raw) } catch { return reply({ error: 'Invalid JSON' }, 400) }
    if (!body || typeof body.showWalks !== 'boolean' || Object.keys(body).length !== 1) {
      return reply({ error: 'Expected only showWalks boolean' }, 400)
    }
    await env.WALK_PREFERENCES.put(key, JSON.stringify({ showWalks: body.showWalks }))
    return reply({ showWalks: body.showWalks })
  } catch {
    return reply({ error: 'Preferences unavailable' }, 503)
  }
}
