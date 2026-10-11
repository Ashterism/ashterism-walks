import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync(
  new URL('../../.github/workflows/site.yml', import.meta.url),
  'utf8',
)
const build = workflow.split('\n  build:\n')[1]?.split('\n  deploy:\n')[0]
const deploy = workflow.split('\n  deploy:\n')[1]

test('a waiting Pages deployment cannot hold the activity sync lock', () => {
  assert.ok(build && deploy, 'both workflow jobs must exist')
  assert.doesNotMatch(workflow, /^concurrency:/m)
  const buildGroup = build.match(/^      group: (.+)$/m)?.[1]
  const deployGroup = deploy.match(/^      group: (.+)$/m)?.[1]
  assert.ok(buildGroup && deployGroup, 'each job must have its own concurrency group')
  assert.notEqual(buildGroup, deployGroup)
  assert.match(build, /^      cancel-in-progress: false$/m)
  assert.match(deploy, /^      cancel-in-progress: true$/m)
  assert.match(deploy, /^    needs: build$/m)
})

test('queued syncs check out the branch head instead of the stale dispatch SHA', () => {
  assert.match(build, /uses: actions\/checkout@v6\n        with:\n(?:          #.*\n)*          ref: \$\{\{ github.ref_name \}\}/)
})

test('Cloudflare remains the scheduler and sync retains permission to commit data', () => {
  assert.doesNotMatch(workflow, /^  schedule:/m)
  assert.match(workflow, /^  workflow_dispatch:/m)
  assert.match(workflow, /^  contents: write$/m)
  assert.match(build, /run: npm run sync\n/)
  assert.match(build, /git add data public\/data\n/)
  assert.match(build, /git push\n/)
})
