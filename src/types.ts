/**
 * The bare minimum logging contract required by this library.
 *
 * You do not need to wrap your application's logger; you can pass instances
 * from Winston, Pino, Bunyan, or even the native `console` object directly.
 * Any additional methods on your provided logger will simply be ignored as
 * they are unused here.
 */
export interface ILogger {
  /** Optional. Detailed diagnostic information. */
  trace?(message: any, ...args: any[]): void;
  /** Actionable insight for developers diagnosing issues. */
  debug(message: any, ...args: any[]): void;
  /** Routine informational messages about library operations. */
  info(message: any, ...args: any[]): void;
  /** Optional. Unused here. Unformatted informational messages. */
  log?(message: any, ...args: any[]): void;
  /** Warnings about non-fatal issues or deprecated usage. */
  warn(message: any, ...args: any[]): void;
  /** Errors indicating an operation failed. */
  error(message: any, ...args: any[]): void;
  /** Optional. Critical errors requiring immediate application shutdown. */
  fatal?(message: any, ...args: any[]): void;
}

/**
 * Hooks for observability — optional callbacks invoked on key client events.
 * Use these to wire metrics, tracing, or custom logging.
 */
export interface RabbitMQHooks {
  /** Called after the broker confirms a published message */
  onPublish?: (info: { exchange: string; routingKey: string; attempts: number }) => void
  /** Called after a message handler returns successfully (duration includes retries) */
  onMessageProcessed?: (info: { exchange: string; routingKey: string; duration: number; attempts: number }) => void
  /** Called when a message is nacked to the dead-letter queue */
  onMessageDlq?: (info: { exchange: string; routingKey: string; duration: number; reason: 'invalid_json' | 'max_retries_exhausted' }) => void
  /** Called after reconnection completes and subscriptions are re-established */
  onReconnect?: (info: { subscriptionsRestored: number; subscriptionsFailed: number }) => void
}

/**
 * Options for queue subscription.
 */
export interface SubscribeOptions {
  /** Override default AMQP queue arguments (merged with DLQ wiring defaults) */
  queueArguments?: Record<string, unknown>
}

/**
 * Configuration options for the RabbitMQ client.
 */
export interface RabbitMQClientOptions {
  /** AMQP connection URL (e.g., 'amqp://user:pass@host:5672') */
  url: string
  /** Max handler retries before sending to DLQ (default: 3) */
  maxRetries?: number
  /** Delay in ms between handler retries (default: 1000) */
  retryDelay?: number
  /** Delay in ms between reconnection attempts (default: 5000) */
  connectionRetryDelay?: number
  /** Max connection attempts during init; undefined = unlimited (default: 5) */
  initMaxAttempts?: number
  /** Max publish attempts with exponential backoff (default: 5) */
  publishMaxAttempts?: number
  /** Channel prefetch count (default: 10) */
  prefetch?: number
  /** An already configure logger object complying with ILogger generic contract */
  logger?: ILogger
  /** Timeout in ms to wait for in-flight messages during close (default: 5000) */
  closeTimeout?: number
  /** Observability hooks for metrics and monitoring */
  hooks?: RabbitMQHooks
}

/**
 * Options for the `publish()` method.
 */
export interface PublishOptions {
  /** Max publish attempts with backoff (overrides client default) */
  maxAttempts?: number
  /** Custom message headers for tracing and metadata */
  headers?: Record<string, unknown>
  /** Correlation ID for request-reply patterns */
  correlationId?: string
  /** Unique message identifier */
  messageId?: string
  /** Per-message TTL in milliseconds (as string per AMQP spec) */
  expiration?: string
}

/** JSON-serializable message payload */
export type RabbitMQMessage = Record<string, unknown>

/** Async handler function for consumed messages */
export type RabbitMQMessageHandler = (message: RabbitMQMessage) => Promise<void>

/** Stored subscription metadata for restoration after reconnection */
export interface RabbitMQSubscription {
  exchange: string
  routingKey: string
  queue: string
  handler: RabbitMQMessageHandler
  options?: SubscribeOptions
}
