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

type Level = keyof ILogger
type ObjectFirst = (context: object, message: string) => void

/**
 * pino takes `(context, message)` and drops a context passed after the
 * message, and only serializes an Error under `err`. It is the one logger
 * with a `bindings()` method, so it is recognised by that and called its way.
 */
export const forLibraryCalls = (logger: ILogger): ILogger => {
  if (typeof (logger as { bindings?: unknown }).bindings !== 'function') return logger
  const call =
    (level: Level) =>
    (message: string, context?: unknown): void => {
      const log = (logger[level] as unknown as ObjectFirst).bind(logger)
      if (typeof context !== 'object' || context === null) return log({}, message)
      const { error, ...rest } = context as { error?: unknown }
      log(error === undefined ? rest : { ...rest, err: error }, message)
    }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
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
