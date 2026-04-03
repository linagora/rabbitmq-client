import type { Logger } from 'pino'

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
  /** Parent pino logger instance; library creates its own if omitted */
  logger?: Logger
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
