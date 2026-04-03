import type { Logger } from 'pino'

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
}
