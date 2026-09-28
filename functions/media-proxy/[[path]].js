const MEDIA_ORIGIN = 'https://media.ashterism.com'
const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PATCH'])

export const onRequest = async ({ request, params }) => {
  if (!allowedMethods.has(request.method)) {
    return new Response('Method not allowed', { status: 405 })
  }

  const path = Array.isArray(params.path) ? params.path.join('/') : params.path
  if (!path?.startsWith('v1/')) return new Response('Not found', { status: 404 })

  const incoming = new URL(request.url)
  const target = new URL(`/${path}${incoming.search}`, MEDIA_ORIGIN)
  const headers = new Headers()
  for (const name of ['authorization', 'content-type', 'accept', 'range']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  })
  const outgoingHeaders = new Headers()
  for (const name of [
    'cache-control',
    'content-length',
    'content-type',
    'etag',
    'last-modified',
    'vary',
  ]) {
    const value = upstream.headers.get(name)
    if (value) outgoingHeaders.set(name, value)
  }
  outgoingHeaders.set('X-Content-Type-Options', 'nosniff')

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outgoingHeaders,
  })
}
