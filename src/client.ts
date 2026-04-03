import amqp from 'amqplib'
import type {
  RabbitMQClientOptions,
  RabbitMQHooks,
  RabbitMQMessage,
  RabbitMQMessageHandler,
  RabbitMQSubscription,
  SubscribeOptions,
} from './types.js'
import { createLogger } from './logger.js'
import type { Logger } from 'pino'

const DEFAULT_PREFETCH = 10
const MAX_PUBLISH_RETRY_DELAY_MS = 60_000

const DEFAULTS = {
  maxRetries: 3,
  retryDelay: 1000,
  connectionRetryDelay: 5000,
  initMaxAttempts: 5,
  publishMaxAttempts: 5,
  prefetch: DEFAULT_PREFETCH,
  closeTimeout: 5000,
} as const

/**
 * Production-grade RabbitMQ client with confirm channels, automatic DLQ
 * infrastructure, reconnection with subscription restoration, and
 * exponential-backoff publishing.
 *
 * @example
 * ```ts
 * const client = new RabbitMQClient({ url: 'amqp://localhost' })
 * await client.init()
 * await client.publish('events', 'user.created', { userId: '123' })
 * await client.subscribe('events', 'user.created', 'user-service', handler)
 * ```
 */
export class RabbitMQClient {
  private connection: amqp.ChannelModel | null = null
  private channel: amqp.ConfirmChannel | null = null
  private connected = false
  private subscriptions: RabbitMQSubscription[] = []
  private readonly options: Required<Omit<RabbitMQClientOptions, 'logger' | 'hooks'>>
  private readonly logger: Logger
  private readonly hooks: RabbitMQHooks
  private initializationPromise: Promise<void> | null = null
  private reconnectionPromise: Promise<void> | null = null
  private assertedExchanges = new Set<string>()
  private consumerTags = new Map<string, string>()
  private inflightCount = 0
  private drainResolve: (() => void) | null = null

  constructor(options: RabbitMQClientOptions) {
    this.options = {
      url: options.url,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      retryDelay: options.retryDelay ?? DEFAULTS.retryDelay,
      connectionRetryDelay: options.connectionRetryDelay ?? DEFAULTS.connectionRetryDelay,
      initMaxAttempts: options.initMaxAttempts ?? DEFAULTS.initMaxAttempts,
      publishMaxAttempts: options.publishMaxAttempts ?? DEFAULTS.publishMaxAttempts,
      prefetch: options.prefetch ?? DEFAULTS.prefetch,
      closeTimeout: options.closeTimeout ?? DEFAULTS.closeTimeout,
    }
    this.logger = createLogger(options.logger)
    this.hooks = options.hooks ?? {}
  }

  /**
   * Opens a connection and creates a confirm channel. Retries up to
   * `initMaxAttempts` times, then throws. Idempotent and safe to call
   * concurrently — duplicate calls share the same in-flight promise.
   */
  async init(): Promise<void> {
    if (this.connection && this.connected) {
      return
    }
    if (this.initializationPromise) {
      return this.initializationPromise
    }
    // Attach a no-op catch to prevent Node from briefly treating this as an
    // unhandled rejection before the await below registers its own handler.
    this.initializationPromise = this.doConnect(this.options.initMaxAttempts)
    this.initializationPromise.catch(() => undefined)
    try {
      await this.initializationPromise
    } finally {
      this.initializationPromise = null
    }
  }

  private async doConnect(maxAttempts?: number): Promise<void> {
    this.assertedExchanges.clear()
    this.consumerTags.clear()
    let attempts = 0
    while (!this.connected) {
      try {
        this.connection = await amqp.connect(this.options.url)
        this.logger.info('Connected to server')
        this.channel = await this.connection.createConfirmChannel()
        this.logger.info('Confirm channel created')
        await this.channel.prefetch(this.options.prefetch)
        this.logger.info({ prefetch: this.options.prefetch }, 'Channel prefetch set')

        this.connection.on('error', (error: Error) => {
          this.connected = false
          this.logger.error({ error }, 'Connection error')
        })
        this.connection.on('close', () => {
          this.connected = false
          this.logger.warn('Connection closed')
          this.reconnectWithRetry()
        })
        this.channel.on('error', (error: Error) => {
          this.logger.error({ error }, 'Channel error')
          this.handleChannelFailure()
        })
        this.channel.on('close', () => {
          this.logger.warn('Channel closed')
          this.handleChannelFailure()
        })

        this.connected = true
        this.logger.info('Client initialized successfully')
      } catch (error) {
        attempts++
        this.connected = false
        if (maxAttempts !== undefined && attempts >= maxAttempts) {
          this.logger.error({ error, attempts, maxAttempts }, 'Connection failed after maximum attempts')
          throw new Error(
            `Failed to connect to RabbitMQ after ${attempts} attempts. ` +
              'Check RABBITMQ_URL configuration and RabbitMQ server availability.',
          )
        }
        this.logger.warn(
          {
            error,
            attempt: attempts,
            maxAttempts: maxAttempts ?? 'unlimited',
            retryDelayMs: this.options.connectionRetryDelay,
          },
          'Connection attempt failed, retrying...',
        )
        await this.sleep(this.options.connectionRetryDelay)
      }
    }
  }

  private handleChannelFailure(): void {
    if (this.connected) {
      this.connected = false
      this.reconnectWithRetry()
    }
  }

  /**
   * Returns whether the client currently has an active connection and channel.
   */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * Publishes a JSON message to a topic exchange with publisher confirms.
   * Retries with exponential backoff (capped at 60 s), forcing a reconnect
   * on each failure. Throws after `publishMaxAttempts` exhausted.
   */
  async publish(
    exchange: string,
    routingKey: string,
    message: RabbitMQMessage,
    options?: { maxAttempts?: number },
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = options?.maxAttempts ?? this.options.publishMaxAttempts
    const baseDelay = this.options.connectionRetryDelay
    const content = Buffer.from(JSON.stringify(message))

    while (attempts < maxAttempts) {
      try {
        if (!this.connected) {
          await this.reconnectWithRetry()
        }

        if (!this.channel) {
          throw new Error('Channel not available')
        }

        if (!this.assertedExchanges.has(exchange)) {
          await this.channel.assertExchange(exchange, 'topic', { durable: true })
          this.assertedExchanges.add(exchange)
        }

        this.channel.publish(exchange, routingKey, content, {
          persistent: true,
        })

        await this.channel.waitForConfirms()

        if (attempts > 0) {
          this.logger.info({ exchange, routingKey, messageSize: content.length, attempts }, 'Published message after retries')
        } else {
          this.logger.info({ exchange, routingKey, messageSize: content.length }, 'Published message')
        }
        this.logger.debug({ exchange, routingKey, payload: message }, 'Published message payload')

        this.callHook(this.hooks.onPublish, { exchange, routingKey, attempts: attempts + 1 })

        return
      } catch (error) {
        attempts++
        this.connected = false

        if (attempts >= maxAttempts) {
          this.logger.error(
            { error, exchange, routingKey, attempts, maxAttempts },
            'Publish failed after max attempts',
          )
          throw new Error(
            `Failed to publish to ${exchange}/${routingKey} after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`,
          )
        }

        const retryDelay = Math.min(
          baseDelay * Math.pow(2, attempts - 1),
          MAX_PUBLISH_RETRY_DELAY_MS,
        )

        this.logger.warn(
          { error, exchange, routingKey, attempt: attempts, maxAttempts, retryDelayMs: retryDelay },
          'Publish attempt failed, retrying',
        )

        await this.sleep(retryDelay)
      }
    }
  }

  /**
   * Gracefully shuts down the client. Waits up to `closeTimeout` ms for
   * in-flight message handlers to finish before closing the channel and
   * connection. Pass `false` to preserve subscriptions for a later
   * `init()` / reconnect cycle.
   */
  async close(clearSubscriptions = true): Promise<void> {
    try {
      if (this.inflightCount > 0) {
        this.logger.info({ inflightCount: this.inflightCount }, 'Waiting for in-flight messages to drain')
        await this.waitForDrain(this.options.closeTimeout)
      }
      await this.channel?.close()
      await this.connection?.close()
      this.connection = null
      this.channel = null
      this.connected = false
      this.initializationPromise = null
      this.reconnectionPromise = null
      this.assertedExchanges.clear()
      this.consumerTags.clear()
      if (clearSubscriptions) {
        this.subscriptions = []
      }
      this.logger.info('Connection closed')
    } catch (error) {
      this.logger.error({ error }, 'Error closing connection')
      throw error
    }
  }

  private async reconnectWithRetry(): Promise<void> {
    if (this.reconnectionPromise) {
      return this.reconnectionPromise
    }
    this.connected = false
    this.logger.info('Starting reconnection...')
    this.reconnectionPromise = this.doReconnect()
    this.reconnectionPromise.catch(() => undefined)
    try {
      await this.reconnectionPromise
    } finally {
      this.reconnectionPromise = null
    }
  }

  private async doReconnect(): Promise<void> {
    await this.doConnect()
    await this.resubscribeAll()
  }

  private async resubscribeAll(): Promise<void> {
    if (this.subscriptions.length === 0) {
      return
    }
    this.logger.info({ count: this.subscriptions.length }, 'Re-establishing subscriptions')
    const subs = [...this.subscriptions]
    const results = await Promise.allSettled(
      subs.map(async (sub) => {
        await this.setupSubscription(sub)
        return sub.queue
      }),
    )
    const succeeded: string[] = []
    const failed: string[] = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        succeeded.push(result.value)
      } else {
        const queue = subs[index].queue
        failed.push(queue)
        this.logger.error({ error: result.reason, queue }, 'Failed to re-subscribe to queue')
      }
    })
    if (succeeded.length > 0) {
      this.logger.info({ count: succeeded.length, queues: succeeded }, 'Successfully re-subscribed to queues')
    }
    if (failed.length > 0) {
      this.logger.warn({ count: failed.length, queues: failed }, 'Some subscriptions failed to restore')
    }
    this.callHook(this.hooks.onReconnect, { subscriptionsRestored: succeeded.length, subscriptionsFailed: failed.length })
  }

  /**
   * Subscribes to a queue with automatic DLQ infrastructure setup.
   *
   * Pass `options.queueArguments` to override the default quorum-queue
   * arguments (merged with the DLQ wiring defaults).
   */
  async subscribe(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: RabbitMQMessageHandler,
    options?: SubscribeOptions,
  ): Promise<void> {
    if (!this.connected || !this.channel) {
      throw new Error('RabbitMQ client not connected. Call init() first.')
    }
    const sub: RabbitMQSubscription = { exchange, routingKey, queue, handler, options }
    const existingIndex = this.subscriptions.findIndex((s) => s.queue === queue)
    if (existingIndex === -1) {
      this.subscriptions.push(sub)
    } else {
      this.subscriptions[existingIndex] = sub
    }
    await this.setupSubscription(sub)
  }

  /**
   * Cancels a queue subscription and removes it from the restoration list.
   */
  async unsubscribe(queue: string): Promise<void> {
    const tag = this.consumerTags.get(queue)
    if (tag && this.channel) {
      await this.channel.cancel(tag)
    }
    this.consumerTags.delete(queue)
    this.subscriptions = this.subscriptions.filter((s) => s.queue !== queue)
    this.logger.info({ queue }, 'Unsubscribed from queue')
  }

  private async setupSubscription(sub: RabbitMQSubscription): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not available')
    }
    const { exchange, routingKey, queue, handler, options } = sub
    const dlxExchange = `${exchange}.dlx`
    const dlqQueue = `${queue}.dlq`
    const dlqRoutingKey = `${routingKey}.dead`

    await this.channel.assertExchange(dlxExchange, 'topic', { durable: true })
    await this.channel.assertQueue(dlqQueue, { durable: true })
    await this.channel.bindQueue(dlqQueue, dlxExchange, dlqRoutingKey)

    if (!this.assertedExchanges.has(exchange)) {
      await this.channel.assertExchange(exchange, 'topic', { durable: true })
      this.assertedExchanges.add(exchange)
    }

    await this.channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: dlxExchange,
      deadLetterRoutingKey: dlqRoutingKey,
      arguments: {
        'x-dead-letter-strategy': 'at-least-once',
        'x-queue-type': 'quorum',
        'x-overflow': 'reject-publish',
        ...options?.queueArguments,
      },
    })

    await this.channel.bindQueue(queue, exchange, routingKey)
    const { consumerTag } = await this.channel.consume(
      queue,
      (message) => {
        if (message) {
          this.handleWithRetry(message, handler)
        }
      },
      { noAck: false },
    )
    this.consumerTags.set(queue, consumerTag)
    this.logger.info({ exchange, routingKey, queue }, 'Subscribed to queue')
  }

  private async handleWithRetry(
    message: amqp.ConsumeMessage,
    handler: RabbitMQMessageHandler,
  ): Promise<void> {
    // Capture the channel reference so ack/nack always targets the channel
    // that delivered this message, even if a reconnection swaps this.channel.
    const channel = this.channel
    if (!channel) {
      this.logger.warn('Cannot process message -- channel unavailable')
      return
    }
    this.inflightCount++
    try {
      const startTime = Date.now()
      let attempts = 0
      const routingKey = message.fields.routingKey
      const exchange = message.fields.exchange

      let content: RabbitMQMessage
      try {
        content = JSON.parse(message.content.toString())
      } catch (parseError) {
        const rawContent = message.content.toString()
        const rawPreview = rawContent.substring(0, 100)
        this.logger.error(
          {
            error: parseError,
            exchange,
            routingKey,
            rawContentPreview: rawPreview + (rawContent.length > 100 ? '...' : ''),
          },
          'Failed to parse message JSON, sending to DLQ',
        )
        channel.nack(message, false, false)
        this.callHook(this.hooks.onMessageDlq, { exchange, routingKey, duration: 0, reason: 'invalid_json' })
        return
      }

      this.logger.debug({ exchange, routingKey, payload: content }, 'Message received, processing')

      while (attempts < this.options.maxRetries) {
        try {
          await handler(content)
          const duration = Date.now() - startTime
          this.logger.info(
            { exchange, routingKey, duration, attempts: attempts + 1 },
            'Message processed successfully',
          )
          channel.ack(message)
          this.callHook(this.hooks.onMessageProcessed, { exchange, routingKey, duration, attempts: attempts + 1 })
          return
        } catch (error) {
          attempts++
          this.logger.error(
            {
              error: error instanceof Error ? error.message : error,
              stack: error instanceof Error ? error.stack : undefined,
              exchange,
              routingKey,
              attempt: attempts,
              maxRetries: this.options.maxRetries,
            },
            'Handler failed',
          )
          if (attempts < this.options.maxRetries) {
            await this.sleep(this.options.retryDelay)
          }
        }
      }

      const duration = Date.now() - startTime
      this.logger.error(
        { exchange, routingKey, maxRetries: this.options.maxRetries, duration },
        'Message failed after max retries, sending to DLQ',
      )
      channel.nack(message, false, false)
      this.callHook(this.hooks.onMessageDlq, { exchange, routingKey, duration, reason: 'max_retries_exhausted' })
    } finally {
      this.inflightCount--
      if (this.inflightCount === 0 && this.drainResolve) {
        this.drainResolve()
      }
    }
  }

  /**
   * Lightweight liveness probe: creates and immediately deletes a temporary
   * exclusive queue. Returns `false` when disconnected or on broker error.
   */
  async checkHealth(): Promise<boolean> {
    if (!this.connected || !this.channel) {
      return false
    }
    try {
      const { queue } = await this.channel.assertQueue('', {
        exclusive: true,
        autoDelete: true,
      })
      await this.channel.deleteQueue(queue)
      return true
    } catch (error) {
      this.logger.warn({ error }, 'Health check failed')
      return false
    }
  }

  private waitForDrain(timeout: number): Promise<void> {
    if (this.inflightCount === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn(
          { inflightCount: this.inflightCount },
          'Close timeout reached with messages still in flight',
        )
        this.drainResolve = null
        resolve()
      }, timeout)
      this.drainResolve = () => {
        clearTimeout(timer)
        this.drainResolve = null
        resolve()
      }
    })
  }

  /** Invokes a hook callback, swallowing errors so hooks never break message flow. */
  private callHook<T>(hook: ((info: T) => void) | undefined, info: T): void {
    try { hook?.(info) } catch { /* swallowed */ }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
