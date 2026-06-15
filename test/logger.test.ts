import { describe, it, expect, vi, afterEach } from 'vitest'
import { defaultLogger, silentLogger } from '../src/logger.js'
import type { ILogger } from '../src/types.js'

describe('defaultLogger', () => {
  afterEach(() => vi.restoreAllMocks())

  it('writes warn and error to the console, prefixed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    defaultLogger.warn('something off', { a: 1 })
    defaultLogger.error('it failed', { b: 2 })

    expect(warn).toHaveBeenCalledWith('[rabbitmq-client]', 'something off', { a: 1 })
    expect(error).toHaveBeenCalledWith('[rabbitmq-client]', 'it failed', { b: 2 })
  })

  it('stays silent for info and debug', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

    defaultLogger.info('routine', { x: 1 })
    defaultLogger.debug('verbose', { y: 2 })

    expect(log).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
  })
})

describe('silentLogger', () => {
  afterEach(() => vi.restoreAllMocks())

  it('emits nothing on any level', () => {
    const spies = (['log', 'info', 'debug', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )

    silentLogger.debug('a')
    silentLogger.info('b')
    silentLogger.warn('c')
    silentLogger.error('d')

    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
  })
})

describe('ILogger compatibility', () => {
  it('console satisfies the contract', () => {
    // Type-level assertion: passes only because console matches ILogger.
    const logger: ILogger = console
    expect(typeof logger.error).toBe('function')
  })

  it('a message-first custom logger receives args in order', () => {
    const calls: unknown[][] = []
    const custom: ILogger = {
      debug: (...a) => calls.push(['debug', ...a]),
      info: (...a) => calls.push(['info', ...a]),
      warn: (...a) => calls.push(['warn', ...a]),
      error: (...a) => calls.push(['error', ...a]),
    }

    custom.error('Connection error', { error: 'boom' })

    expect(calls).toEqual([['error', 'Connection error', { error: 'boom' }]])
  })
})
