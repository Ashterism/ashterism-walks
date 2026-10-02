const definedEntries = (value) =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item != null),
  )

const rounded = (value) =>
  Number.isFinite(value) ? Math.round(value * 10) / 10 : null

const formFrom = (fitness, fatigue) =>
  Number.isFinite(fitness) && Number.isFinite(fatigue)
    ? rounded(fitness - fatigue)
    : null

const mapActivity = (activity) =>
  definedEntries({
    id: activity.id == null ? null : String(activity.id),
    startAt: activity.start_date ?? null,
    localStartAt: activity.start_date_local ?? null,
    name: activity.name ?? null,
    type: activity.type ?? null,
    source: activity.source ?? null,
    distanceM: activity.icu_distance ?? activity.distance ?? null,
    movingTimeSeconds: activity.moving_time ?? null,
    elapsedTimeSeconds: activity.elapsed_time ?? null,
    elevationGainM: activity.total_elevation_gain ?? null,
    trainingLoad: activity.icu_training_load ?? null,
    intensity: activity.icu_intensity ?? null,
    averageHeartRateBpm: activity.average_heartrate ?? null,
    maxHeartRateBpm: activity.max_heartrate ?? null,
    calories: activity.calories ?? null,
    weightLiftedKg: activity.kg_lifted ?? null,
    fitnessAfter: activity.icu_ctl ?? null,
    fatigueAfter: activity.icu_atl ?? null,
    formAfter: formFrom(activity.icu_ctl, activity.icu_atl),
  })

const mapLoad = (day) =>
  definedEntries({
    date: day.id ?? null,
    fitness: day.ctl ?? null,
    fatigue: day.atl ?? null,
    form: formFrom(day.ctl, day.atl),
    rampRate: day.rampRate ?? null,
    fitnessLoad: day.ctlLoad ?? null,
    fatigueLoad: day.atlLoad ?? null,
  })

const wellnessFields = {
  restingHeartRateBpm: 'restingHR',
  hrvRmssdMs: 'hrv',
  hrvSdnnMs: 'hrvSDNN',
  sleepSeconds: 'sleepSecs',
  sleepScore: 'sleepScore',
  averageSleepingHeartRateBpm: 'avgSleepingHR',
  soreness: 'soreness',
  fatigue: 'fatigue',
  stress: 'stress',
  mood: 'mood',
  motivation: 'motivation',
  injury: 'injury',
  readiness: 'readiness',
  bloodOxygenPercent: 'spO2',
  weightKg: 'weight',
}

const mapWellness = (day) =>
  definedEntries({
    date: day.id ?? null,
    ...Object.fromEntries(
      Object.entries(wellnessFields).map(([output, input]) => [
        output,
        day[input] ?? null,
      ]),
    ),
  })

const hasWellnessValue = (day) => Object.keys(day).some((key) => key !== 'date')

const total = (items, field) =>
  rounded(
    items.reduce(
      (sum, item) => sum + (Number.isFinite(item[field]) ? item[field] : 0),
      0,
    ),
  )

export const buildTrainingContext = ({
  activities,
  wellness,
  oldest,
  newest,
  generatedAt = new Date().toISOString(),
}) => {
  if (!Array.isArray(activities) || !Array.isArray(wellness)) {
    throw new Error('Intervals returned an unexpected training response')
  }

  const mappedActivities = activities
    .map(mapActivity)
    .sort((first, second) =>
      String(second.startAt ?? second.localStartAt).localeCompare(
        String(first.startAt ?? first.localStartAt),
      ),
    )
  const loadHistory = wellness.map(mapLoad).sort((first, second) =>
    String(first.date).localeCompare(String(second.date)),
  )
  const wellnessDays = wellness
    .map(mapWellness)
    .filter(hasWellnessValue)
    .sort((first, second) =>
      String(first.date).localeCompare(String(second.date)),
    )
  const types = mappedActivities.reduce((counts, activity) => {
    const type = activity.type ?? 'Unknown'
    counts[type] = (counts[type] ?? 0) + 1
    return counts
  }, {})

  return {
    schemaVersion: 1,
    generatedAt,
    period: { oldest, newest },
    summary: {
      activityCount: mappedActivities.length,
      totalDistanceM: total(mappedActivities, 'distanceM'),
      totalMovingTimeSeconds: total(mappedActivities, 'movingTimeSeconds'),
      totalTrainingLoad: total(mappedActivities, 'trainingLoad'),
      activitiesByType: types,
    },
    activities: mappedActivities,
    load: {
      current: loadHistory.at(-1) ?? null,
      history: loadHistory,
    },
    wellness: {
      availableMetrics: Object.keys(wellnessFields).filter((field) =>
        wellnessDays.some((day) => day[field] != null),
      ),
      days: wellnessDays,
    },
  }
}
