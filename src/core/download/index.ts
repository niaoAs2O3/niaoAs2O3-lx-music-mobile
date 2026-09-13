import { getData, saveData } from '@/plugins/storage'
import { Platform } from 'react-native'
import { getMusicUrlInfo } from '@/core/music/online'
import { getPlayQuality } from '@/core/music/utils'
import { getListDetail } from '@/core/songlist'
import { downloadFile, existsFile, externalStorageDirectoryPath, mkdir, moveFile, privateStorageDirectoryPath, stat, stopDownload, unlink } from '@/utils/fs'
import { formatMusicName, requestStoragePermission, toast } from '@/utils/tools'
import settingState from '@/store/setting/state'
import { storageDataPrefix } from '@/config/constant'
import { startResumableDownload } from '@/utils/nativeModules/resumableDownload'
import { createDownloadTaskKey, DownloadScheduler, MAX_CONCURRENT_DOWNLOADS } from './scheduler'

const defaultDownloadDirectory = Platform.OS == 'android'
  ? `${externalStorageDirectoryPath}/Music/LX Music`
  : `${privateStorageDirectoryPath}/downloads`
const MAX_AUTO_RETRIES = 2

let list: LX.Download.ListItem[] = []
let initialized = false
let initPromise: Promise<LX.Download.ListItem[]> | null = null

interface ActiveDownload {
  token: number
  cancel: () => void
  dispose: () => void
}

interface EnqueueResult {
  added: number
  queued: number
  skipped: number
  tasks: LX.Download.ListItem[]
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
const emit = () => { global.app_event.downloadListUpdate() }

const getStoredTaskKey = (task: LX.Download.ListItem) => {
  return createDownloadTaskKey(task.metadata.musicInfo.source, task.metadata.musicInfo.id, task.metadata.requestedQuality ?? task.metadata.quality)
}

const getRequestedQuality = (): LX.Download.QualityPreference => {
  return settingState.setting['download.quality'] ?? settingState.setting['player.playQuality']
}

const getEffectiveQuality = (task: LX.Download.ListItem) => {
  const requestedQuality = task.metadata.requestedQuality ?? task.metadata.quality
  return getPlayQuality(requestedQuality, task.metadata.musicInfo)
}

const getDownloadDirectory = () => Platform.OS == 'android'
  ? settingState.setting['download.path'].trim() || defaultDownloadDirectory
  : defaultDownloadDirectory

const getParentDirectory = (filePath: string) => filePath.slice(0, filePath.lastIndexOf('/'))
const getTempFilePath = (task: LX.Download.ListItem) => task.metadata.tempFilePath ?? `${task.metadata.filePath}.part`

const getDownloadErrorText = (error: any) => {
  const message = String(error?.message ?? '')
  if (/timeout|timed out|SocketTimeout/i.test(message)) return '连接超时，请重试'
  if (/UnknownHost|Unable to resolve host|network is unreachable|Network is unreachable/i.test(message)) return '网络不可用，请检查连接'
  if (/HTTP 401|HTTP 403/i.test(message)) return '歌曲地址已失效，请重试'
  if (/HTTP 404/i.test(message)) return '未找到歌曲资源，请重试'
  return message || '下载失败，请重试'
}

const isRetryableDownloadError = (error: any) => {
  const message = `${error?.code ?? ''} ${error?.message ?? ''}`
  return /timeout|SocketTimeout|UnknownHost|Unable to resolve host|network|HTTP (401|403|404|408|429|5\d\d)|DOWNLOAD_FAILED|INCOMPLETE_RESPONSE/i.test(message)
}

const getFileSize = async(filePath: string) => {
  const info = await stat(filePath)
  return Number(info.size) || 0
}

const hasCompletedFile = async(filePath: string) => {
  if (!filePath || !await existsFile(filePath)) return false
  return getFileSize(filePath).then(size => size > 0).catch(() => false)
}

const migrateStatus = (status: string): LX.Download.DownloadTaskStatus => {
  switch (status) {
    case 'waiting': return 'pending'
    case 'run': return 'pending'
    case 'pause': return 'paused'
    case 'error': return 'failed'
    case 'completed': return 'completed'
    case 'paused': return 'paused'
    case 'downloading': return 'pending'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    default: return 'pending'
  }
}

const migrateTask = async(task: LX.Download.ListItem) => {
  task.status = migrateStatus(task.status)
  task.metadata.requestedQuality ??= task.metadata.quality
  task.retryCount ??= 0
  if (task.status == 'completed') {
    if (!await hasCompletedFile(task.metadata.filePath)) return false
    task.isComplate = true
    task.progress = 100
    task.statusText = '已完成'
    return true
  }

  task.isComplate = false
  if (task.metadata.filePath) {
    const hasTempFilePath = !!task.metadata.tempFilePath
    const tempFilePath = getTempFilePath(task)
    if (!hasTempFilePath && await existsFile(task.metadata.filePath) && !await existsFile(tempFilePath)) {
      await moveFile(task.metadata.filePath, tempFilePath).catch(() => {})
    }
    task.metadata.tempFilePath = tempFilePath
  }
  if (task.status == 'pending') task.statusText = '等待下载'
  if (task.status == 'paused') task.statusText = '已暂停，点击继续'
  if (task.status == 'failed' && !task.statusText) task.statusText = '下载失败，请重试'
  return true
}

const downloadScheduler = new DownloadScheduler(async id => {
  const task = list.find(item => item.id == id)
  if (!task || task.status != 'pending') return
  await runDownload(task)
})

export const initDownloadList = async() => {
  if (initialized) return list
  if (initPromise) return initPromise

  initPromise = (async() => {
    const savedList = await getData<LX.Download.ListItem[]>(storageDataPrefix.downloadList) ?? []
    const migrated: LX.Download.ListItem[] = []
    for (const task of savedList) {
      if (await migrateTask(task)) migrated.push(task)
    }
    list = migrated
    initialized = true
    await persist()
    for (const task of list) {
      if (task.status == 'pending') downloadScheduler.enqueue(task.id)
    }
    emit()
    return list
  })()

  return initPromise
}

export const getDownloadList = () => list
export const getActiveDownloadCount = () => downloadScheduler.activeCount

const createTask = (musicInfo: LX.Music.MusicInfoOnline, batch: boolean) => {
  const requestedQuality = getRequestedQuality()
  const taskKey = createDownloadTaskKey(musicInfo.source, musicInfo.id, requestedQuality)
  const old = list.find(item => getStoredTaskKey(item) == taskKey)
  if (old) return { task: old, isNew: false }

  const task: LX.Download.ListItem = {
    id: taskKey,
    isComplate: false,
    status: 'pending',
    statusText: '等待下载',
    downloaded: 0,
    total: 0,
    progress: 0,
    speed: '',
    retryCount: 0,
    metadata: {
      musicInfo,
      url: null,
      requestedQuality,
      quality: requestedQuality,
      ext: getExtension(requestedQuality),
      fileName: '',
      filePath: '',
      batch,
    },
  }
  list.unshift(task)
  return { task, isNew: true }
}

const setDownloadFile = async(task: LX.Download.ListItem, quality: LX.Quality) => {
  const ext = getExtension(quality)
  if (task.metadata.filePath && task.metadata.ext == ext) {
    task.metadata.quality = quality
    task.metadata.tempFilePath ||= `${task.metadata.filePath}.part`
    return
  }

  const baseName = sanitizeFileName(formatMusicName(settingState.setting['download.fileName'], task.metadata.musicInfo.name, task.metadata.musicInfo.singer))
  let suffix = 0
  while (true) {
    const fileName = `${baseName}${suffix ? ` (${suffix})` : ''}.${ext}`
    const filePath = `${getDownloadDirectory()}/${fileName}`
    const tempFilePath = `${filePath}.part`
    const usedByTask = list.some(item => item.id != task.id && (item.metadata.filePath == filePath || item.metadata.tempFilePath == tempFilePath))
    if (!usedByTask && !await existsFile(filePath) && !await existsFile(tempFilePath)) {
      task.metadata.quality = quality
      task.metadata.ext = ext
      task.metadata.fileName = fileName
      task.metadata.filePath = filePath
      task.metadata.tempFilePath = tempFilePath
      return
    }
    suffix++
  }
}

const verifyAndFinalizeDownload = async(task: LX.Download.ListItem, total: number) => {
  const tempFilePath = getTempFilePath(task)
  const tempSize = await getFileSize(tempFilePath)
  if (!tempSize || (total > 0 && tempSize < total)) throw new Error('INCOMPLETE_RESPONSE')
  await moveFile(tempFilePath, task.metadata.filePath)
  const finalSize = await getFileSize(task.metadata.filePath)
  if (!finalSize || (total > 0 && finalSize < total)) throw new Error('INCOMPLETE_RESPONSE')
  task.total = total || finalSize
  task.downloaded = finalSize
}

const runDownload = async(task: LX.Download.ListItem) => {
  if (task.status != 'pending') return
  const runToken = ++nextRunToken
  runTokens.set(task.id, runToken)
  const isCurrentRun = () => runTokens.get(task.id) == runToken

  task.status = 'downloading'
  task.statusText = '获取歌曲地址'
  task.retryCount = 0
  emit()
  await persist()

  try {
    if (Platform.OS == 'android') {
      const permission = await requestStoragePermission()
      if (!permission) throw new Error('存储权限被拒绝')
    }

    let retryCount = 0
    while (true) {
      try {
        const musicUrl = await getMusicUrlInfo({
          musicInfo: task.metadata.musicInfo,
          quality: getEffectiveQuality(task),
          isRefresh: retryCount > 0,
        })
        if (!isCurrentRun() || task.status != 'downloading' || interrupted.has(task.id)) return
        if (!musicUrl.url) throw new Error('未获取到歌曲地址')

        task.metadata.url = musicUrl.url
        await setDownloadFile(task, musicUrl.quality)
        const tempFilePath = getTempFilePath(task)
        await mkdir(getParentDirectory(tempFilePath)).catch(() => {})

        const handleProgress = (downloaded: number, total: number) => {
          if (!isCurrentRun()) return
          task.downloaded = downloaded
          task.total = total || task.total
          task.progress = task.total ? Math.min(99, Math.round(downloaded * 100 / task.total)) : 0
          task.statusText = '下载中'
          emit()
        }
        const result = Platform.OS == 'android'
          ? startResumableDownload(task.id, musicUrl.url, tempFilePath, ({ downloaded, total }) => { handleProgress(downloaded, total) })
          : (() => {
              const download = downloadFile(musicUrl.url, tempFilePath, {
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

        let response: Awaited<typeof result.promise>
        try {
          response = await result.promise
        } finally {
          const job = jobs.get(task.id)
          if (job?.token == runToken) {
            jobs.delete(task.id)
            job.dispose()
          }
        }
        if (!isCurrentRun()) return
        if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`)
        await verifyAndFinalizeDownload(task, response.total || task.total)

        task.status = 'completed'
        task.statusText = '已完成'
        task.isComplate = true
        task.progress = 100
        task.retryCount = retryCount
        await persist()
        emit()
        if (!task.metadata.batch) toast(`已下载：${task.metadata.musicInfo.name}`)
        return
      } catch (error: any) {
        if (!isCurrentRun() || interrupted.has(task.id)) return
        if (retryCount < MAX_AUTO_RETRIES && isRetryableDownloadError(error)) {
          retryCount++
          task.retryCount = retryCount
          task.statusText = `下载失败，正在重试 (${retryCount}/${MAX_AUTO_RETRIES})`
          await persist()
          emit()
          continue
        }
        throw error
      }
    }
  } catch (error: any) {
    const job = jobs.get(task.id)
    if (job?.token == runToken) {
      jobs.delete(task.id)
      job.dispose()
    }
    if (!isCurrentRun() || interrupted.delete(task.id)) return
    task.status = 'failed'
    task.statusText = getDownloadErrorText(error)
    task.isComplate = false
    await persist()
    emit()
    if (!task.metadata.batch) toast(`下载失败：${task.metadata.musicInfo.name}`, 'long')
  } finally {
    if (!list.includes(task)) interrupted.delete(task.id)
    if (runTokens.get(task.id) == runToken) runTokens.delete(task.id)
  }
}

const enqueueMusicInfos = async(musicInfos: LX.Music.MusicInfoOnline[], batch: boolean): Promise<EnqueueResult> => {
  await initDownloadList()
  const tasks: LX.Download.ListItem[] = []
  let added = 0
  let skipped = 0

  for (const musicInfo of musicInfos) {
    const { task, isNew } = createTask(musicInfo, batch)
    if (isNew) {
      added++
      tasks.push(task)
      continue
    }
    if (task.status == 'failed' || task.status == 'cancelled') {
      task.status = 'pending'
      task.statusText = '等待下载'
      task.retryCount = 0
      tasks.push(task)
      continue
    }
    if (task.status == 'pending' && !downloadScheduler.isPending(task.id) && !downloadScheduler.isActive(task.id)) tasks.push(task)
    else skipped++
  }

  if (tasks.length) {
    await persist()
    emit()
    for (const task of tasks) downloadScheduler.enqueue(task.id)
  }
  return { added, queued: tasks.length, skipped, tasks }
}

export const downloadMusic = async(musicInfo: LX.Music.MusicInfoOnline) => {
  const result = await enqueueMusicInfos([musicInfo], false)
  return result.tasks[0] ?? list.find(item => getStoredTaskKey(item) == createDownloadTaskKey(musicInfo.source, musicInfo.id, getRequestedQuality()))
}

export const downloadMusicList = async(musicInfos: LX.Music.MusicInfoOnline[]) => enqueueMusicInfos(musicInfos, true)

export const downloadSonglist = async(source: LX.OnlineSource, id: string) => {
  let page = 1
  let totalPages = 1
  let added = 0
  let queued = 0
  let skipped = 0

  do {
    const detail = await getListDetail(id, source, page)
    const result = await enqueueMusicInfos(detail.list, true)
    added += result.added
    queued += result.queued
    skipped += result.skipped
    totalPages = Math.max(1, Math.ceil(detail.total / detail.limit))
    page++
  } while (page <= totalPages)

  toast(added ? `已加入下载队列：${added} 首` : skipped ? '歌曲已在下载列表中' : '歌单没有可下载歌曲')
  return { added, queued, skipped }
}

export const retryDownload = async(id: string) => {
  await initDownloadList()
  const task = list.find(item => item.id == id)
  if (!task || task.status != 'failed') return
  task.status = 'pending'
  task.statusText = '等待下载'
  task.progress = 0
  task.downloaded = 0
  task.total = 0
  task.retryCount = 0
  await persist()
  emit()
  downloadScheduler.enqueue(task.id)
}

export const pauseDownload = async(id: string) => {
  await initDownloadList()
  const task = list.find(item => item.id == id)
  if (!task || !['pending', 'downloading'].includes(task.status)) return
  if (task.status == 'pending') downloadScheduler.removePending(id)
  const job = jobs.get(id)
  interrupted.add(id)
  runTokens.delete(id)
  job?.cancel()
  task.status = 'paused'
  task.statusText = '已暂停，点击继续'
  await persist()
  emit()
}

export const resumeDownload = async(id: string) => {
  await initDownloadList()
  const task = list.find(item => item.id == id)
  if (!task || task.status != 'paused') return
  interrupted.delete(id)
  task.status = 'pending'
  task.statusText = '等待下载'
  await persist()
  emit()
  downloadScheduler.enqueue(task.id)
}

export const removeDownload = async(id: string) => {
  await initDownloadList()
  const index = list.findIndex(item => item.id == id)
  if (index < 0) return
  const task = list[index]
  downloadScheduler.removePending(id)
  const job = jobs.get(id)
  if (job) {
    interrupted.add(id)
    runTokens.delete(id)
    job.cancel()
  }
  const paths = [task.metadata.filePath, task.metadata.tempFilePath].filter((path): path is string => !!path)
  await Promise.all(paths.map(async path => {
    try {
      if (await existsFile(path)) await unlink(path)
    } catch {}
  }))
  list.splice(index, 1)
  await persist()
  emit()
}

export { MAX_CONCURRENT_DOWNLOADS }
