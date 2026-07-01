import { describe, it, expect } from 'vitest'
import { Semaphore } from '../src/semaphore.js'

describe('Semaphore', () => {
  it('rejects a non-positive or non-integer permit count', () => {
    expect(() => new Semaphore(0)).toThrow()
    expect(() => new Semaphore(-1)).toThrow()
    expect(() => new Semaphore(1.5)).toThrow()
  })

  it('grants permits immediately while capacity is available', async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    await sem.acquire()
    expect(sem.available).toBe(0)
    expect(sem.waiting).toBe(0)
  })

  it('queues acquirers beyond capacity until a permit is released', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    let secondAcquired = false
    const second = sem.acquire().then(() => {
      secondAcquired = true
    })

    // Still blocked: the only permit is held.
    await Promise.resolve()
    expect(secondAcquired).toBe(false)
    expect(sem.waiting).toBe(1)

    sem.release()
    await second
    expect(secondAcquired).toBe(true)
    expect(sem.waiting).toBe(0)
  })

  it('hands a released permit to waiters in FIFO order', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    const order: number[] = []
    const first = sem.acquire().then(() => order.push(1))
    const second = sem.acquire().then(() => order.push(2))

    sem.release()
    await first
    sem.release()
    await second

    expect(order).toEqual([1, 2])
  })

  it('never exceeds its permit ceiling under a burst', async () => {
    const CONCURRENCY = 3
    const sem = new Semaphore(CONCURRENCY)
    let active = 0
    let peak = 0

    const task = async () => {
      await sem.acquire()
      try {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
      } finally {
        active--
        sem.release()
      }
    }

    await Promise.all(Array.from({ length: 20 }, task))
    // Exactly the ceiling: never over (correctness) and actually reached, so an
    // over-serializing regression (peak < ceiling) is caught too.
    expect(peak).toBe(CONCURRENCY)
  })
})
