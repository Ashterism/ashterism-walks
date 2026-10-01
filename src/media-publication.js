export const MEDIA_API_BASE_URL = 'https://media.ashterism.com'
export const PRIVATE_PHOTO_ROLE = 'walks.private_photos'

const responseError = async (response) => {
  let detail = ''
  try {
    detail = (await response.json()).error ?? ''
  } catch {
    // The Media service can also return an empty/non-JSON error response.
  }
  return new Error(`${detail || 'Media request failed'} (${response.status})`)
}

export const requestMediaJson = async (
  path,
  token,
  options = {},
  baseUrl = MEDIA_API_BASE_URL,
) => {
  if (!path?.startsWith('/v1/')) throw new Error('Invalid Ashterix Media path')
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) throw await responseError(response)
  return response.json()
}

export const createMediaCollection = ({ title, description, token, baseUrl }) =>
  requestMediaJson(
    '/v1/collections',
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    },
    baseUrl,
  )

export const uploadMediaAsset = ({
  collectionId,
  file,
  filename,
  metadata,
  token,
  baseUrl,
}) => {
  const body = new FormData()
  body.append('metadata', JSON.stringify(metadata))
  body.append('file', file, filename ?? file.name)
  return requestMediaJson(
    `/v1/collections/${collectionId}/assets`,
    token,
    { method: 'POST', body },
    baseUrl,
  )
}

export const patchMediaAsset = ({ assetId, metadata, token, baseUrl }) =>
  requestMediaJson(
    `/v1/assets/${assetId}`,
    token,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    },
    baseUrl,
  )
