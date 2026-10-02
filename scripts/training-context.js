import fs from 'node:fs'
import path from 'node:path'

import {
  getIntervalsJson,
  intervalsApiRoot,
} from './lib/intervals-api.js'
import { buildTrainingContext } from './lib/training-context.js'

const argumentsList = process.argv.slice(2)
const readArgument = (name) => {
  const index = argumentsList.indexOf(name)
  if (index !== -1) return argumentsList[index + 1]
  return argumentsList.find((value) => value.startsWith(`${name}=`))?.slice(
    name.length + 1,
  )
}

const days = Number.parseInt(readArgument('--days') ?? '14', 10)
if (!Number.isInteger(days) || days < 1 || days > 90) {
  throw new Error('--days must be an integer from 1 to 90')
}

const today = new Date()
const oldestDate = new Date(today)
oldestDate.setUTCDate(oldestDate.getUTCDate() - days + 1)
const newest = today.toISOString().slice(0, 10)
const oldest = oldestDate.toISOString().slice(0, 10)

const urlFor = (resource) => {
  const url = new URL(`${intervalsApiRoot}/athlete/0/${resource}`)
  url.searchParams.set('oldest', oldest)
  url.searchParams.set('newest', newest)
  return url
}

const [activities, wellness] = await Promise.all([
  getIntervalsJson(urlFor('activities')),
  getIntervalsJson(urlFor('wellness')),
])
const context = buildTrainingContext({
  activities,
  wellness,
  oldest,
  newest,
})
const json = `${JSON.stringify(context, null, 2)}\n`

if (argumentsList.includes('--stdout')) {
  process.stdout.write(json)
} else {
  const outputPath = readArgument('--output') ?? 'private/training-context.json'
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, json, { mode: 0o600 })
  fs.renameSync(temporaryPath, outputPath)
  console.log(`Private training context written to ${outputPath}`)
}
