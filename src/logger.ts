import pino, { type Logger } from 'pino'

/**
 * Creates a child pino logger for the RabbitMQ client.
 *
 * If a parent logger is provided, the child inherits its configuration
 * (level, transports, etc.) for unified log output. Otherwise, a new
 * root logger is created.
 */
export const createLogger = (parent?: Logger): Logger => {
  if (parent) {
    return parent.child({ service: 'rabbitmq-client' })
  }
  return pino({ name: 'rabbitmq-client' })
}
