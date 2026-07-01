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
    cancel: vi.fn().mockResolvedValue(undefined),
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
import { silentLogger } from '../src/logger.js'

const baseOptions = {
  url: 'amqp://localhost',
  maxRetries: 3,
  retryDelay: 10,
  connectionRetryDelay: 10,
  initMaxAttempts: 5,
  publishMaxAttempts: 5,
  prefetch: 10,
  logger: silentLogger,
}

const createMessage = (content: unknown) => ({
  content: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
  fields: { deliveryTag: 1, redelivered: false, exchange: 'ex', routingKey: 'key', consumerTag: 'test' },
  properties: { headers: {} },
})

function setupConsumeCapture() {
  let cb: ((msg: unknown) => void) | null = null
  mockChannel.consume.mockImplementation(((_queue: string, fn: (msg: unknown) => void) => {
    cb = fn
    return Promise.resolve({ consumerTag: 'test' })
  }) as typeof mockChannel.consume)
  return (msg: unknown) => cb!(msg)
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
    mockChannel.cancel.mockResolvedValue(undefined)

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

  describe('publish()', () => {
    beforeEach(async () => {
      await client.init()
    })

    it('should assert exchange, publish with persistent flag, and confirm', async () => {
      await client.publish('test-exchange', 'test.key', { foo: 'bar' })

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', { durable: true })
      expect(mockChannel.publish).toHaveBeenCalledOnce()
      const [exchange, routingKey, content, options] = mockChannel.publish.mock.calls[0]
      expect(exchange).toBe('test-exchange')
      expect(routingKey).toBe('test.key')
      expect(JSON.parse(content.toString())).toEqual({ foo: 'bar' })
      expect(options).toEqual({ persistent: true })
      expect(mockChannel.waitForConfirms).toHaveBeenCalledOnce()
    })

    it('should retry with exponential backoff on failure', async () => {
      mockChannel.waitForConfirms
        .mockRejectedValueOnce(new Error('confirm failed'))
        .mockResolvedValueOnce(undefined)

      const publishPromise = client.publish('ex', 'key', { msg: 1 })
      await vi.advanceTimersByTimeAsync(200)
      await publishPromise

      // First attempt failed, second succeeded after reconnect
      expect(vi.mocked(amqp.connect)).toHaveBeenCalledTimes(2)
    })

    it('should throw after exhausting publishMaxAttempts', async () => {
      mockChannel.waitForConfirms.mockRejectedValue(new Error('confirm failed'))

      // Override to keep failing on new channels too
      mockConnection.createConfirmChannel.mockImplementation(() => {
        const failChannel = { ...mockChannel, waitForConfirms: vi.fn().mockRejectedValue(new Error('confirm failed')) }
        return Promise.resolve(failChannel)
      })

      // Attach the rejection handler before advancing timers to avoid
      // a brief "unhandled rejection" window during fake timer advancement.
      const assertion = expect(client.publish('ex', 'key', { msg: 1 }, { maxAttempts: 2 })).rejects.toThrow(/2 attempts/)
      await vi.advanceTimersByTimeAsync(500)

      await assertion

      // Restore for other tests
      mockConnection.createConfirmChannel.mockResolvedValue(mockChannel)
    })

    it('should force reconnect on publish error (dead channel detection)', async () => {
      mockChannel.waitForConfirms.mockRejectedValueOnce(new Error('dead'))

      const publishPromise = client.publish('ex', 'key', { msg: 1 })
      await vi.advanceTimersByTimeAsync(200)
      await publishPromise

      // connected was set to false, forcing reconnection
      expect(vi.mocked(amqp.connect)).toHaveBeenCalledTimes(2)
    })
  })

  describe('subscribe()', () => {
    beforeEach(async () => {
      await client.init()
    })

    it('should set up DLQ infrastructure', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('test-exchange', 'test.key', 'test-queue', handler)

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange.dlx', 'topic', { durable: true })
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-queue.dlq', { durable: true })
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue.dlq', 'test-exchange.dlx', 'test.key.dead')
    })

    it('should create main queue with quorum type and DLQ config', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('test-exchange', 'test.key', 'test-queue', handler)

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-queue', {
        durable: true,
        deadLetterExchange: 'test-exchange.dlx',
        deadLetterRoutingKey: 'test.key.dead',
        arguments: {
          'x-dead-letter-strategy': 'at-least-once',
          'x-queue-type': 'quorum',
          'x-overflow': 'reject-publish',
        },
      })
    })

    it('should bind queue and start consuming with manual ack', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('test-exchange', 'test.key', 'test-queue', handler)

      expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue', 'test-exchange', 'test.key')
      expect(mockChannel.consume).toHaveBeenCalledOnce()
      expect(mockChannel.consume.mock.calls[0][0]).toBe('test-queue')
      expect(mockChannel.consume.mock.calls[0][2]).toEqual({ noAck: false })
    })

    it('should throw when not connected', async () => {
      await client.close()
      const handler = vi.fn().mockResolvedValue(undefined)
      await expect(client.subscribe('ex', 'key', 'queue', handler)).rejects.toThrow('not connected')
    })

    it('should not duplicate subscriptions for the same queue', async () => {
      const handler1 = vi.fn().mockResolvedValue(undefined)
      const handler2 = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler1)
      await client.subscribe('ex', 'key', 'queue', handler2)
      expect(mockChannel.consume).toHaveBeenCalledTimes(2)
    })
  })

  describe('handleWithRetry()', () => {
    let deliver: (msg: unknown) => void

    beforeEach(async () => {
      deliver = setupConsumeCapture()
      await client.init()
    })

    it('should ack on successful processing', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler)
      const msg = createMessage({ foo: 'bar' })
      deliver(msg)
      await vi.advanceTimersByTimeAsync(50)
      expect(handler).toHaveBeenCalledWith({ foo: 'bar' })
      expect(mockChannel.ack).toHaveBeenCalledWith(msg)
    })

    it('should nack invalid JSON immediately to DLQ', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler)
      const msg = createMessage('not valid json {')
      deliver(msg)
      await vi.advanceTimersByTimeAsync(50)
      expect(handler).not.toHaveBeenCalled()
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false)
    })

    it('should retry on handler failure and ack on eventual success', async () => {
      const handler = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(undefined)
      await client.subscribe('ex', 'key', 'queue', handler)
      const msg = createMessage({ foo: 'bar' })
      deliver(msg)
      await vi.advanceTimersByTimeAsync(200)
      expect(handler).toHaveBeenCalledTimes(2)
      expect(mockChannel.ack).toHaveBeenCalledWith(msg)
      expect(mockChannel.nack).not.toHaveBeenCalled()
    })

    it('should nack to DLQ after exhausting maxRetries', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('always fails'))
      await client.subscribe('ex', 'key', 'queue', handler)
      const msg = createMessage({ foo: 'bar' })
      deliver(msg)
      await vi.advanceTimersByTimeAsync(500)
      expect(handler).toHaveBeenCalledTimes(3) // maxRetries = 3
      expect(mockChannel.ack).not.toHaveBeenCalled()
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false)
    })
  })

  describe('checkHealth()', () => {
    it('should return false when not connected', async () => {
      expect(await client.checkHealth()).toBe(false)
    })

    it('should return true when connection is healthy', async () => {
      await client.init()
      expect(await client.checkHealth()).toBe(true)
      expect(mockChannel.assertQueue).toHaveBeenCalled()
      expect(mockChannel.deleteQueue).toHaveBeenCalled()
    })

    it('should return false when queue operation fails', async () => {
      await client.init()
      mockChannel.assertQueue.mockRejectedValueOnce(new Error('queue op failed'))
      expect(await client.checkHealth()).toBe(false)
    })
  })

  describe('reconnection', () => {
    it('should reconnect and restore subscriptions on connection close', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.init()
      await client.subscribe('ex', 'key', 'queue', handler)

      // Capture the connection close handler
      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      // Reset mocks to track reconnection calls
      vi.mocked(amqp.connect).mockClear()
      mockChannel.consume.mockClear()

      // Trigger connection close
      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      // Should have reconnected
      expect(amqp.connect).toHaveBeenCalledOnce()
      // Should have restored the subscription
      expect(mockChannel.consume).toHaveBeenCalledOnce()
      expect(mockChannel.consume.mock.calls[0][0]).toBe('queue')
      expect(client.isConnected()).toBe(true)
    })

    it('should reconnect on channel error', async () => {
      await client.init()

      const channelErrorHandler = mockChannel.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'error',
      )![1] as (err: Error) => void

      vi.mocked(amqp.connect).mockClear()

      channelErrorHandler(new Error('channel died'))
      await vi.advanceTimersByTimeAsync(200)

      expect(amqp.connect).toHaveBeenCalledOnce()
      expect(client.isConnected()).toBe(true)
    })

    it('should reconnect on channel close', async () => {
      await client.init()

      const channelCloseHandler = mockChannel.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      vi.mocked(amqp.connect).mockClear()

      channelCloseHandler()
      await vi.advanceTimersByTimeAsync(200)

      expect(amqp.connect).toHaveBeenCalledOnce()
      expect(client.isConnected()).toBe(true)
    })

    it('should preserve subscriptions across close(false) and re-init', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.init()
      await client.subscribe('ex', 'key', 'queue', handler)

      await client.close(false)
      mockChannel.consume.mockClear()

      await client.init()

      // Trigger reconnection to test subscription restoration
      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      mockChannel.consume.mockClear()
      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      expect(mockChannel.consume).toHaveBeenCalledOnce()
      expect(mockChannel.consume.mock.calls[0][0]).toBe('queue')
    })

    it('should clear subscriptions on close() by default', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.init()
      await client.subscribe('ex', 'key', 'queue', handler)

      await client.close() // clears subscriptions

      await client.init()
      mockChannel.consume.mockClear()

      // Trigger reconnection
      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      // No subscriptions to restore
      expect(mockChannel.consume).not.toHaveBeenCalled()
    })
  })

  describe('unsubscribe()', () => {
    beforeEach(async () => {
      await client.init()
    })

    it('should cancel consumer and remove subscription', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler)
      await client.unsubscribe('queue')

      expect(mockChannel.cancel).toHaveBeenCalledWith('test')
    })

    it('should not restore unsubscribed queue on reconnect', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler)
      await client.unsubscribe('queue')

      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      mockChannel.consume.mockClear()
      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      expect(mockChannel.consume).not.toHaveBeenCalled()
    })

    it('should not throw for unknown queue', async () => {
      await expect(client.unsubscribe('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('subscribe() with options', () => {
    beforeEach(async () => {
      await client.init()
    })

    it('should merge custom queue arguments with defaults', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler, {
        queueArguments: { 'x-queue-type': 'classic', 'x-max-length': 1000 },
      })

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('queue', {
        durable: true,
        deadLetterExchange: 'ex.dlx',
        deadLetterRoutingKey: 'key.dead',
        arguments: {
          'x-queue-type': 'classic',
          'x-overflow': 'reject-publish',
          'x-max-length': 1000,
        },
      })
    })

    it('should preserve custom options across reconnection', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler, {
        queueArguments: { 'x-queue-type': 'classic' },
      })

      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      mockChannel.assertQueue.mockClear()
      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('queue', expect.objectContaining({
        arguments: expect.objectContaining({ 'x-queue-type': 'classic' }),
      }))
    })
  })

  describe('exchange assertion caching', () => {
    beforeEach(async () => {
      await client.init()
    })

    it('should only assert exchange once across multiple publishes', async () => {
      mockChannel.assertExchange.mockClear()

      await client.publish('ex', 'key', { msg: 1 })
      await client.publish('ex', 'key', { msg: 2 })
      await client.publish('ex', 'key', { msg: 3 })

      const assertCalls = mockChannel.assertExchange.mock.calls.filter(
        (call: unknown[]) => call[0] === 'ex',
      )
      expect(assertCalls).toHaveLength(1)
    })

    it('should re-assert exchange after reconnection', async () => {
      await client.publish('ex', 'key', { msg: 1 })

      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      mockChannel.assertExchange.mockClear()
      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      await client.publish('ex', 'key', { msg: 2 })
      const assertCalls = mockChannel.assertExchange.mock.calls.filter(
        (call: unknown[]) => call[0] === 'ex',
      )
      expect(assertCalls).toHaveLength(1)
    })
  })

  describe('graceful shutdown', () => {
    it('should wait for in-flight messages before closing', async () => {
      let resolveHandler!: () => void
      const handler = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveHandler = resolve }),
      )

      const deliver = setupConsumeCapture()
      await client.init()
      await client.subscribe('ex', 'key', 'queue', handler)

      deliver(createMessage({ foo: 'bar' }))
      await vi.advanceTimersByTimeAsync(0)

      let closeResolved = false
      const closePromise = client.close().then(() => { closeResolved = true })

      await vi.advanceTimersByTimeAsync(100)
      expect(closeResolved).toBe(false)

      resolveHandler()
      await vi.advanceTimersByTimeAsync(0)
      await closePromise

      expect(closeResolved).toBe(true)
    })

    it('should close after timeout if messages are still in-flight', async () => {
      const handler = vi.fn().mockImplementation(
        () => new Promise<void>(() => { /* never resolves */ }),
      )

      const deliver = setupConsumeCapture()
      const shortTimeoutClient = new RabbitMQClient({ ...baseOptions, closeTimeout: 500 })
      await shortTimeoutClient.init()
      await shortTimeoutClient.subscribe('ex', 'key', 'queue', handler)

      deliver(createMessage({ foo: 'bar' }))
      await vi.advanceTimersByTimeAsync(0)

      let closeResolved = false
      const closePromise = shortTimeoutClient.close().then(() => { closeResolved = true })

      await vi.advanceTimersByTimeAsync(499)
      expect(closeResolved).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await closePromise
      expect(closeResolved).toBe(true)
    })
  })

  describe('hooks', () => {
    it('should call onPublish after successful publish', async () => {
      const onPublish = vi.fn()
      const hookClient = new RabbitMQClient({ ...baseOptions, hooks: { onPublish } })
      await hookClient.init()
      await hookClient.publish('ex', 'key', { msg: 1 })

      expect(onPublish).toHaveBeenCalledWith({ exchange: 'ex', routingKey: 'key', attempts: 1 })
    })

    it('should call onMessageProcessed after handler success', async () => {
      const onMessageProcessed = vi.fn()
      const hookClient = new RabbitMQClient({ ...baseOptions, hooks: { onMessageProcessed } })

      const deliver = setupConsumeCapture()
      await hookClient.init()
      const handler = vi.fn().mockResolvedValue(undefined)
      await hookClient.subscribe('ex', 'key', 'queue', handler)

      deliver(createMessage({ foo: 'bar' }))
      await vi.advanceTimersByTimeAsync(50)

      expect(onMessageProcessed).toHaveBeenCalledWith(
        expect.objectContaining({ exchange: 'ex', routingKey: 'key', attempts: 1 }),
      )
    })

    it('should call onMessageDlq when message sent to DLQ', async () => {
      const onMessageDlq = vi.fn()
      const hookClient = new RabbitMQClient({ ...baseOptions, hooks: { onMessageDlq } })

      const deliver = setupConsumeCapture()
      await hookClient.init()
      const handler = vi.fn().mockRejectedValue(new Error('always fails'))
      await hookClient.subscribe('ex', 'key', 'queue', handler)

      deliver(createMessage({ foo: 'bar' }))
      await vi.advanceTimersByTimeAsync(500)

      expect(onMessageDlq).toHaveBeenCalledWith(
        expect.objectContaining({ exchange: 'ex', routingKey: 'key', reason: 'max_retries_exhausted' }),
      )
    })

    it('should call onMessageDlq for invalid JSON', async () => {
      const onMessageDlq = vi.fn()
      const hookClient = new RabbitMQClient({ ...baseOptions, hooks: { onMessageDlq } })

      const deliver = setupConsumeCapture()
      await hookClient.init()
      const handler = vi.fn().mockResolvedValue(undefined)
      await hookClient.subscribe('ex', 'key', 'queue', handler)

      deliver(createMessage('not valid json'))
      await vi.advanceTimersByTimeAsync(50)

      expect(onMessageDlq).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'invalid_json', duration: 0 }),
      )
    })

    it('should not break when hook throws', async () => {
      const onPublish = vi.fn().mockImplementation(() => { throw new Error('hook error') })
      const hookClient = new RabbitMQClient({ ...baseOptions, hooks: { onPublish } })
      await hookClient.init()

      await expect(hookClient.publish('ex', 'key', { msg: 1 })).resolves.toBeUndefined()
    })
  })

  describe('processing concurrency', () => {
    // A handler that blocks until explicitly released, tracking how many are
    // running at once so we can assert the concurrency ceiling is respected.
    function blockingHandler() {
      let active = 0
      let peak = 0
      const releases: Array<() => void> = []
      const handler = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            active++
            peak = Math.max(peak, active)
            releases.push(() => {
              active--
              resolve()
            })
          }),
      )
      return {
        handler,
        get active() { return active },
        get peak() { return peak },
        releaseOne() { releases.shift()?.() },
        // Drain any still-blocked handlers so a test never leaves permanently
        // pending promises behind.
        releaseAll() { while (releases.length) releases.shift()!() },
      }
    }

    it('caps concurrent handler execution at the configured concurrency', async () => {
      const c = new RabbitMQClient({ ...baseOptions, concurrency: 2 })
      const deliver = setupConsumeCapture()
      await c.init()
      const h = blockingHandler()
      await c.subscribe('ex', 'key', 'queue', h.handler)

      for (let i = 0; i < 5; i++) deliver(createMessage({ n: i }))
      await vi.advanceTimersByTimeAsync(0)

      // Only two run; the other three wait on a permit.
      expect(h.handler).toHaveBeenCalledTimes(2)
      expect(h.active).toBe(2)

      // Releasing one frees a permit, so exactly one queued message starts.
      h.releaseOne()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.handler).toHaveBeenCalledTimes(3)
      expect(h.active).toBe(2)

      h.releaseOne(); h.releaseOne(); h.releaseOne(); h.releaseOne()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.handler).toHaveBeenCalledTimes(5)
      expect(h.peak).toBe(2)
    })

    it('defaults concurrency to the prefetch value', async () => {
      // baseOptions sets prefetch 10 and no explicit concurrency.
      const deliver = setupConsumeCapture()
      await client.init()
      const h = blockingHandler()
      await client.subscribe('ex', 'key', 'queue', h.handler)

      for (let i = 0; i < 12; i++) deliver(createMessage({ n: i }))
      await vi.advanceTimersByTimeAsync(0)

      expect(h.handler).toHaveBeenCalledTimes(10)
      expect(h.peak).toBe(10)
      h.releaseAll()
    })

    it('lets a subscription override the client concurrency', async () => {
      const c = new RabbitMQClient({ ...baseOptions, concurrency: 5 })
      const deliver = setupConsumeCapture()
      await c.init()
      const h = blockingHandler()
      await c.subscribe('ex', 'key', 'queue', h.handler, { concurrency: 1 })

      for (let i = 0; i < 3; i++) deliver(createMessage({ n: i }))
      await vi.advanceTimersByTimeAsync(0)

      expect(h.handler).toHaveBeenCalledTimes(1)
      expect(h.active).toBe(1)
      h.releaseAll()
    })

    it('drains messages queued behind a full semaphore on graceful close()', async () => {
      // concurrency 1 forces messages 2 and 3 to wait on a permit; a long
      // closeTimeout ensures the test controls completion, not the timer.
      const c = new RabbitMQClient({ ...baseOptions, concurrency: 1, closeTimeout: 60_000 })
      const deliver = setupConsumeCapture()
      await c.init()
      const h = blockingHandler()
      await c.subscribe('ex', 'key', 'queue', h.handler)

      for (let i = 0; i < 3; i++) deliver(createMessage({ n: i }))
      await vi.advanceTimersByTimeAsync(0)
      expect(h.handler).toHaveBeenCalledTimes(1)

      let closed = false
      const closePromise = c.close().then(() => { closed = true })

      // close() must not resolve until the permit-queued messages have run too.
      h.releaseOne()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.handler).toHaveBeenCalledTimes(2)
      expect(closed).toBe(false)

      h.releaseOne()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.handler).toHaveBeenCalledTimes(3)
      expect(closed).toBe(false)

      h.releaseOne()
      await vi.advanceTimersByTimeAsync(0)
      await closePromise
      expect(closed).toBe(true)
    })

    it('treats concurrency <= 0 (and an unlimited prefetch: 0) as no limit', async () => {
      for (const opts of [{ concurrency: 0 }, { prefetch: 0 }]) {
        const c = new RabbitMQClient({ ...baseOptions, ...opts })
        const deliver = setupConsumeCapture()
        await c.init()
        const h = blockingHandler()
        // Must not throw building an absent limiter (regression guard for
        // new Semaphore(0)).
        await expect(c.subscribe('ex', 'key', 'queue', h.handler)).resolves.toBeUndefined()

        for (let i = 0; i < 15; i++) deliver(createMessage({ n: i }))
        await vi.advanceTimersByTimeAsync(0)

        expect(h.handler).toHaveBeenCalledTimes(15)
        h.releaseAll()
      }
    })
  })
})
