import { getData, saveData } from '@/plugins/storage'
import { Platform } from 'react-native'
import { getMusicUrlInfo } from '@/core/music/online'
import { getPlayQuality } from '@/core/music/utils'
import { downloadFile, existsFile, externalStorageDirectoryPath, mkdir, privateStorageDirectoryPath, stopDownload, unlink } from '@/utils/fs'
import { formatMusicName, requestStoragePermission, toast } from '@/utils/tools'
import settingState from '@/store/setting/state'
import { storageDataPrefix } from '@/config/constant'
import { startResumableDownload } from '@/utils/nativeModules/resumableDownload'

const defaultDownloadDirectory = Platform.OS == 'android'
  ? `${externalStorageDirectoryPath}/Music/LX Music`
  : `${privateStorageDirectoryPath}/downloads`
let list: LX.Download.ListItem[] = []
let initialized = false
interface ActiveDownload {
  token: number
  cancel: () => void
  dispose: () => void
}
const jobs = new Map<string, ActiveDownload>()
const interrupted = new Set<string>()
const runTokens = new Map<string, number>()
let nextRunToken = 0

const sanitizeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名歌曲'
const getExtension = (quality: LX.Quality): LX.Download.FileExt => {
  if (quality == 'flac' || quality == 'flac24bit') return 'flac'
  if (quality == 'ape') return 'ape'
  if (quality == 'wav') return 'wav'
  return 'mp3'
}

const persist = async() => saveData(storageDataPrefix.downloadList, list)

const getRequestedQuality = (musicInfo: LX.Music.MusicInfoOnline) => {
  return getPlayQuality(settingState.setting['download.quality'] ?? settingState.setting['player.playQuality'], musicInfo)
}

const getDownloadDirectory = () => Platform.OS == 'android'
  ? settingState.setting['download.path'].trim() || defaultDownloadDirectory
  : defaultDownloadDirectory

const getParentDirectory = (filePath: string) => filePath.slice(0, filePath.lastIndexOf('/'))

const getDownloadErrorText = (error: any) => {
  const message = String(error?.message ?? '')
  if (/timeout|timed out|SocketTimeout/i.test(message)) return '连接超时，请重试'
  if (/UnknownHost|Unable to resolve host|network is unreachable|Network is unreachable/i.test(message)) return '网络不可用，请检查连接'
  if (/HTTP 401|HTTP 403/i.test(message)) return '歌曲地址已失效，请重试'
  if (/HTTP 404/i.test(message)) return '未找到歌曲资源，请重试'
  return message || '下载失败，请重试'
}

export const initDownloadList = async() => {
  if (initialized) return list
  initialized = true
  list = await getData<LX.Download.ListItem[]>(storageDataPrefix.downloadList) ?? []
  const existing: LX.Download.ListItem[] = []
  for (const item of list) {
    const fileExists = item.metadata?.filePath ? await existsFile(item.metadata.filePath) : false
    if (item.status == 'completed' && fileExists) {
      item.status = 'completed'
      item.isComplate = true
      existing.push(item)
    } else if (item.status != 'completed') {
      if (item.status == 'run') {
        item.status = 'waiting'
        item.statusText = '等待下载'
      }
      item.isComplate = false
      existing.push(item)
    }
  }
  list = existing
  await persist()
  return list
}

export const getDownloadList = () => list

const emit = () => { global.app_event.downloadListUpdate() }

const createTask = async(musicInfo: LX.Music.MusicInfoOnline): Promise<LX.Download.ListItem> => {
  await initDownloadList()
  const requestedQuality = getRequestedQuality(musicInfo)
  const old = list.find(item => item.metadata.musicInfo.id == musicInfo.id && (item.metadata.requestedQuality ?? item.metadata.quality) == requestedQuality)
  if (old) return old
  const baseId = `${musicInfo.source}_${musicInfo.id}_${requestedQuality}`
  return {
    id: baseId,
    isComplate: false,
    status: 'waiting',
    statusText: '等待下载',
    downloaded: 0,
    total: 0,
    progress: 0,
    speed: '',
    metadata: {
      musicInfo,
      url: null,
      requestedQuality,
      quality: requestedQuality,
      ext: getExtension(requestedQuality),
      fileName: '',
      filePath: '',
    },
  }
}

const setDownloadFile = async(task: LX.Download.ListItem, quality: LX.Quality) => {
  const ext = getExtension(quality)
  if (task.metadata.filePath && task.metadata.ext == ext) {
    task.metadata.quality = quality
    return
  }

  const baseName = sanitizeFileName(formatMusicName(settingState.setting['download.fileName'], task.metadata.musicInfo.name, task.metadata.musicInfo.singer))
  let suffix = 0
  while (true) {
    const fileName = `${baseName}${suffix ? ` (${suffix})` : ''}.${ext}`
    const filePath = `${getDownloadDirectory()}/${fileName}`
    const usedByTask = list.some(item => item.id != task.id && item.metadata.filePath == filePath)
    if (!usedByTask && !await existsFile(filePath)) {
      task.metadata.quality = quality
      task.metadata.ext = ext
      task.metadata.fileName = fileName
      task.metadata.filePath = filePath
      return
    }
    suffix++
  }
}

const runDownload = async(task: LX.Download.ListItem) => {
  if (task.status == 'run' || task.status == 'completed') {
    toast(task.status == 'completed' ? '歌曲已下载' : '歌曲正在下载')
    return task
  }
  if (!list.includes(task)) list.unshift(task)
  const runToken = ++nextRunToken
  runTokens.set(task.id, runToken)
  const isCurrentRun = () => runTokens.get(task.id) == runToken
  task.status = 'run'
  task.statusText = '获取歌曲地址'
  emit()
  await persist()

  try {
    if (Platform.OS == 'android') {
      const permission = await requestStoragePermission()
      if (!permission) throw new Error('存储权限被拒绝')
    }
    const musicUrl = await getMusicUrlInfo({ musicInfo: task.metadata.musicInfo, quality: task.metadata.requestedQuality ?? task.metadata.quality, isRefresh: false })
    if (!isCurrentRun() || task.status != 'run' || interrupted.has(task.id)) return task
    task.metadata.url = musicUrl.url
    await setDownloadFile(task, musicUrl.quality)
    await mkdir(getParentDirectory(task.metadata.filePath)).catch(() => {})
    const handleProgress = (downloaded: number, total: number) => {
      if (!isCurrentRun()) return
      task.downloaded = downloaded
      task.total = total || task.total
      task.progress = task.total ? Math.round(downloaded * 100 / task.total) : 0
      task.statusText = '下载中'
      emit()
    }
    const result = Platform.OS == 'android'
      ? startResumableDownload(task.id, musicUrl.url, task.metadata.filePath, ({ downloaded, total }) => { handleProgress(downloaded, total) })
      : (() => {
          const download = downloadFile(musicUrl.url, task.metadata.filePath, {
            progressInterval: 500,
            begin: ({ contentLength }) => { handleProgress(0, contentLength) },
            progress: ({ bytesWritten, contentLength }) => { handleProgress(bytesWritten, contentLength) },
          })
          return {
            promise: download.promise.then(response => ({ statusCode: response.statusCode, downloaded: task.downloaded, total: task.total, resumed: false })),
            cancel: () => { stopDownload(download.jobId) },
            dispose: () => {},
          }
        })()
    jobs.set(task.id, { token: runToken, cancel: result.cancel, dispose: result.dispose })
    const response = await result.promise
    if (!isCurrentRun()) return task
    jobs.delete(task.id)
    result.dispose()
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`)
    task.status = 'completed'
    task.statusText = '已完成'
    task.isComplate = true
    task.progress = 100
    task.downloaded = task.total || task.downloaded
    await persist()
    emit()
    toast(`已下载：${task.metadata.musicInfo.name}`)
  } catch (error: any) {
    const job = jobs.get(task.id)
    if (job?.token == runToken) {
      jobs.delete(task.id)
      job.dispose()
    }
    if (!isCurrentRun()) return task
    if (interrupted.delete(task.id)) {
      await persist()
      emit()
      return task
    }
    task.status = 'error'
    task.statusText = getDownloadErrorText(error)
    task.isComplate = false
    await persist()
    emit()
    toast(`下载失败：${task.metadata.musicInfo.name}`, 'long')
  }
  return task
}

export const downloadMusic = async(musicInfo: LX.Music.MusicInfoOnline) => {
  const task = await createTask(musicInfo)
  return runDownload(task)
}

export const downloadMusicList = async(musicInfos: LX.Music.MusicInfoOnline[]) => {
  for (const musicInfo of musicInfos) await downloadMusic(musicInfo)
}

export const retryDownload = async(id: string) => {
  const task = list.find(item => item.id == id)
  if (!task) return
  task.status = 'waiting'
  task.statusText = '等待下载'
  task.progress = 0
  task.downloaded = 0
  task.total = 0
  if (task.metadata.filePath && await existsFile(task.metadata.filePath)) await unlink(task.metadata.filePath).catch(() => {})
  await persist()
  emit()
  return runDownload(task)
}

export const pauseDownload = async(id: string) => {
  const task = list.find(item => item.id == id)
  if (!task || task.status != 'run') return
  const job = jobs.get(id)
  interrupted.add(id)
  runTokens.delete(id)
  job?.cancel()
  task.status = 'pause'
  task.statusText = '已暂停，点击继续'
  await persist()
  emit()
}

export const resumeDownload = async(id: string) => {
  const task = list.find(item => item.id == id)
  if (!task || task.status != 'pause') return
  interrupted.delete(id)
  return runDownload(task)
}

export const removeDownload = async(id: string) => {
  const index = list.findIndex(item => item.id == id)
  if (index < 0) return
  const task = list[index]
  const job = jobs.get(id)
  if (job) {
    interrupted.add(id)
    runTokens.delete(id)
    job.cancel()
  }
  if (task.metadata.filePath && await existsFile(task.metadata.filePath)) await unlink(task.metadata.filePath).catch(() => {})
  list.splice(index, 1)
  await persist()
  emit()
}
