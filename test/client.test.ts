import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Connection, ConfirmChannel } from 'amqplib'

// Hoist mock objects so they are available inside the vi.mock factory
const { mockChannel, mockConnection } = vi.hoisted(() => {
  const mockChannel = {
    prefetch: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
    assertExchange: vi.fn().mockResolvedValue({}),
    assertQueue: vi.fn().mockResolvedValue({ queue: 'test-queue' }),
    bindQueue: vi.fn().mockResolvedValue({}),
    publish: vi.fn().mockReturnValue(true),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ consumerTag: 'test' }),
    ack: vi.fn(),
    nack: vi.fn(),
    deleteQueue: vi.fn().mockResolvedValue({}),
  } as unknown as ConfirmChannel & Record<string, ReturnType<typeof vi.fn>>

  const mockConnection = {
    createConfirmChannel: vi.fn().mockResolvedValue(mockChannel),
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Connection & Record<string, ReturnType<typeof vi.fn>>

  return { mockChannel, mockConnection }
})

vi.mock('amqplib', () => ({
  default: {
    connect: vi.fn().mockResolvedValue(mockConnection),
  },
}))

import amqp from 'amqplib'
import { RabbitMQClient } from '../src/client.js'

const baseOptions = {
  url: 'amqp://localhost',
  maxRetries: 3,
  retryDelay: 10,
  connectionRetryDelay: 10,
  initMaxAttempts: 5,
  publishMaxAttempts: 5,
  prefetch: 10,
}

describe('RabbitMQClient', () => {
  let client: RabbitMQClient

  beforeEach(() => {
    vi.clearAllMocks()

    // Restore default implementations cleared by clearAllMocks
    mockChannel.prefetch.mockResolvedValue(undefined)
    mockChannel.on.mockReturnThis()
    mockChannel.close.mockResolvedValue(undefined)
    mockChannel.assertExchange.mockResolvedValue({})
    mockChannel.assertQueue.mockResolvedValue({ queue: 'test-queue' })
    mockChannel.bindQueue.mockResolvedValue({})
    mockChannel.publish.mockReturnValue(true)
    mockChannel.waitForConfirms.mockResolvedValue(undefined)
    mockChannel.consume.mockResolvedValue({ consumerTag: 'test' })
    mockChannel.deleteQueue.mockResolvedValue({})

    mockConnection.createConfirmChannel.mockResolvedValue(mockChannel)
    mockConnection.on.mockReturnThis()
    mockConnection.close.mockResolvedValue(undefined)

    vi.mocked(amqp.connect).mockResolvedValue(mockConnection as unknown as Connection)

    vi.useFakeTimers()
    client = new RabbitMQClient(baseOptions)
  })

  afterEach(async () => {
    vi.useRealTimers()
  })

  describe('init()', () => {
    it('should connect and create a confirm channel', async () => {
      await client.init()

      expect(amqp.connect).toHaveBeenCalledWith('amqp://localhost')
      expect(mockConnection.createConfirmChannel).toHaveBeenCalledOnce()
      expect(mockChannel.prefetch).toHaveBeenCalledWith(10)
      expect(client.isConnected()).toBe(true)
    })

    it('should register connection and channel event handlers', async () => {
      await client.init()

      expect(mockConnection.on).toHaveBeenCalledWith('error', expect.any(Function))
      expect(mockConnection.on).toHaveBeenCalledWith('close', expect.any(Function))
      expect(mockChannel.on).toHaveBeenCalledWith('error', expect.any(Function))
      expect(mockChannel.on).toHaveBeenCalledWith('close', expect.any(Function))
    })

    it('should be idempotent when already connected', async () => {
      await client.init()
      await client.init()

      expect(amqp.connect).toHaveBeenCalledOnce()
    })

    it('should deduplicate concurrent init calls', async () => {
      const init1 = client.init()
      const init2 = client.init()

      await Promise.all([init1, init2])

      expect(amqp.connect).toHaveBeenCalledOnce()
    })

    it('should retry on connection failure and succeed', async () => {
      const connectMock = vi.mocked(amqp.connect)
      connectMock
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'))
        .mockResolvedValueOnce(mockConnection as unknown as Connection)

      const initPromise = client.init()
      await vi.advanceTimersByTimeAsync(100)
      await initPromise

      expect(connectMock).toHaveBeenCalledTimes(3)
      expect(client.isConnected()).toBe(true)
    })

    it('should throw after exhausting initMaxAttempts', async () => {
      const connectMock = vi.mocked(amqp.connect)
      connectMock.mockRejectedValue(new Error('refused'))

      // Attach the rejection handler before advancing timers to avoid
      // a brief "unhandled rejection" window during fake timer advancement.
      const assertion = expect(client.init()).rejects.toThrow(/5 attempts/)
      await vi.advanceTimersByTimeAsync(500)

      await assertion
    })
  })

  describe('close()', () => {
    it('should close channel and connection', async () => {
      await client.init()
      await client.close()

      expect(mockChannel.close).toHaveBeenCalledOnce()
      expect(mockConnection.close).toHaveBeenCalledOnce()
      expect(client.isConnected()).toBe(false)
    })

    it('should re-throw errors from channel close', async () => {
      await client.init()
      mockChannel.close.mockRejectedValueOnce(new Error('close failed'))

      await expect(client.close()).rejects.toThrow('close failed')
    })
  })

  describe('isConnected()', () => {
    it('should return false before init', () => {
      expect(client.isConnected()).toBe(false)
    })

    it('should return true after init', async () => {
      await client.init()
      expect(client.isConnected()).toBe(true)
    })

    it('should return false after close', async () => {
      await client.init()
      await client.close()
      expect(client.isConnected()).toBe(false)
    })
  })
})
