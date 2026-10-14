const cutoffDate = '2026-10-14'
const maximumGapSeconds = 5 * 60

const activityStart = (activity) =>
  Date.parse(activity.start_date ?? activity.start_date_local ?? '')

const localActivityDate = (activity) =>
  String(activity.start_date_local ?? activity.start_date ?? '').slice(0, 10)

export const isPostRunWalk = (walk, activities) => {
  if (localActivityDate(walk) < cutoffDate) return false
  if (String(walk.effectiveType ?? walk.type).toLowerCase() !== 'walk') {
    return false
  }

  const walkStart = activityStart(walk)
  if (!Number.isFinite(walkStart)) return false

  return activities.some((run) => {
    if (
      String(run.id) === String(walk.id) ||
      run.source !== 'GARMIN_CONNECT' ||
      run.file_type !== 'fit' ||
      String(run.type).toLowerCase() !== 'run'
    ) return false

    const runStart = activityStart(run)
    const elapsedSeconds = Number(run.elapsed_time)
    if (
      !Number.isFinite(runStart) ||
      run.elapsed_time == null ||
      !Number.isFinite(elapsedSeconds)
    ) {
      return false
    }

    const gapSeconds = (walkStart - (runStart + elapsedSeconds * 1000)) / 1000
    return gapSeconds >= 0 && gapSeconds <= maximumGapSeconds
  })
}

export const preserveManualPostRun = (record, matched) => {
  if (Object.hasOwn(record.local ?? {}, 'postRun') || !matched) return record
  return { ...record, local: { ...record.local, postRun: true } }
}
