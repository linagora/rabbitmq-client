import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Connection, ConfirmChannel } from 'amqplib'

class IllegalOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalOperationError'
  }
}

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
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('superseded channel', () => {
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

  it('does not settle a delivery whose channel was replaced while the handler ran', async () => {
    const gate = deferred()
    const handler = vi.fn(() => gate.promise)
    const onMessageProcessed = vi.fn()

    client = new RabbitMQClient({ ...baseOptions, hooks: { onMessageProcessed } })
    await client.init()
    await client.subscribe('ex', 'key', 'queue', handler)

    const ch1 = channels[0]
    ch1.deliver!(createMessage({ foo: 'bar' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(handler).toHaveBeenCalledTimes(1)

    // Broker kills the channel mid-handler (consumer_timeout), exactly as in
    // the incident: channel error, then reconnect.
    ch1.isClosed = true
    ch1.fire('error', new Error('PRECONDITION_FAILED - delivery acknowledgement timed out'))
    await vi.advanceTimersByTimeAsync(200)

    // The reconnect gave the client a new channel and resubscribed on it.
    expect(channels.length).toBe(2)
    const ch2 = channels[1]
    expect(ch2.consume).toHaveBeenCalled()

    // Handler now finishes, long after its channel died.
    gate.resolve()
    await vi.advanceTimersByTimeAsync(200)

    // The dead channel must not be acked, and the delivery tag must not be
    // replayed on ch2 where it refers to nothing.
    expect(ch1.ack).not.toHaveBeenCalled()
    expect(ch2.ack).not.toHaveBeenCalled()
    // Nothing was acknowledged, so nothing was processed as far as the broker
    // is concerned. The hook must not claim otherwise.
    expect(onMessageProcessed).not.toHaveBeenCalled()
  })
})
