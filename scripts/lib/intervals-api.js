import { execFileSync } from 'node:child_process'

export const intervalsApiRoot = 'https://intervals.icu/api/v1'

const keychainAccount = 'ashterism-walks'
const keychainService = 'intervals.icu'

export const getIntervalsApiKey = () => {
  const environmentKey = process.env.INTERVALS_ICU_API_KEY?.trim()
  if (environmentKey) return environmentKey

  if (process.platform === 'darwin') {
    try {
      return execFileSync(
        'security',
        [
          'find-generic-password',
          '-a',
          keychainAccount,
          '-s',
          keychainService,
          '-w',
        ],
        { encoding: 'utf8' },
      ).trim()
    } catch {
      // Automated environments use the environment variable above.
    }
  }

  throw new Error(
    'Intervals API key unavailable. Set INTERVALS_ICU_API_KEY or store it in the configured macOS Keychain entry.',
  )
}

let authorization

export const requestIntervals = async (url) => {
  authorization ??= `Basic ${Buffer.from(
    `API_KEY:${getIntervalsApiKey()}`,
  ).toString('base64')}`

  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
      Accept: 'application/json, application/octet-stream',
    },
  })

  if (!response.ok) {
    throw new Error(`Intervals request failed with HTTP ${response.status}`)
  }

  return response
}

export const getIntervalsJson = async (url) => {
  const response = await requestIntervals(url)
  return response.json()
}
