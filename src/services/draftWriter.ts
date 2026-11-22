export class DraftWriter<T> {
  private pending: T | undefined
  private revision = 0
  private savedRevision = 0
  private running: Promise<void> | null = null

  private readonly write: (value: T) => Promise<void>

  constructor(write: (value: T) => Promise<void>) { this.write = write }

  get dirty(): boolean {
    return this.revision !== this.savedRevision
  }

  set(value: T): void {
    this.pending = value
    this.revision += 1
  }

  flush(): Promise<void> {
    if (this.running) return this.running
    this.running = this.drain().finally(() => { this.running = null })
    return this.running
  }

  private async drain(): Promise<void> {
    while (this.dirty && this.pending !== undefined) {
      const revision = this.revision
      const value = this.pending
      await this.write(value)
      this.savedRevision = revision
    }
  }
}
