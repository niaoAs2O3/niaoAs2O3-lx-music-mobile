const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const schedulerPath = path.resolve(__dirname, '../src/core/download/scheduler.ts')
const schedulerCode = ts.transpileModule(fs.readFileSync(schedulerPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const schedulerModule = new Module(schedulerPath)
schedulerModule.filename = schedulerPath
schedulerModule.paths = Module._nodeModulePaths(path.dirname(schedulerPath))
schedulerModule._compile(schedulerCode, schedulerPath)

const {
  DownloadScheduler,
  MAX_CONCURRENT_DOWNLOADS,
  createDownloadTaskKey,
} = schedulerModule.exports

const nextTick = () => new Promise(resolve => setImmediate(resolve))

test('uses source, song id, and requested quality for the task key', () => {
  assert.notEqual(
    createDownloadTaskKey('kw', 'same-id', 'flac24bit'),
    createDownloadTaskKey('kg', 'same-id', 'flac24bit'),
  )
  assert.notEqual(
    createDownloadTaskKey('kw', 'same-id', 'flac24bit'),
    createDownloadTaskKey('kw', 'same-id', '320k'),
  )
})

test('limits task retries centrally without native retry stacking', () => {
  const coreDownload = fs.readFileSync(path.resolve(__dirname, '../src/core/download/index.ts'), 'utf8')
  const nativeDownload = fs.readFileSync(path.resolve(__dirname, '../android/app/src/main/java/cn/toside/music/mobile/download/ResumableDownloadModule.java'), 'utf8')

  assert.match(coreDownload, /const MAX_AUTO_RETRIES = 2/)
  assert.match(nativeDownload, /private static final int MAX_ATTEMPTS = 1/)
  assert.match(nativeDownload, /\.retryOnConnectionFailure\(false\)/)
})

test('playlist download action catches page-load failures', () => {
  const actionBar = fs.readFileSync(path.resolve(__dirname, '../src/screens/SonglistDetail/ActionBar.tsx'), 'utf8')

  assert.match(actionBar, /void downloadSonglist\(info\.source, info\.id\)\.catch\(/)
  assert.match(actionBar, /toast\(`歌单下载未完全加入：\$\{message\}`/)
})

test('single, selected, and paginated playlist downloads use the queue entry points', () => {
  const coreDownload = fs.readFileSync(path.resolve(__dirname, '../src/core/download/index.ts'), 'utf8')

  assert.match(coreDownload, /downloadMusic = async\(musicInfo[^]*enqueueMusicInfos\(\[musicInfo\], false\)/)
  assert.match(coreDownload, /downloadMusicList = async\(musicInfos[^]*enqueueMusicInfos\(musicInfos, true\)/)
  assert.match(coreDownload, /do \{[^]*await getListDetail\(id, source, page\)[^]*enqueueMusicInfos\(detail\.list, true\)[^]*\} while \(page <= totalPages\)/)
})

test('never runs more than two queued downloads at once', async() => {
  let active = 0
  let maxActive = 0
  const started = []
  const completed = []
  const releases = new Map()
  const scheduler = new DownloadScheduler(async id => {
    active++
    maxActive = Math.max(maxActive, active)
    started.push(id)
    await new Promise(resolve => releases.set(id, resolve))
    active--
    completed.push(id)
  })

  for (let index = 0; index < 100; index++) scheduler.enqueue('task-' + index)
  await nextTick()

  assert.equal(MAX_CONCURRENT_DOWNLOADS, 2)
  assert.equal(started.length, 2)
  assert.equal(scheduler.activeCount, 2)
  assert.equal(maxActive, 2)

  while (completed.length < 100) {
    const [id, release] = releases.entries().next().value
    releases.delete(id)
    release()
    await nextTick()
  }

  assert.equal(completed.length, 100)
  assert.equal(scheduler.activeCount, 0)
  assert.equal(scheduler.pendingCount, 0)
  assert.equal(maxActive, 2)
})

test('releases a slot after failures so later downloads continue', async() => {
  let active = 0
  let maxActive = 0
  const started = []
  const completed = []
  const scheduler = new DownloadScheduler(async id => {
    active++
    maxActive = Math.max(maxActive, active)
    started.push(id)
    await nextTick()
    active--
    if (id == 'task-1' || id == 'task-2') throw new Error('network failure')
    completed.push(id)
  })

  for (let index = 0; index < 10; index++) scheduler.enqueue('task-' + index)
  for (let index = 0; index < 20 && scheduler.activeCount + scheduler.pendingCount; index++) await nextTick()

  assert.deepEqual(started, Array.from({ length: 10 }, (_, index) => 'task-' + index))
  assert.equal(completed.length, 8)
  assert.equal(scheduler.activeCount, 0)
  assert.equal(scheduler.pendingCount, 0)
  assert.equal(maxActive <= MAX_CONCURRENT_DOWNLOADS, true)
})
