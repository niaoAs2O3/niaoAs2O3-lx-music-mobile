const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const filename = path.resolve(__dirname, '../src/screens/Home/Views/Mylist/MusicList/List.tsx')
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

// Exercise the actual list component and its event handlers without an Android
// runtime. Keep hook state across renders; native scrolling is the test boundary.
async function mountList({ columns = 1, theme = {}, songs = [] } = {}) {
  const cells = []
  const effects = []
  const cleanups = []
  const scrolls = []
  const toasts = []
  let cursor = 0
  let tree
  const listState = { activeListId: 'library' }
  const playerState = { playMusicInfo: { musicInfo: null }, playInfo: { playIndex: -1 } }
  const lists = new Map([['library', songs]])
  const events = { state_event: new EventEmitter(), app_event: new EventEmitter(), lx: {} }
  const cell = make => {
    const index = cursor++
    if (!(index in cells)) cells[index] = make()
    return index
  }
  const react = {
    useState: value => {
      const index = cell(() => value)
      return [cells[index], next => { cells[index] = next }]
    },
    useRef: value => cells[cell(() => ({ current: value }))],
    useMemo: compute => compute(),
    useEffect: callback => { cell(() => { effects.push(callback) }) },
    useImperativeHandle: (ref, create) => { ref.current = create() },
    forwardRef: component => component,
  }
  const modules = {
    react,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { FlatList: 'FlatList', View: 'View', StyleSheet: { create: styles => styles } },
    '@/components/common/Button': { default: 'Button' },
    '@/components/common/Icon': { Icon: 'Icon' },
    '@/lang': { useI18n: () => key => key },
    '@/store/theme/hook': { useTheme: () => theme },
    '@/store/list/state': { default: listState },
    '@/store/player/state': { default: playerState },
    '@/store/list/hook': { useActiveListId: () => listState.activeListId },
    '@/store/player/hook': { usePlayMusicInfo: () => playerState.playMusicInfo },
    '@/store/setting/hook': { useSettingValue: () => true },
    '@/utils/pixelRatio': { scaleSizeW: size => size },
    '@/core/player/player': { playList: () => {} },
    '@/core/list': {
      getListMusics: async id => lists.get(id) ?? [],
      setActiveList: id => { listState.activeListId = id },
    },
    '@/utils/data': {
      getListPrevSelectId: async() => 'library',
      getListPosition: async() => 0,
      saveListPosition: async() => {},
    },
    '@/utils/tools': {
      createStyle: styles => styles,
      getRowInfo: () => ({ rowNum: columns == 1 ? undefined : columns, rowWidth: '100%' }),
      toast: text => toasts.push(text),
    },
    './ListItem': { default: 'ListItem', ITEM_HEIGHT: 54 },
  }
  for (const [name, file] of [
    ['@/utils/playingList', '../src/utils/playingList.ts'],
    ['@/components/LocatePlayingButton', '../src/components/LocatePlayingButton.tsx'],
  ]) {
    const sourcePath = path.resolve(__dirname, file)
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    const exports = {}
    vm.runInNewContext(compiled, { exports, require: name => modules[name] }, { filename: sourcePath })
    modules[name] = exports
  }
  const module = { exports: {} }
  vm.runInNewContext(code, {
    exports: module.exports,
    require: name => {
      assert.ok(name in modules, `Unexpected import: ${name}`)
      return modules[name]
    },
    global: events,
    requestAnimationFrame: callback => callback(),
  }, { filename })
  const ref = {}
  const render = () => {
    cursor = 0
    tree = module.exports.default({ onShowMenu() {}, onMuiltSelectMode() {}, onSelectAll() {} }, ref)
    tree.props.children[0].ref.current = {
      scrollToIndex: info => scrolls.push(info),
      scrollToOffset() {},
    }
    while (effects.length) cleanups.push(effects.shift()())
  }
  const flush = async() => {
    await new Promise(resolve => setImmediate(resolve))
    render()
  }
  render()
  await flush()
  return {
    listState,
    playerState,
    lists,
    events,
    scrolls,
    toasts,
    render,
    flush,
    list: () => tree.props.children[0].props,
    button: () => tree.props.children[1].type(tree.props.children[1].props).props,
    press: () => tree.props.children[1].props.onPress(),
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
  }
}

const songs = Array.from({ length: 2000 }, (_, index) => ({ id: `song-${index}` }))

test('empty list and no playing song give feedback without scrolling', async() => {
  const view = await mountList()
  view.press()
  assert.deepEqual(view.toasts, ['list_locate_playing_empty'])
  view.playerState.playMusicInfo = { musicInfo: songs[0] }
  view.press()
  assert.equal(view.toasts.at(-1), 'list_locate_playing_missing')
  assert.equal(view.scrolls.length, 0)
})

for (const columns of [1, 2]) {
  test(`locates first, middle and last songs in a long ${columns}-column list`, async() => {
    const view = await mountList({ columns, songs })
    for (const index of [0, 1, 1001, 1999]) {
      view.playerState.playMusicInfo = { musicInfo: songs[index], listId: 'another-list' }
      view.render()
      view.press()
      assert.equal(view.scrolls.at(-1).index, Math.floor(index / columns))
      assert.equal(view.scrolls.at(-1).viewPosition, 0.3)
      assert.equal(view.scrolls.at(-1).animated, true)
      assert.equal(view.list().extraData, index)
      assert.equal(view.list().getItemLayout(null, Math.floor(index / columns)).offset, 54 * Math.floor(index / columns))
    }
    assert.equal(view.toasts.length, 0)
    assert.ok(view.list().contentContainerStyle.paddingBottom > view.button().style.bottom + view.button().style.height)
  })
}

test('reads the latest playing song on press, including a downloaded track', async() => {
  const view = await mountList({ songs })
  view.playerState.playMusicInfo = { musicInfo: songs[3] }
  view.render()
  view.playerState.playMusicInfo = { musicInfo: songs[7] }
  view.press()
  assert.equal(view.scrolls.at(-1).index, 7)
  view.playerState.playMusicInfo = { musicInfo: { id: 'download-task-id', progress: 1, metadata: { musicInfo: songs[12] } } }
  view.render()
  view.press()
  assert.equal(view.scrolls.at(-1).index, 12)
  assert.equal(view.list().extraData, 12)
})

test('missing song stays in the displayed list and shows feedback', async() => {
  const view = await mountList({ songs })
  view.playerState.playMusicInfo = { musicInfo: { id: 'missing' }, listId: 'other' }
  view.render()
  view.press()
  assert.equal(view.listState.activeListId, 'library')
  assert.equal(view.list().extraData, -1)
  assert.deepEqual(view.toasts, ['list_locate_playing_missing'])
  assert.equal(view.scrolls.length, 0)
})

test('reordering and removing the current song update both target and highlight', async() => {
  const view = await mountList({ songs: songs.slice(0, 5) })
  view.playerState.playMusicInfo = { musicInfo: songs[3] }
  view.lists.set('library', [songs[3], songs[0]])
  view.events.app_event.emit('myListMusicUpdate', ['library'])
  await view.flush()
  view.press()
  assert.equal(view.scrolls.at(-1).index, 0)
  assert.equal(view.list().extraData, 0)
  view.lists.set('library', [songs[0]])
  view.events.app_event.emit('myListMusicUpdate', ['library'])
  await view.flush()
  view.press()
  assert.equal(view.list().extraData, -1)
  assert.equal(view.scrolls.length, 1)
  assert.equal(view.toasts.at(-1), 'list_locate_playing_missing')
})

test('does not scroll stale data while switching lists; cleans up listeners', async() => {
  const view = await mountList({ songs })
  view.playerState.playMusicInfo = { musicInfo: songs[1] }
  view.listState.activeListId = 'new'
  view.press()
  assert.equal(view.scrolls.length, 0)
  view.lists.set('new', [songs[1]])
  view.events.state_event.emit('mylistToggled', 'new')
  await view.flush()
  view.press()
  assert.equal(view.scrolls.at(-1).index, 0)
  view.unmount()
  assert.equal(view.events.state_event.listenerCount('mylistToggled'), 0)
  assert.equal(view.events.app_event.listenerCount('myListMusicUpdate'), 0)
  assert.equal(view.events.app_event.listenerCount('jumpListPosition'), 0)
})

test('button follows theme changes and uses an existing icon and translated accessible label', async() => {
  const theme = { 'c-content-background': '#161616', 'c-primary-font': '#ffb800', 'c-primary-light-200-alpha-700': '#555' }
  const view = await mountList({ theme })
  assert.equal(view.button().accessibilityRole, 'button')
  assert.equal(view.button().accessibilityLabel, 'list_locate_playing')
  assert.equal(view.button().style.width, 44)
  assert.equal(view.button().style.height, 44)
  assert.equal(view.button().children.props.size, 20)
  assert.equal(view.button().style.backgroundColor, theme['c-content-background'])
  assert.equal(view.button().children.props.color, theme['c-primary-font'])
  const icons = require('../src/resources/fonts/selection.json').icons
  assert.ok(icons.some(icon => icon.properties.name == view.button().children.props.name))
  theme['c-content-background'] = '#fff'
  theme['c-primary-font'] = '#26845b'
  view.render()
  assert.equal(view.button().style.backgroundColor, '#fff')
  assert.equal(view.button().children.props.color, '#26845b')
  for (const locale of ['zh-cn', 'zh-tw', 'en-us']) {
    const messages = require(`../src/lang/${locale}.json`)
    for (const key of ['list_locate_playing', 'list_locate_playing_empty', 'list_locate_playing_missing']) assert.ok(messages[key])
  }
})
