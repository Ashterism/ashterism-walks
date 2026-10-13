export const isWalkVisible = (walk, showWalks = false) =>
  showWalks || walk.activity !== 'walking' ||
  (walk.postRun !== true && !walk.providers?.includes('Garmin'))

export const activityLabel = (walk) =>
  walk.activity === 'walking' && walk.postRun === true
    ? 'WALKING · POST-RUN'
    : walk.activity === 'hiking' ? 'Hiking' : 'Walking'
