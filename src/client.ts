import amqp from 'amqplib'
import type {
  ILogger,
  PublishOptions,
  RabbitMQClientOptions,
  RabbitMQHooks,
  RabbitMQMessage,
  RabbitMQMessageHandler,
  RabbitMQMessageProperties,
  RabbitMQSubscription,
  SubscribeOptions,
} from './types.js'
import { defaultLogger, forLibraryCalls } from './logger.js'
import { Semaphore } from './semaphore.js'

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

function backoff(baseDelay: number, attempt: number, maxDelay: number): number {
  return Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay)
}

/** A `mandatory` publish the broker could route to no queue. */
export class UnroutableMessageError extends Error {
  constructor(
    readonly exchange: string,
    readonly routingKey: string,
  ) {
    super(`No queue is bound to receive ${exchange || '(default exchange)'}/${routingKey}`)
    this.name = 'UnroutableMessageError'
  }
}

/** Thrown by a handler to send its message to the DLQ at once, without retrying. */
export class DeadLetterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DeadLetterError'
  }
}

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
  private closing = false
  private subscriptions: RabbitMQSubscription[] = []
  private readonly options: Required<Omit<RabbitMQClientOptions, 'logger' | 'hooks'>>
  private readonly logger: ILogger
  private readonly hooks: RabbitMQHooks
  private initializationPromise: Promise<void> | null = null
  private reconnectionPromise: Promise<void> | null = null
  private assertedExchanges = new Set<string>()
  // One per channel, so a late return on a replaced channel reaches no waiter.
  private returnWaiters = new Set<(msg: amqp.Message) => void>()
  private consumerTags = new Map<string, string>()
  // Per-queue concurrency limiter, keyed by queue name. Persisted across
  // reconnects (unlike consumerTags) so handlers still running when a
  // connection drops keep holding their permits, and the new consumer cannot
  // exceed the ceiling while the old pipeline drains. `null` = no limit.
  private subscriptionSemaphores = new Map<string, Semaphore | null>()
  private retryWakers = new Set<() => void>()
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
      // Default concurrency tracks prefetch, preserving the previous behaviour
      // (handlers ran fire-and-forget, so up to `prefetch` ran at once) while
      // making the ceiling explicit and independently tunable. A value <= 0
      // (including an unlimited `prefetch: 0`) means "no concurrency limit".
      concurrency: options.concurrency ?? options.prefetch ?? DEFAULTS.prefetch,
      closeTimeout: options.closeTimeout ?? DEFAULTS.closeTimeout,
    }
    this.logger = forLibraryCalls(options.logger ?? defaultLogger)
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
    // A channel failure leaves its connection open; drop it so it does not
    // outlive the client and keep the process alive.
    this.connection?.close().catch(() => undefined)
    this.connection = null
    let attempts = 0
    while (!this.connected && !this.closing) {
      try {
        const connection = await amqp.connect(this.options.url)
        this.connection = connection
        this.logger.info('Connected to server')
        const channel = await connection.createConfirmChannel()
        this.channel = channel
        // Retries sleeping on the replaced channel give up; the broker redelivers their messages.
        this.wakeRetries()
        const returnWaiters = new Set<(msg: amqp.Message) => void>()
        this.returnWaiters = returnWaiters
        channel.on('return', (msg: amqp.Message) => {
          for (const waiter of returnWaiters) waiter(msg)
        })
        this.logger.info('Confirm channel created')
        await channel.prefetch(this.options.prefetch)
        this.logger.info('Channel prefetch set', { prefetch: this.options.prefetch })

        // Events from a connection or channel a reconnect has replaced must not
        // tear down the current one.
        connection.on('error', (error: Error) => {
          if (connection !== this.connection) return
          this.connected = false
          this.logger.error('Connection error', { error })
        })
        connection.on('close', () => {
          if (connection !== this.connection) return
          this.connected = false
          this.logger.warn('Connection closed')
          this.reconnectWithRetry()
        })
        channel.on('error', (error: Error) => {
          if (channel !== this.channel) return
          this.logger.error('Channel error', { error })
          this.handleChannelFailure()
        })
        channel.on('close', () => {
          if (channel !== this.channel) return
          this.logger.warn('Channel closed')
          this.handleChannelFailure()
        })

        this.connected = true
        this.logger.info('Client initialized successfully')
      } catch (error) {
        attempts++
        this.connected = false
        if (maxAttempts !== undefined && attempts >= maxAttempts) {
          this.logger.error('Connection failed after maximum attempts', { error, attempts, maxAttempts })
          throw new Error(
            `Failed to connect to RabbitMQ after ${attempts} attempts. ` +
              'Check RABBITMQ_URL configuration and RabbitMQ server availability.',
          )
        }
        this.logger.warn('Connection attempt failed, retrying...', {
          error,
          attempt: attempts,
          maxAttempts: maxAttempts ?? 'unlimited',
          retryDelayMs: this.options.connectionRetryDelay,
        })
        await this.sleep(this.options.connectionRetryDelay)
      }
    }
    if (!this.connected) {
      throw new Error('RabbitMQ client closed while connecting')
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
   * Publishes a JSON message to a topic exchange with publisher confirms, or
   * straight to a queue through the default exchange (`''`, routing key = queue name).
   * Retries with exponential backoff (capped at 60 s), forcing a reconnect
   * on each failure. Throws after `publishMaxAttempts` exhausted.
   */
  async publish(
    exchange: string,
    routingKey: string,
    message: RabbitMQMessage,
    options?: PublishOptions,
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = options?.maxAttempts ?? this.options.publishMaxAttempts
    const baseDelay = this.options.connectionRetryDelay
    const content = Buffer.from(JSON.stringify(message))
    // Taken once, not per attempt: a retried publish must not look newer than
    // a message published after it succeeded.
    const timestamp = Math.floor(Date.now() / 1000)

    while (attempts < maxAttempts) {
      try {
        if (!this.connected) {
          await this.reconnectWithRetry()
        }

        if (!this.channel) {
          throw new Error('Channel not available')
        }

        // The default exchange ('') always exists and the broker refuses to
        // declare it, so publishing straight to a queue skips the assertion.
        if (exchange !== '' && !this.assertedExchanges.has(exchange)) {
          await this.channel.assertExchange(exchange, 'topic', { durable: true })
          this.assertedExchanges.add(exchange)
        }

        const channel = this.channel
        const returnWaiters = this.returnWaiters
        // The broker sends basic.return before the confirm of the same message,
        // so the flag is settled by the time waitForConfirms resolves. A return
        // carries no delivery tag, so it is matched on where it was sent plus the
        // message id, or the content when there is none.
        let returned = false
        const messageId = options?.messageId
        const onReturn = (msg: amqp.Message) => {
          if (msg.fields.exchange !== exchange || msg.fields.routingKey !== routingKey) return
          if (messageId !== undefined ? msg.properties.messageId === messageId : msg.content.equals(content)) {
            returned = true
          }
        }
        if (options?.mandatory) returnWaiters.add(onReturn)

        try {
          channel.publish(exchange, routingKey, content, {
            persistent: true,
            timestamp,
            headers: options?.headers,
            correlationId: options?.correlationId,
            messageId: options?.messageId,
            expiration: options?.expiration,
            mandatory: options?.mandatory,
          })

          await channel.waitForConfirms()
        } finally {
          returnWaiters.delete(onReturn)
        }

        if (returned) {
          throw new UnroutableMessageError(exchange, routingKey)
        }

        if (attempts > 0) {
          this.logger.info('Published message after retries', { exchange, routingKey, messageSize: content.length, attempts })
        } else {
          this.logger.info('Published message', { exchange, routingKey, messageSize: content.length })
        }
        this.logger.debug('Published message payload', { exchange, routingKey, payload: message })

        this.callHook(this.hooks.onPublish, { exchange, routingKey, attempts: attempts + 1 })

        return
      } catch (error) {
        // The broker answered, and the same routing would fail the same way.
        if (error instanceof UnroutableMessageError) {
          this.logger.warn('Published message was unroutable', { exchange, routingKey })
          throw error
        }

        attempts++
        this.connected = false

        if (attempts >= maxAttempts) {
          this.logger.error('Publish failed after max attempts', { error, exchange, routingKey, attempts, maxAttempts })
          throw new Error(
            `Failed to publish to ${exchange || '(default exchange)'}/${routingKey} after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`,
          )
        }

        const retryDelay = backoff(baseDelay, attempts, MAX_PUBLISH_RETRY_DELAY_MS)

        this.logger.warn('Publish attempt failed, retrying', { error, exchange, routingKey, attempt: attempts, maxAttempts, retryDelayMs: retryDelay })

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
    // Closing the channel fires its 'close' handler, which would otherwise
    // reconnect and leave a connection behind that keeps the process alive.
    this.closing = true
    try {
      // A connect already running gives up after its current attempt; whatever
      // it opened is closed below.
      await Promise.allSettled([this.initializationPromise, this.reconnectionPromise])
      this.wakeRetries()
      if (this.inflightCount > 0) {
        this.logger.info('Waiting for in-flight messages to drain', { inflightCount: this.inflightCount })
        await this.waitForDrain(this.options.closeTimeout)
      }
      try {
        await this.channel?.close()
      } finally {
        await this.connection?.close()
      }
      this.connection = null
      this.channel = null
      this.connected = false
      this.initializationPromise = null
      this.reconnectionPromise = null
      this.assertedExchanges.clear()
      this.consumerTags.clear()
      if (clearSubscriptions) {
        this.subscriptions = []
        this.subscriptionSemaphores.clear()
      }
      this.logger.info('Connection closed')
    } catch (error) {
      this.logger.error('Error closing connection', { error })
      throw error
    } finally {
      this.closing = false
    }
  }

  private async reconnectWithRetry(): Promise<void> {
    if (this.closing) return
    if (this.reconnectionPromise) {
      return this.reconnectionPromise
    }
    this.connected = false
    this.logger.info('Starting reconnection...')
    this.reconnectionPromise = this.doReconnect()
    this.reconnectionPromise.catch(() => undefined)
    try {
      await this.reconnectionPromise
    } catch (error) {
      // The event handlers call this without awaiting it, so a reconnect that
      // close() interrupted must not surface as an unhandled rejection.
      if (!this.closing) throw error
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
    this.logger.info('Re-establishing subscriptions', { count: this.subscriptions.length })
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
        this.logger.error('Failed to re-subscribe to queue', { error: result.reason, queue })
      }
    })
    if (succeeded.length > 0) {
      this.logger.info('Successfully re-subscribed to queues', { count: succeeded.length, queues: succeeded })
    }
    if (failed.length > 0) {
      this.logger.warn('Some subscriptions failed to restore', { count: failed.length, queues: failed })
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
    const previous = existingIndex === -1 ? undefined : this.subscriptions[existingIndex]
    if (existingIndex === -1) {
      this.subscriptions.push(sub)
    } else {
      this.subscriptions[existingIndex] = sub
      // Re-subscribing may change concurrency; drop the old limiter so
      // setupSubscription rebuilds it from the new options. (A reconnect goes
      // through setupSubscription directly and keeps the existing limiter.)
      this.subscriptionSemaphores.delete(queue)
    }
    try {
      await this.setupSubscription(sub)
    } catch (error) {
      // A subscription that cannot be set up must not be retried on every reconnect.
      this.subscriptions = previous
        ? this.subscriptions.map((s) => (s === sub ? previous : s))
        : this.subscriptions.filter((s) => s !== sub)
      throw error
    }
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
    this.subscriptionSemaphores.delete(queue)
    this.subscriptions = this.subscriptions.filter((s) => s.queue !== queue)
    this.logger.info('Unsubscribed from queue', { queue })
  }

  private async setupSubscription(sub: RabbitMQSubscription): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not available')
    }
    // Bind this consumer to the exact channel that will deliver its messages,
    // so ack/nack always target that channel even after a reconnect swaps
    // `this.channel`.
    const channel = this.channel
    const { exchange, routingKey, queue, handler, options } = sub
    const dlxExchange = options?.deadLetterExchange ?? `${exchange}.dlx`
    const dlqQueue = `${queue}.dlq`
    // Set once on the queue, so every binding's dead letters reach the DLQ.
    const dlqRoutingKey = `${routingKey}.dead`
    const bindings = [{ exchange, routingKey }, ...(options?.bindings ?? [])]

    await channel.assertExchange(dlxExchange, 'topic', { durable: true })
    await channel.assertQueue(dlqQueue, { durable: true })
    await channel.bindQueue(dlqQueue, dlxExchange, dlqRoutingKey)

    const passive = options?.passiveExchanges
    const isPassive = (name: string) => passive === true || (Array.isArray(passive) && passive.includes(name))
    const missing = [...new Set(bindings.map((b) => b.exchange))].filter((name) => !this.assertedExchanges.has(name))
    const toCheck = missing.filter(isPassive)
    if (toCheck.length > 0) {
      await this.checkExchanges(toCheck)
    }
    for (const name of missing.filter((name) => !isPassive(name))) {
      await channel.assertExchange(name, 'topic', { durable: true })
    }
    for (const name of missing) this.assertedExchanges.add(name)

    const queueType = options?.queueArguments?.['x-queue-type'] ?? 'quorum'
    const queueArgs: Record<string, unknown> = {
      'x-queue-type': queueType,
      'x-overflow': 'reject-publish',
    }
    // at-least-once DLQ strategy is only supported by quorum queues
    if (queueType === 'quorum') {
      queueArgs['x-dead-letter-strategy'] = 'at-least-once'
    }

    await channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: dlxExchange,
      deadLetterRoutingKey: dlqRoutingKey,
      arguments: { ...queueArgs, ...options?.queueArguments },
    })

    for (const binding of bindings) {
      await channel.bindQueue(queue, binding.exchange, binding.routingKey)
    }
    // Reuse the queue's existing limiter across reconnects; only build a new
    // one the first time (or after subscribe()/unsubscribe() cleared it).
    // A concurrency <= 0 means "no limit" (null), matching an unlimited prefetch.
    if (!this.subscriptionSemaphores.has(queue)) {
      const concurrency = options?.concurrency ?? this.options.concurrency
      this.subscriptionSemaphores.set(queue, concurrency > 0 ? new Semaphore(concurrency) : null)
    }
    const semaphore = this.subscriptionSemaphores.get(queue) ?? null
    const { consumerTag } = await channel.consume(
      queue,
      (message) => {
        if (message) {
          this.dispatch(message, handler, semaphore, channel, options)
        }
      },
      { noAck: false },
    )
    this.consumerTags.set(queue, consumerTag)
    this.logger.info('Subscribed to queue', { queue, bindings })
  }

  // A failed check closes the channel it ran on, so it runs on a throwaway one
  // rather than take down the shared channel and every consumer on it.
  private async checkExchanges(exchanges: string[]): Promise<void> {
    if (!this.connection) {
      throw new Error('Connection not available')
    }
    const probe = await this.connection.createChannel()
    probe.on('error', () => undefined)
    try {
      for (const name of exchanges) {
        await probe.checkExchange(name)
      }
    } finally {
      await probe.close().catch(() => undefined)
    }
  }

  /**
   * Gates a delivered message on the subscription's concurrency semaphore, then
   * processes it. A message counts as in-flight from delivery until its handler
   * settles (including time spent waiting for a permit), so graceful `close()`
   * drains queued messages as well as actively-processing ones.
   */
  private dispatch(
    message: amqp.ConsumeMessage,
    handler: RabbitMQMessageHandler,
    semaphore: Semaphore | null,
    channel: amqp.ConfirmChannel,
    options: SubscribeOptions | undefined,
  ): void {
    this.inflightCount++
    const acquire = semaphore ? semaphore.acquire() : Promise.resolve()
    acquire
      .then(() => this.handleWithRetry(message, handler, channel, options))
      .catch((error) => {
        this.logger.error('Unhandled error in message handler', { error })
      })
      .finally(() => {
        semaphore?.release()
        this.inflightCount--
        if (this.inflightCount === 0 && this.drainResolve) {
          this.drainResolve()
        }
      })
  }

  private async handleWithRetry(
    message: amqp.ConsumeMessage,
    handler: RabbitMQMessageHandler,
    channel: amqp.ConfirmChannel,
    options: SubscribeOptions | undefined,
  ): Promise<void> {
    // `channel` is the one that delivered this message. If a reconnect has
    // since replaced it, this message was never acked and the broker will
    // redeliver it on the new channel, so drop this stale attempt rather than
    // run the handler again or ack a tag the new channel does not know.
    if (channel !== this.channel) {
      this.logger.warn('Skipping message from a superseded channel; it will be redelivered')
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
      const rawContent = message.content.toString()
      const rawPreview = rawContent.substring(0, 100)
      this.logger.error('Failed to parse message JSON, sending to DLQ', {
        error: parseError,
        exchange,
        routingKey,
        rawContentPreview: rawPreview + (rawContent.length > 100 ? '...' : ''),
      })
      if (this.settle(channel, message, 'nack')) {
        this.callHook(this.hooks.onMessageDlq, { exchange, routingKey, duration: 0, reason: 'invalid_json' })
      }
      return
    }

    this.logger.debug('Message received, processing', { exchange, routingKey, payload: content })

    const properties: RabbitMQMessageProperties = {
      exchange,
      routingKey,
      headers: message.properties.headers ?? {},
      timestamp: message.properties.timestamp,
      messageId: message.properties.messageId,
      correlationId: message.properties.correlationId,
    }

    const maxRetries = options?.maxRetries ?? this.options.maxRetries
    while (attempts < maxRetries) {
      // Only the handler call belongs in this try. Acking inside it would make
      // a dead channel look like a failed handler and re-run its side effects.
      try {
        await handler(content, properties)
      } catch (error) {
        attempts++
        // By name, not instanceof: the ESM and CJS builds each define their own class.
        if (error instanceof Error && error.name === 'DeadLetterError') {
          const duration = Date.now() - startTime
          this.logger.warn('Handler dead-lettered the message', { error: error.message, exchange, routingKey })
          if (this.settle(channel, message, 'nack')) {
            this.callHook(this.hooks.onMessageDlq, { exchange, routingKey, duration, reason: 'dead_letter_error' })
          }
          return
        }
        this.logger.error('Handler failed', {
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined,
          exchange,
          routingKey,
          attempt: attempts,
          maxRetries,
        })
        if (attempts < maxRetries) {
          await this.sleepUntilClose(this.retryDelayFor(attempts, options))
          if (this.closing || channel !== this.channel) {
            this.logger.warn('Stopped retrying a message on close or reconnect; it will be redelivered', { exchange, routingKey })
            return
          }
        }
        continue
      }
      const duration = Date.now() - startTime
      this.logger.info('Message processed successfully', { exchange, routingKey, duration, attempts: attempts + 1 })
      if (this.settle(channel, message, 'ack')) {
        this.callHook(this.hooks.onMessageProcessed, { exchange, routingKey, duration, attempts: attempts + 1 })
      }
      return
    }

    const duration = Date.now() - startTime
    this.logger.error('Message failed after max retries, sending to DLQ', { exchange, routingKey, maxRetries, duration })
    if (this.settle(channel, message, 'nack')) {
      this.callHook(this.hooks.onMessageDlq, { exchange, routingKey, duration, reason: 'max_retries_exhausted' })
    }
  }

  /**
   * Acks or nacks a delivery, reporting whether the broker accepted it.
   *
   * A settle failure is a transport error, never a handler failure: by this
   * point the handler has already run, so it must not be retried just because
   * the channel went away. The delivery stays unacked and the broker redelivers
   * it once the channel closes.
   */
  private settle(
    channel: amqp.ConfirmChannel,
    message: amqp.ConsumeMessage,
    action: 'ack' | 'nack',
  ): boolean {
    // A handler can run for minutes, so the channel that delivered this
    // message may have been replaced by a reconnect since the entry check.
    // Settling on it would throw, and replaying the delivery tag on the
    // current channel would settle an unrelated message, since tags are scoped
    // to the channel that issued them. The broker requeues a closed channel's
    // unacked deliveries, so let it be redelivered instead.
    if (channel !== this.channel) {
      this.logger.warn('Skipping message from a superseded channel; it will be redelivered')
      return false
    }
    try {
      if (action === 'ack') {
        channel.ack(message)
      } else {
        channel.nack(message, false, false)
      }
      return true
    } catch (error) {
      this.logger.error('Failed to settle message; leaving it unacked for redelivery', {
        error,
        action,
        exchange: message.fields.exchange,
        routingKey: message.fields.routingKey,
      })
      return false
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
      this.logger.warn('Health check failed', { error })
      return false
    }
  }

  private waitForDrain(timeout: number): Promise<void> {
    if (this.inflightCount === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn('Close timeout reached with messages still in flight', { inflightCount: this.inflightCount })
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
    try { hook?.(info) } catch (error) { this.logger.debug('Observability hook error', { error }) }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private retryDelayFor(attempts: number, options: SubscribeOptions | undefined): number {
    const { retryDelay } = this.options
    if (options?.maxRetryDelay === undefined) return retryDelay
    return backoff(retryDelay, attempts, options.maxRetryDelay)
  }

  private wakeRetries(): void {
    for (const wake of [...this.retryWakers]) wake()
  }

  /** Also cut short by a reconnect, via wakeRetries(). */
  private sleepUntilClose(ms: number): Promise<void> {
    if (this.closing) return Promise.resolve()
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.retryWakers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.retryWakers.add(wake)
    })
  }
}
