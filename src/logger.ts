import type { ILogger } from './types.js'

/**
 * Default logger used when the consumer does not inject one.
 *
 * Forwards `warn` and `error` to the console so connection drops, channel
 * errors, and failed handlers stay visible out of the box, while staying
 * silent for `info`/`debug` so routine operation never pollutes the
 * consumer's output. Pass `silentLogger` for zero output, or any `ILogger`
 * (console, Winston, pino, Bunyan) to take full control.
 */
export const defaultLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: (message, ...args) => console.warn('[rabbitmq-client]', message, ...args),
  error: (message, ...args) => console.error('[rabbitmq-client]', message, ...args),
}

/**
 * No-op logger that discards every message. Use this to silence the client
 * entirely, including the `warn`/`error` output the default logger emits.
 */
export const silentLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
