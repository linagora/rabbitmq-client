import amqp from 'amqplib'
import type {
  RabbitMQClientOptions,
  RabbitMQMessage,
  RabbitMQMessageHandler,
  RabbitMQSubscription,
} from './types.js'
import { createLogger } from './logger.js'
import type { Logger } from 'pino'

/** Default prefetch count for message consumption */
const DEFAULT_PREFETCH = 10

/** Maximum backoff delay for publish retries (60 seconds) */
const MAX_PUBLISH_RETRY_DELAY_MS = 60_000

/** Default values for optional config */
const DEFAULTS = {
  maxRetries: 3,
  retryDelay: 1000,
  connectionRetryDelay: 5000,
  initMaxAttempts: 5,
  publishMaxAttempts: 5,
  prefetch: DEFAULT_PREFETCH,
} as const

export class RabbitMQClient {
  private connection: amqp.ChannelModel | null = null
  private channel: amqp.ConfirmChannel | null = null
  private connected = false
  private subscriptions: RabbitMQSubscription[] = []
  private readonly options: Required<Omit<RabbitMQClientOptions, 'logger'>>
  private readonly logger: Logger
  private initializationPromise: Promise<void> | null = null
  private reconnectionPromise: Promise<void> | null = null

  constructor(options: RabbitMQClientOptions) {
    this.options = {
      url: options.url,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      retryDelay: options.retryDelay ?? DEFAULTS.retryDelay,
      connectionRetryDelay: options.connectionRetryDelay ?? DEFAULTS.connectionRetryDelay,
      initMaxAttempts: options.initMaxAttempts ?? DEFAULTS.initMaxAttempts,
      publishMaxAttempts: options.publishMaxAttempts ?? DEFAULTS.publishMaxAttempts,
      prefetch: options.prefetch ?? DEFAULTS.prefetch,
    }
    this.logger = createLogger(options.logger)
  }

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

        await this.channel.assertExchange(exchange, 'topic', { durable: true })

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

        return
      } catch (error) {
        attempts++
        this.connected = false

        const serializedError = error instanceof Error
          ? { message: error.message, name: error.name, stack: error.stack }
          : error

        if (attempts >= maxAttempts) {
          this.logger.error(
            { error: serializedError, exchange, routingKey, attempts, maxAttempts },
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
          { error: serializedError, exchange, routingKey, attempt: attempts, maxAttempts, retryDelayMs: retryDelay },
          'Publish attempt failed, retrying',
        )

        await this.sleep(retryDelay)
      }
    }
  }

  async close(clearSubscriptions = true): Promise<void> {
    try {
      await this.channel?.close()
      await this.connection?.close()
      this.connection = null
      this.channel = null
      this.connected = false
      this.initializationPromise = null
      this.reconnectionPromise = null
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
    const results = await Promise.allSettled(
      this.subscriptions.map(async ({ exchange, routingKey, queue, handler }) => {
        await this.setupSubscription(exchange, routingKey, queue, handler)
        return queue
      }),
    )
    const succeeded: string[] = []
    const failed: string[] = []
    results.forEach((result, index) => {
      const queue = this.subscriptions[index].queue
      if (result.status === 'fulfilled') {
        succeeded.push(queue)
      } else {
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
  }

  async subscribe(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: RabbitMQMessageHandler,
  ): Promise<void> {
    const existingIndex = this.subscriptions.findIndex((s) => s.queue === queue)
    if (existingIndex === -1) {
      this.subscriptions.push({ exchange, routingKey, queue, handler })
    } else {
      this.subscriptions[existingIndex] = { exchange, routingKey, queue, handler }
    }
    if (!this.connected || !this.channel) {
      throw new Error('RabbitMQ client not connected. Call init() first.')
    }
    await this.setupSubscription(exchange, routingKey, queue, handler)
  }

  private async setupSubscription(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: RabbitMQMessageHandler,
  ): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not available')
    }
    const dlxExchange = `${exchange}.dlx`
    const dlqQueue = `${queue}.dlq`
    const dlqRoutingKey = `${routingKey}.dead`

    await this.channel.assertExchange(dlxExchange, 'topic', { durable: true })
    await this.channel.assertQueue(dlqQueue, { durable: true })
    await this.channel.bindQueue(dlqQueue, dlxExchange, dlqRoutingKey)
    await this.channel.assertExchange(exchange, 'topic', { durable: true })

    await this.channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: dlxExchange,
      deadLetterRoutingKey: dlqRoutingKey,
      arguments: {
        'x-dead-letter-strategy': 'at-least-once',
        'x-queue-type': 'quorum',
        'x-overflow': 'reject-publish',
      },
    })

    await this.channel.bindQueue(queue, exchange, routingKey)
    await this.channel.consume(
      queue,
      (message) => {
        if (message) {
          this.handleWithRetry(message, handler)
        }
      },
      { noAck: false },
    )
    this.logger.info({ exchange, routingKey, queue }, 'Subscribed to queue')
  }

  private async handleWithRetry(
    message: amqp.ConsumeMessage,
    handler: RabbitMQMessageHandler,
  ): Promise<void> {
    if (!this.channel) {
      this.logger.warn('Cannot process message -- channel unavailable')
      return
    }
    const startTime = Date.now()
    let attempts = 0
    const routingKey = message.fields.routingKey
    const exchange = message.fields.exchange

    let content: RabbitMQMessage
    try {
      content = JSON.parse(message.content.toString())
    } catch (parseError) {
      const rawPreview = message.content.toString().substring(0, 100)
      this.logger.error(
        {
          error: parseError,
          exchange,
          routingKey,
          rawContentPreview: rawPreview + (rawPreview.length >= 100 ? '...' : ''),
        },
        'Failed to parse message JSON, sending to DLQ',
      )
      this.channel.nack(message, false, false)
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
        this.channel.ack(message)
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
    this.channel.nack(message, false, false)
  }

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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
