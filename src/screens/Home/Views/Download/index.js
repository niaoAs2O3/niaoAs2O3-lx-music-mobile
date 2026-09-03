import { useEffect, useRef, useState } from 'react'
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
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  info: { flex: 1, minWidth: 0 },
  title: { fontSize: 16 },
  status: { marginTop: 4 },
  actions: { flexDirection: 'row', alignItems: 'center', marginLeft: 12 },
  action: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
})

const getQualityLabel = (item) => {
  if (item.metadata.quality == 'flac24bit') return 'FLAC 24-bit'
  if (item.metadata.ext == 'flac') return 'FLAC'
  return item.metadata.ext?.toUpperCase() ?? item.metadata.quality
}

export default () => {
  const [items, setItems] = useState([])
  const theme = useTheme()
  const menuRef = useRef(null)
  const selectedItemRef = useRef(null)
  const moreButtonRefs = useRef({})
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
  return <>
    <FlatList
      data={items}
      keyExtractor={item => item.id}
      ListEmptyComponent={<Text style={{ padding: 24, textAlign: 'center' }}>暂无下载歌曲</Text>}
      renderItem={({ item, index }) => <View style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }}>
        <TouchableOpacity style={styles.info} disabled={!item.isComplate} onPress={() => { playList(LIST_IDS.DOWNLOAD, index) }}>
          <Text style={styles.title} numberOfLines={1}>{item.metadata.musicInfo.name} - {item.metadata.musicInfo.singer}</Text>
          <Text style={styles.status} color={item.status == 'error' ? theme['c-primary-font'] : theme['c-font-label']} numberOfLines={1}>{item.statusText}{item.total ? ` ${item.progress}%` : ''} · {getQualityLabel(item)}</Text>
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
  </>
}
