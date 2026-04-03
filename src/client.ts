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

  // Placeholder -- implemented in Task 5
  private async setupSubscription(
    _exchange: string,
    _routingKey: string,
    _queue: string,
    _handler: RabbitMQMessageHandler,
  ): Promise<void> {}

  // Placeholder -- implemented in Task 6
  private async handleWithRetry(
    _message: amqp.ConsumeMessage,
    _handler: RabbitMQMessageHandler,
  ): Promise<void> {}

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
