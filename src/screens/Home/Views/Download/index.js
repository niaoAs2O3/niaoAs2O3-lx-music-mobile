import { useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, TouchableOpacity, View } from 'react-native'
import { getDownloadList, initDownloadList, pauseDownload, removeDownload, resumeDownload, retryDownload } from '@/core/download'
import { playList } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import Menu from '@/components/common/Menu'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'

const styles = createStyle({
  toolbar: { height: 40, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  sortButton: { height: 40, flexDirection: 'row', alignItems: 'center' },
  sortLabel: { marginLeft: 5, marginRight: 3 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1 },
  sn: { width: 38, textAlign: 'center', paddingHorizontal: 3 },
  info: { flex: 1, minWidth: 0 },
  status: { marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', marginLeft: 12 },
  action: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
})

const sortMenus = [
  { action: 'default', label: '默认排序' },
  { action: 'name', label: '按歌曲名' },
  { action: 'singer', label: '按歌手名' },
  { action: 'status', label: '按下载状态' },
]

const getSortedItems = (items, sort) => {
  if (sort == 'default') return items
  const statusOrder = { run: 0, waiting: 1, pause: 2, error: 3, completed: 4 }
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    if (sort == 'status') return (statusOrder[a.item.status] ?? 99) - (statusOrder[b.item.status] ?? 99) || a.index - b.index
    const aValue = sort == 'name' ? a.item.metadata.musicInfo.name : a.item.metadata.musicInfo.singer
    const bValue = sort == 'name' ? b.item.metadata.musicInfo.name : b.item.metadata.musicInfo.singer
    return String(aValue ?? '').localeCompare(String(bValue ?? ''), 'zh-CN') || a.index - b.index
  }).map(({ item }) => item)
}

const getQualityLabel = (item) => {
  if (item.metadata.quality == 'flac24bit') return 'FLAC 24-bit'
  if (item.metadata.ext == 'flac') return 'FLAC'
  return item.metadata.ext?.toUpperCase() ?? item.metadata.quality
}

export default () => {
  const [items, setItems] = useState([])
  const [sort, setSort] = useState('default')
  const theme = useTheme()
  const menuRef = useRef(null)
  const sortMenuRef = useRef(null)
  const selectedItemRef = useRef(null)
  const moreButtonRefs = useRef({})
  const sortButtonRef = useRef(null)
  const sortedItems = useMemo(() => getSortedItems(items, sort), [items, sort])
  useEffect(() => {
    const refresh = () => setItems([...getDownloadList()])
    initDownloadList().then(refresh)
    global.app_event.on('downloadListUpdate', refresh)
    return () => global.app_event.off('downloadListUpdate', refresh)
  }, [])
  const showMenu = (item) => {
    moreButtonRefs.current[item.id]?.measure((fx, fy, width, height, px, py) => {
      selectedItemRef.current = item
      menuRef.current?.show({ x: Math.ceil(px), y: Math.ceil(py), w: Math.ceil(width), h: Math.ceil(height) })
    })
  }
  const showSortMenu = () => {
    sortButtonRef.current?.measure((fx, fy, width, height, px, py) => {
      sortMenuRef.current?.show({ x: Math.ceil(px), y: Math.ceil(py), w: Math.ceil(width), h: Math.ceil(height) })
    })
  }
  return <>
    <FlatList
      data={sortedItems}
      keyExtractor={item => item.id}
      ListHeaderComponent={<View style={styles.toolbar}>
        <TouchableOpacity ref={sortButtonRef} style={styles.sortButton} accessibilityLabel="下载排序" onPress={showSortMenu}>
          <Icon name="menu" color={theme['c-primary-font']} size={14} />
          <Text style={styles.sortLabel} size={13} color={theme['c-primary-font']}>排序</Text>
          <Icon name="chevron-right" color={theme['c-primary-font']} size={10} />
        </TouchableOpacity>
      </View>}
      ListEmptyComponent={<Text style={{ padding: 24, textAlign: 'center' }}>暂无下载歌曲</Text>}
      renderItem={({ item, index }) => <View style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }}>
        <Text style={styles.sn} size={13} color={theme['c-300']}>{index + 1}</Text>
        <TouchableOpacity style={styles.info} disabled={!item.isComplate} onPress={() => { playList(LIST_IDS.DOWNLOAD, getDownloadList().indexOf(item)) }}>
          <Text size={15} numberOfLines={1}>{item.metadata.musicInfo.name} - {item.metadata.musicInfo.singer}</Text>
          <Text style={styles.status} size={11} color={item.status == 'error' ? theme['c-primary-font'] : theme['c-font-label']} numberOfLines={1}>{item.statusText}{item.total ? ` ${item.progress}%` : ''} · {getQualityLabel(item)}</Text>
        </TouchableOpacity>
        <View style={styles.actions}>
          {item.status == 'run' && <TouchableOpacity style={styles.action} accessibilityLabel="暂停下载" onPress={() => { pauseDownload(item.id) }}>
            <Icon name="pause" color={theme['c-primary-font']} size={18} />
          </TouchableOpacity>}
          {item.status == 'pause' && <TouchableOpacity style={styles.action} accessibilityLabel="继续下载" onPress={() => { resumeDownload(item.id) }}>
            <Icon name="play" color={theme['c-primary-font']} size={18} />
          </TouchableOpacity>}
          {item.status == 'error' && <TouchableOpacity style={styles.action} accessibilityLabel="重试下载" onPress={() => { retryDownload(item.id) }}>
            <Icon name="available_updates" color={theme['c-primary-font']} size={18} />
          </TouchableOpacity>}
          <TouchableOpacity ref={ref => { moreButtonRefs.current[item.id] = ref }} style={styles.action} accessibilityLabel="下载更多操作" onPress={() => { showMenu(item) }}>
            <Icon name="dots-vertical" color={theme['c-font-label']} size={18} />
          </TouchableOpacity>
        </View>
      </View>}
    />
    <Menu ref={menuRef} menus={[{ action: 'remove', label: '删除' }]} onPress={({ action }) => {
      if (action == 'remove' && selectedItemRef.current) removeDownload(selectedItemRef.current.id)
    }} />
    <Menu ref={sortMenuRef} menus={sortMenus} activeId={sort} onPress={({ action }) => { setSort(action) }} />
  </>
}
