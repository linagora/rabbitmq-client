import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Connection, ConfirmChannel } from 'amqplib'

// A channel factory, unlike the shared singleton in client.test.ts, so a
// reconnect can hand the client a genuinely different channel object.
function createChannel(name: string) {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const ch = {
    name,
    isClosed: false,
    prefetch: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, fn)
      return ch
    }),
    close: vi.fn().mockResolvedValue(undefined),
    assertExchange: vi.fn().mockResolvedValue({}),
    assertQueue: vi.fn().mockResolvedValue({ queue: 'test-queue' }),
    bindQueue: vi.fn().mockResolvedValue({}),
    publish: vi.fn().mockReturnValue(true),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn(),
    deleteQueue: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    // amqplib's ConfirmChannel throws IllegalOperationError on a closed
    // channel; the mock in src/testing tracks isClosed but does not enforce it.
    ack: vi.fn(() => {
      if (ch.isClosed) throw new IllegalOperationError('Channel closed')
    }),
    nack: vi.fn(() => {
      if (ch.isClosed) throw new IllegalOperationError('Channel closed')
    }),
    // test-only helpers
    deliver: null as null | ((msg: unknown) => void),
    fire: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  }
  ch.consume.mockImplementation((_queue: string, fn: (msg: unknown) => void) => {
    ch.deliver = fn
    return Promise.resolve({ consumerTag: `tag-${name}` })
  })
  return ch
}

class IllegalOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalOperationError'
  }
}

const { channels, mockConnection } = vi.hoisted(() => ({
  channels: [] as ReturnType<typeof createChannel>[],
  mockConnection: {
    createConfirmChannel: vi.fn(),
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Connection & Record<string, ReturnType<typeof vi.fn>>,
}))

vi.mock('amqplib', () => ({
  default: { connect: vi.fn().mockResolvedValue(mockConnection) },
}))

import amqp from 'amqplib'
import { RabbitMQClient } from '../src/client.js'
import { silentLogger } from '../src/logger.js'

const baseOptions = {
  url: 'amqp://localhost',
  maxRetries: 3,
  retryDelay: 10,
  connectionRetryDelay: 10,
  prefetch: 1,
  logger: silentLogger,
}

const createMessage = (content: unknown) => ({
  content: Buffer.from(JSON.stringify(content)),
  fields: { deliveryTag: 1, redelivered: false, exchange: 'ex', routingKey: 'key', consumerTag: 'test' },
  properties: { headers: {} },
})

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('settle failures', () => {
  let client: RabbitMQClient

  beforeEach(() => {
    vi.clearAllMocks()
    channels.length = 0
    mockConnection.createConfirmChannel.mockImplementation(() => {
      const ch = createChannel(`ch${channels.length + 1}`)
      channels.push(ch)
      return Promise.resolve(ch as unknown as ConfirmChannel)
    })
    mockConnection.on.mockReturnThis()
    mockConnection.close.mockResolvedValue(undefined)
    vi.mocked(amqp.connect).mockResolvedValue(mockConnection as unknown as Connection)
    vi.useFakeTimers()
    client = new RabbitMQClient(baseOptions)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // A throwing ack must not be treated as a handler failure.
  // -------------------------------------------------------------------------
  it('does not re-invoke the handler when only the ack fails', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)

    await client.init()
    await client.subscribe('ex', 'key', 'queue', handler)

    const ch1 = channels[0]
    // Handler succeeds; the transport is what is broken.
    ch1.isClosed = true

    ch1.deliver!(createMessage({ foo: 'bar' }))
    await vi.advanceTimersByTimeAsync(500)

    // The handler ran once and succeeded. A dead socket is not a reason to
    // run its side effects again.
    expect(handler).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // The terminal nack must not leave the message silently unsettled.
  // -------------------------------------------------------------------------
  it('reports a failed nack instead of claiming the message was dead-lettered', async () => {
    // Slow enough that the channel dies partway through the retry loop.
    const handler = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100))
      throw new Error('handler always fails')
    })
    const onMessageDlq = vi.fn()
    const errors: string[] = []
    const logger = { ...silentLogger, error: (msg: string) => { errors.push(msg) } }

    client = new RabbitMQClient({ ...baseOptions, logger, hooks: { onMessageDlq } })
    await client.init()
    await client.subscribe('ex', 'key', 'queue', handler)

    const ch1 = channels[0]
    ch1.deliver!(createMessage({ foo: 'bar' }))
    await vi.advanceTimersByTimeAsync(120)

    // Channel dies before the retries are exhausted.
    ch1.isClosed = true
    await vi.advanceTimersByTimeAsync(1000)

    expect(handler).toHaveBeenCalledTimes(3)

    // The nack could not be delivered, so the message was NOT dead-lettered
    // and the hook must not claim otherwise.
    expect(onMessageDlq).not.toHaveBeenCalled()
    // The failure is reported as what it is, not swallowed as an unhandled
    // error escaping the handler.
    expect(errors).toContain('Failed to settle message; leaving it unacked for redelivery')
    expect(errors).not.toContain('Unhandled error in message handler')
  })
})
