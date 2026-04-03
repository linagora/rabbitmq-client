import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Framework-agnostic mock function factory
// ---------------------------------------------------------------------------

interface MockFn {
  (...args: unknown[]): unknown
  mock: { calls: unknown[][] }
  mockResolvedValue: (val: unknown) => MockFn
  mockImplementation: (fn: (...args: unknown[]) => unknown) => MockFn
}

function mockFn(): MockFn {
  let impl: ((...args: unknown[]) => unknown) | null = null
  const calls: unknown[][] = []

  const fn = ((...args: unknown[]) => {
    calls.push(args)
    return impl ? impl(...args) : undefined
  }) as MockFn

  fn.mock = { calls }

  fn.mockResolvedValue = (val: unknown) => {
    impl = () => Promise.resolve(val)
    return fn
  }

  fn.mockImplementation = (newImpl: (...args: unknown[]) => unknown) => {
    impl = newImpl
    return fn
  }

  return fn
}

// ---------------------------------------------------------------------------
// Published message record
// ---------------------------------------------------------------------------

export interface PublishedMessage {
  exchange: string
  routingKey: string
  message: unknown
  options: unknown
}

// ---------------------------------------------------------------------------
// MockRabbitMQChannel
// ---------------------------------------------------------------------------

export class MockRabbitMQChannel extends EventEmitter {
  private _publishedMessages: PublishedMessage[] = []
  private _consumeCallback: ((msg: unknown) => void) | null = null

  isClosed = false

  // Stubs
  readonly assertExchange = mockFn().mockResolvedValue({})
  readonly assertQueue = mockFn().mockResolvedValue({ queue: '' })
  readonly bindQueue = mockFn().mockResolvedValue({})
  readonly ack = mockFn()
  readonly nack = mockFn()
  readonly close = mockFn().mockResolvedValue(undefined)
  readonly waitForConfirms = mockFn().mockResolvedValue(undefined)
  readonly prefetch = mockFn().mockResolvedValue(undefined)
  readonly deleteQueue = mockFn().mockResolvedValue({})
  readonly cancel = mockFn().mockResolvedValue(undefined)

  /**
   * Tracks all published messages and stores them for later inspection.
   */
  publish(exchange: string, routingKey: string, content: Buffer, options?: unknown): boolean {
    let message: unknown
    try {
      message = JSON.parse(content.toString())
    } catch {
      message = content.toString()
    }
    this._publishedMessages.push({ exchange, routingKey, message, options })
    return true
  }

  private _consumerCounter = 0

  /**
   * Stores the consumer callback for use with simulateMessage.
   * Returns a unique consumer tag per call.
   */
  consume(_queue: string, callback: (msg: unknown) => void): Promise<{ consumerTag: string }> {
    this._consumeCallback = callback
    const consumerTag = `mock-consumer-${++this._consumerCounter}`
    return Promise.resolve({ consumerTag })
  }

  // ---------------------------------------------------------------------------
  // Simulation helpers
  // ---------------------------------------------------------------------------

  /**
   * Delivers a valid JSON message to the registered consume callback.
   */
  simulateMessage(content: unknown): void {
    this._deliver(Buffer.from(JSON.stringify(content)))
  }

  /**
   * Delivers a message with content that is not valid JSON.
   */
  simulateInvalidJsonMessage(): void {
    this._deliver(Buffer.from('not valid json {'))
  }

  private _deliver(content: Buffer): void {
    if (!this._consumeCallback) return
    this._consumeCallback({
      content,
      fields: { deliveryTag: 1, redelivered: false, exchange: '', routingKey: '', consumerTag: 'mock-consumer' },
      properties: { headers: {} },
    })
  }

  /** Emits a close event and marks the channel as closed. */
  simulateClose(): void {
    this.isClosed = true
    this.emit('close')
  }

  /** Emits an error event. */
  simulateError(error: Error): void {
    this.emit('error', error)
  }

  // ---------------------------------------------------------------------------
  // Inspection helpers
  // ---------------------------------------------------------------------------

  getPublishedMessages(): PublishedMessage[] {
    return [...this._publishedMessages]
  }

  clearMessages(): void {
    this._publishedMessages = []
  }

  /** Resets all state back to initial values. */
  reset(): void {
    this._publishedMessages = []
    this._consumeCallback = null
    this._consumerCounter = 0
    this.isClosed = false
    this.removeAllListeners()
  }
}

// ---------------------------------------------------------------------------
// MockRabbitMQConnection
// ---------------------------------------------------------------------------

export class MockRabbitMQConnection extends EventEmitter {
  private _channels: MockRabbitMQChannel[] = []

  isConnected = true

  constructor() {
    super()
    // Create the initial channel eagerly so `conn.channel` is defined
    // before the first createConfirmChannel call.
    this._channels.push(new MockRabbitMQChannel())
  }

  /**
   * Returns the most recently created channel.
   */
  get channel(): MockRabbitMQChannel {
    return this._channels[this._channels.length - 1]
  }

  /**
   * Returns all channels created so far (including the initial one).
   */
  get channels(): MockRabbitMQChannel[] {
    return [...this._channels]
  }

  get channelCount(): number {
    return this._channels.length
  }

  /**
   * Creates a new channel (simulates a reconnection / new confirm-channel).
   */
  createConfirmChannel(): Promise<MockRabbitMQChannel> {
    const ch = new MockRabbitMQChannel()
    this._channels.push(ch)
    return Promise.resolve(ch)
  }

  close(): Promise<void> {
    this.isConnected = false
    return Promise.resolve()
  }

  /** Emits a close event and marks the connection as disconnected. */
  simulateClose(): void {
    this.isConnected = false
    this.emit('close')
  }

  /** Emits an error event. */
  simulateError(error: Error): void {
    this.emit('error', error)
  }

  /** Resets to the initial connected state with a single fresh channel. */
  reset(): void {
    this._channels = [new MockRabbitMQChannel()]
    this.isConnected = true
    this.removeAllListeners()
  }
}

// ---------------------------------------------------------------------------
// createMockAmqplib
// ---------------------------------------------------------------------------

export interface AmqpMock {
  connect: MockFn
}

export interface MockAmqplibResult {
  mockConnection: MockRabbitMQConnection
  amqpMock: AmqpMock
}

/**
 * Returns a pre-wired { mockConnection, amqpMock } pair that can be used as
 * a drop-in replacement for amqplib in tests (e.g. via vi.mock or jest.mock).
 */
export function createMockAmqplib(): MockAmqplibResult {
  const mockConnection = new MockRabbitMQConnection()
  const amqpMock: AmqpMock = {
    connect: mockFn().mockResolvedValue(mockConnection),
  }
  return { mockConnection, amqpMock }
}
