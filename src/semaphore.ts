/**
 * Minimal FIFO counting semaphore used to cap how many message handlers run
 * concurrently, independently of channel prefetch.
 *
 * Prefetch bounds how many messages the broker delivers into consumer memory;
 * the semaphore bounds how many of those are actively being processed at once.
 * Keeping the two separate lets a consumer buffer a large prefetch window while
 * still protecting a slow downstream (a database, an HTTP API) from a burst.
 */
export class Semaphore {
  private permits: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore requires a positive integer of permits, got ${permits}`)
    }
    this.permits = permits
  }

  /**
   * Acquires a permit, resolving immediately when one is free or queueing
   * (FIFO) until another holder releases. Always pair with `release()` in a
   * `finally` so a throwing handler never leaks a permit.
   */
  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /**
   * Releases a permit. Hands it directly to the next waiter if any are queued,
   * otherwise returns it to the pool.
   */
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.permits++
    }
  }

  /** Permits currently available. Exposed for tests and introspection. */
  get available(): number {
    return this.permits
  }

  /** Number of callers currently queued waiting for a permit. */
  get waiting(): number {
    return this.waiters.length
  }
}
