export const MAX_CONCURRENT_DOWNLOADS = 2

export const createDownloadTaskKey = (source: string, songId: string, requestedQuality: string) => {
  return `${source}:${songId}:${requestedQuality}`
}

type DownloadRunner = (id: string) => Promise<void>

export class DownloadScheduler {
  private readonly pending: string[] = []
  private readonly pendingIds = new Set<string>()
  private readonly activeIds = new Set<string>()

  constructor(private readonly run: DownloadRunner) {}

  get activeCount() {
    return this.activeIds.size
  }

  get pendingCount() {
    return this.pending.length
  }

  isActive(id: string) {
    return this.activeIds.has(id)
  }

  isPending(id: string) {
    return this.pendingIds.has(id)
  }

  enqueue(id: string) {
    if (this.isActive(id) || this.isPending(id)) return false
    this.pending.push(id)
    this.pendingIds.add(id)
    this.pump()
    return true
  }

  removePending(id: string) {
    if (!this.pendingIds.delete(id)) return false
    const index = this.pending.indexOf(id)
    if (index >= 0) this.pending.splice(index, 1)
    return true
  }

  pump() {
    while (this.activeCount < MAX_CONCURRENT_DOWNLOADS && this.pending.length) {
      const id = this.pending.shift()!
      this.pendingIds.delete(id)
      this.activeIds.add(id)
      void Promise.resolve()
        .then(async() => this.run(id))
        .catch(() => {})
        .finally(() => {
          this.activeIds.delete(id)
          this.pump()
        })
    }
  }
}
