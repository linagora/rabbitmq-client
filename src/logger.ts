import {type ILogger} from './types'

/**
 * A No-Op (Silent) implementation of the ILogger interface.
 *
 * Used as the default fallback when the consuming application does not
 * inject its own logger. This ensures the library can call `this.logger.info()`
 * internally without needing `if (this.logger)` null-checks everywhere, while
 * keeping the standard output perfectly clean by default.
 */
export const silentLogger: ILogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  log: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};
