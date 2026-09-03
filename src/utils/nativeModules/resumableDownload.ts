import { NativeEventEmitter, NativeModules } from 'react-native'

interface NativeDownloadResult {
  statusCode: number
  downloaded: number
  total: number
  resumed: boolean
}

interface NativeDownloadProgress {
  id: string
  downloaded: number
  total: number
}

const nativeModule = NativeModules.ResumableDownloadModule as {
  download: (id: string, url: string, filePath: string) => Promise<NativeDownloadResult>
  cancel: (id: string) => void
}

export const startResumableDownload = (id: string, url: string, filePath: string, onProgress: (progress: NativeDownloadProgress) => void) => {
  const eventEmitter = new NativeEventEmitter(nativeModule)
  const subscription = eventEmitter.addListener('resumable-download-progress', (progress: NativeDownloadProgress) => {
    if (progress.id == id) onProgress(progress)
  })

  return {
    promise: nativeModule.download(id, url, filePath),
    cancel: () => { nativeModule.cancel(id) },
    dispose: () => { subscription.remove() },
  }
}
