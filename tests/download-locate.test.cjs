const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const makeTask = (id, name = id, status = 'completed', songId = id) => ({
  id,
  status,
  isComplate: status == 'completed',
  progress: 100,
  total: 100,
  statusText: status,
  metadata: { musicInfo: { id: songId, source: 'kg', name, singer: name }, quality: '320k', ext: 'mp3' },
})

async function mountDownload(initialItems = [], { initError = false, theme = {}, scale = 1 } = {}) {
  const cells = []
  const effects = []
  const cleanups = []
  const scrolls = []
  const calls = []
  const messages = []
  let cursor = 0
  let tree
  let items = initialItems
  let resolveInit
  const initialized = new Promise(resolve => { resolveInit = resolve })
  const events = { app_event: new EventEmitter(), state_event: new EventEmitter() }
  const playerState = { playMusicInfo: { musicInfo: null, listId: null } }
  const cell = make => {
    const index = cursor++
    if (!(index in cells)) cells[index] = make()
    return index
  }
  const react = {
    useState: value => {
      const index = cell(() => value)
      return [cells[index], value => { cells[index] = value }]
    },
    useRef: value => cells[cell(() => ({ current: value }))],
    useMemo: compute => compute(),
    useEffect: callback => { cell(() => { effects.push(callback) }) },
  }
  const modules = {
    react,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { FlatList: 'FlatList', TouchableOpacity: 'TouchableOpacity', View: 'View', StyleSheet: { create: styles => styles } },
    '@/components/common/Text': { default: 'Text' },
    '@/components/common/Icon': { Icon: 'Icon' },
    '@/components/common/Menu': { default: 'Menu' },
    '@/components/common/Button': { default: 'Button' },
    '@/store/theme/hook': { useTheme: () => theme },
    '@/utils/pixelRatio': { scaleSizeH: size => size * scale, scaleSizeW: size => size * scale },
    '@/utils/tools': { createStyle: styles => styles, toast: text => messages.push(text) },
    '@/lang': { useI18n: () => key => key },
    '@/store/player/state': { default: playerState },
    '@/config/constant': { LIST_IDS: { DOWNLOAD: 'download' } },
    '@/core/player/player': { playList: (...args) => calls.push(['play', ...args]) },
    '@/core/download': {
      getDownloadList: () => items,
      initDownloadList: () => initialized.then(() => { if (initError) throw new Error('storage failure') }),
      ...Object.fromEntries(['pauseDownload', 'removeDownload', 'resumeDownload', 'retryDownload'].map(name => [name, id => calls.push([name, id])])),
    },
  }
  const load = file => {
    const exports = {}
    const filename = path.join(root, file)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, allowJs: true },
    }).outputText
    vm.runInNewContext(code, {
      exports,
      global: events,
      require: name => {
        if (name in modules) return modules[name]
        if (name == './state') return { default: playerState }
        throw new Error(`Unexpected import: ${name}`)
      },
    }, { filename })
    return exports
  }
  modules['@/store/player/hook'] = load('src/store/player/hook.ts')
  for (const [name, file] of [
    ['@/utils/playingList', 'src/utils/playingList.ts'],
    ['@/components/LocatePlayingButton', 'src/components/LocatePlayingButton.tsx'],
  ]) {
    if (fs.existsSync(path.join(root, file))) modules[name] = load(file)
  }
  const Component = load('src/screens/Home/Views/Download/index.js').default
  const descendants = (element, result = []) => {
    if (!element || typeof element != 'object') return result
    result.push(element)
    if (typeof element.type == 'function') descendants(element.type(element.props), result)
    const children = element.props?.children
    for (const child of Array.isArray(children) ? children : [children]) descendants(child, result)
    return result
  }
  const elements = () => descendants(tree)
  const find = type => elements().find(element => element.type == type)
  const render = () => {
    cursor = 0
    tree = Component()
    const list = find('FlatList')
    if (list.ref) list.ref.current = { scrollToIndex: options => scrolls.push(options) }
    while (effects.length) cleanups.push(effects.shift()())
  }
  const flush = async() => {
    await new Promise(resolve => setImmediate(resolve))
    render()
  }
  render()
  const button = () => elements().find(element => element.props?.accessibilityLabel == 'list_locate_playing' && element.type == 'Button')
  return {
    playerState,
    events,
    calls,
    scrolls,
    messages,
    theme,
    render,
    flush,
    button,
    list: () => find('FlatList').props,
    elements,
    initialize: async() => { resolveInit(); await flush() },
    update: async next => { items = next; events.app_event.emit('downloadListUpdate'); await flush() },
    setPlaying: musicInfo => {
      playerState.playMusicInfo = { musicInfo, listId: 'download' }
      events.state_event.emit('playMusicInfoChanged', playerState.playMusicInfo)
      render()
    },
    sort: value => { elements().find(element => element.type == 'Menu' && element.props.activeId != null).props.onPress({ action: value }); render() },
    press: () => { assert.ok(button(), 'Download page must expose a locate-playing button'); button().props.onPress() },
    row: index => find('FlatList').props.renderItem({ item: find('FlatList').props.data[index], index }),
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
  }
}

test('download page locates a playing task by ID and highlights it', async() => {
  const tasks = [makeTask('a'), makeTask('b')]
  const view = await mountDownload(tasks)
  await view.initialize()
  view.setPlaying({ ...tasks[1] })
  view.press()
  assert.equal(view.scrolls.at(-1).index, 1)
  assert.equal(view.list().extraData, 1)
  assert.equal(view.row(1).props.children[0].props.name, 'play-outline')
})

test('name, singer and status sorting locate the displayed task, not its queue index', async() => {
  const tasks = [makeTask('z', 'Z', 'failed'), makeTask('a', 'A', 'completed'), makeTask('b', 'B', 'pending')]
  const view = await mountDownload(tasks)
  await view.initialize()
  view.setPlaying({ ...tasks[1] })
  for (const sort of ['name', 'singer', 'status', 'default']) {
    view.sort(sort)
    view.press()
    const index = view.list().data.findIndex(task => task.id == 'a')
    assert.equal(view.scrolls.at(-1).index, index)
    assert.equal(view.list().extraData, index)
  }
  assert.deepEqual(tasks.map(task => task.id), ['z', 'a', 'b'])
})

test('different quality tasks for the same song locate only the playing task', async() => {
  const tasks = [makeTask('song-128k', 'Same', 'completed', 'same-song'), makeTask('song-flac', 'Same', 'completed', 'same-song')]
  const view = await mountDownload(tasks)
  await view.initialize()
  view.setPlaying({ ...tasks[1] })
  view.press()
  assert.equal(view.scrolls.at(-1).index, 1)
  await view.update([tasks[0]])
  view.press()
  assert.equal(view.scrolls.length, 1)
  assert.equal(view.messages.at(-1), 'list_locate_playing_missing')
  assert.equal(view.list().extraData, -1)
})

test('normal songs match source and ID; missing songs and an empty list only show feedback', async() => {
  const tasks = [makeTask('task-a', 'A', 'completed', 'song-a')]
  const view = await mountDownload(tasks)
  await view.initialize()
  view.press()
  assert.equal(view.messages.at(-1), 'list_locate_playing_empty')
  view.setPlaying({ id: 'song-a', source: 'tx' })
  view.press()
  assert.equal(view.scrolls.length, 0)
  assert.equal(view.messages.at(-1), 'list_locate_playing_missing')
  view.setPlaying({ id: 'song-a', source: 'kg' })
  view.press()
  assert.equal(view.scrolls.at(-1).index, 0)
  await view.update([])
  view.press()
  assert.equal(view.scrolls.length, 1)
  assert.equal(view.list().data.length, 0)
  assert.equal(view.messages.at(-1), 'list_locate_playing_missing')
})

test('track-change events update highlights and a press reads the latest player state', async() => {
  const tasks = [makeTask('a'), makeTask('b')]
  const view = await mountDownload(tasks)
  await view.initialize()
  view.setPlaying(tasks[0])
  assert.equal(view.list().extraData, 0)
  view.setPlaying(tasks[1])
  assert.equal(view.list().extraData, 1)
  view.playerState.playMusicInfo = { musicInfo: tasks[0] }
  view.press()
  assert.equal(view.scrolls.at(-1).index, 0)
  view.setPlaying(null)
  assert.equal(view.list().extraData, -1)
})

test('download status/progress updates re-sort the list while preserving task identity', async() => {
  const tasks = [makeTask('a', 'A', 'downloading'), makeTask('b', 'B', 'completed')]
  const view = await mountDownload(tasks)
  await view.initialize()
  view.sort('status')
  view.setPlaying({ ...tasks[1] })
  for (const status of ['pending', 'paused', 'failed', 'cancelled', 'completed', 'downloading']) {
    tasks[1].status = status
    tasks[1].progress = 45
    await view.update(tasks)
    view.press()
    const index = view.list().data.findIndex(task => task.id == 'b')
    assert.equal(view.scrolls.at(-1).index, index)
    assert.equal(view.list().extraData, index)
    assert.equal(view.row(index).props.children[0].props.name, 'play-outline')
  }
})

test('initialization, storage failure and unmounting do not leave state/listener errors', async() => {
  const task = makeTask('a')
  const view = await mountDownload([task])
  view.setPlaying(task)
  view.press()
  assert.equal(view.messages.at(-1), 'list_locate_playing_missing')
  await view.initialize()
  view.press()
  assert.equal(view.scrolls.at(-1).index, 0)
  view.unmount()
  assert.equal(view.events.app_event.listenerCount('downloadListUpdate'), 0)
  assert.equal(view.events.state_event.listenerCount('playMusicInfoChanged'), 0)
  const failure = await mountDownload([], { initError: true })
  await failure.initialize()
  assert.equal(failure.messages.at(-1), 'list_error')
  const closed = await mountDownload([task])
  closed.unmount()
  await closed.initialize()
  assert.equal(closed.list().data.length, 0)
})

test('long-list targets have exact layouts below the toolbar and above the floating control', async() => {
  const tasks = Array.from({ length: 2000 }, (_, index) => makeTask(`task-${index}`))
  const view = await mountDownload(tasks)
  await view.initialize()
  assert.equal(view.list().ListHeaderComponent, undefined)
  const listContainer = view.elements().find(element => element.type == 'View' && element.props.children?.[0]?.type == 'FlatList')
  assert.ok(listContainer, 'List and floating button must share a bounded container below the toolbar')
  const button = view.button().props.style
  const padding = view.list().contentContainerStyle.paddingBottom
  assert.ok(padding > button.bottom + button.height)
  for (const index of [0, 1001, 1999]) {
    view.setPlaying(tasks[index])
    view.press()
    const options = view.scrolls.at(-1)
    assert.equal(options.index, index)
    assert.equal(options.viewPosition, 0.3)
    const layout = view.list().getItemLayout(null, index)
    assert.equal(layout.length, view.row(index).props.style.height)
    assert.equal(layout.offset, index * layout.length)
    for (const viewport of [180, 400, 760]) {
      const maxOffset = tasks.length * layout.length + padding - viewport
      const offset = Math.max(0, Math.min(maxOffset, layout.offset - (viewport - layout.length) * options.viewPosition))
      assert.ok(layout.offset - offset >= 0)
      assert.ok(layout.offset - offset + layout.length <= viewport)
      assert.ok(layout.offset - offset + layout.length <= viewport - button.bottom - button.height)
    }
  }
})

test('both themes and small/large screen scales retain a circular touch target and translated label', async() => {
  for (const scale of [0.8, 1, 1.3]) {
    const theme = { 'c-content-background': '#fff', 'c-primary-font': '#26845b' }
    const view = await mountDownload([], { theme, scale })
    for (const background of ['#fff', '#161616']) {
      theme['c-content-background'] = background
      view.render()
      const button = view.button().props
      assert.equal(button.accessibilityRole, 'button')
      assert.equal(button.accessibilityLabel, 'list_locate_playing')
      assert.ok(button.style.width >= 44)
      assert.equal(button.style.width, button.style.height)
      assert.equal(button.style.borderRadius, button.style.width / 2)
      assert.equal(button.style.backgroundColor, background)
      assert.equal(button.children.props.color, theme['c-primary-font'])
      assert.equal(button.children.props.size, 20)
      assert.equal(button.children.props.name, 'music_time')
    }
  }
})

test('pause, resume, retry, remove and play actions still target the original download queue', async() => {
  const tasks = ['downloading', 'pending', 'paused', 'failed', 'completed'].map((status, index) => makeTask(`task-${index}`, String(5 - index), status))
  const view = await mountDownload(tasks)
  await view.initialize()
  view.sort('name')
  for (let index = 0; index < tasks.length; index++) {
    const row = view.row(index)
    const task = view.list().data[index]
    const actions = row.props.children[2].props.children.flat().filter(Boolean)
    const action = actions.find(element => element.props.accessibilityLabel != '下载更多操作')
    if (action) action.props.onPress()
    if (task.isComplate) row.props.children[1].props.onPress()
  }
  assert.ok(view.calls.some(call => call[0] == 'pauseDownload' && call[1] == 'task-0'))
  assert.ok(view.calls.some(call => call[0] == 'pauseDownload' && call[1] == 'task-1'))
  assert.ok(view.calls.some(call => call[0] == 'resumeDownload' && call[1] == 'task-2'))
  assert.ok(view.calls.some(call => call[0] == 'retryDownload' && call[1] == 'task-3'))
  assert.ok(view.calls.some(call => call[0] == 'play' && call[1] == 'download' && call[2] == 4))
  const row = view.row(0)
  const more = row.props.children[2].props.children.flat().filter(Boolean).at(-1)
  more.ref({ measure: onMeasure => onMeasure(0, 0, 40, 40, 0, 0) })
  more.props.onPress()
  view.elements().find(element => element.type == 'Menu' && element.props.activeId == null).props.onPress({ action: 'remove' })
  assert.ok(view.calls.some(call => call[0] == 'removeDownload' && call[1] == 'task-4'))
})
