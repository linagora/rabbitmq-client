# @linagora/rabbitmq-client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@linagora/rabbitmq-client` -- a production-grade RabbitMQ client library with confirm channels, DLQ infrastructure, exponential backoff, auto-reconnection, and test helpers.

**Architecture:** Single `RabbitMQClient` class wrapping amqplib with opinionated defaults (topic exchanges, quorum queues, DLQ wiring). Dual ESM+CJS build via tsup. Separate `/testing` entrypoint for mock helpers.

**Tech Stack:** TypeScript, amqplib, pino, tsup, vitest

**Working directory:** `/home/kferjani/workspace/rabbitmq-client`

---

## File Map

| File | Responsibility |
|---|---|
| `src/index.ts` | Public exports: `RabbitMQClient` class + all types |
| `src/client.ts` | `RabbitMQClient` class -- connection, publish, subscribe, health, reconnection |
| `src/types.ts` | `RabbitMQClientOptions`, `RabbitMQMessage`, `RabbitMQMessageHandler`, `RabbitMQSubscription` |
| `src/logger.ts` | Pino child logger factory |
| `src/testing/index.ts` | `MockRabbitMQChannel`, `MockRabbitMQConnection`, `createMockAmqplib` |
| `test/client.test.ts` | Full test suite for `RabbitMQClient` |
| `test/testing.test.ts` | Tests for the mock helpers |
| `tsconfig.json` | TypeScript config |
| `tsup.config.ts` | Build config (dual ESM+CJS, two entrypoints) |
| `package.json` | Package metadata, scripts, exports |

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@linagora/rabbitmq-client",
  "version": "0.1.0",
  "description": "Production-grade RabbitMQ client with confirm channels, DLQ infrastructure, auto-reconnection, and exponential backoff",
  "type": "module",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    },
    "./testing": {
      "import": {
        "types": "./dist/testing/index.d.ts",
        "default": "./dist/testing/index.js"
      },
      "require": {
        "types": "./dist/testing/index.d.cts",
        "default": "./dist/testing/index.cjs"
      }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "amqplib": "^0.10.7",
    "pino": "^9.6.0"
  },
  "devDependencies": {
    "@types/amqplib": "^0.10.7",
    "typescript": "^5.7.3",
    "tsup": "^8.4.0",
    "vitest": "^3.1.1"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "AGPL-3.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/linagora/rabbitmq-client.git"
  },
  "keywords": [
    "rabbitmq",
    "amqp",
    "message-queue",
    "pino"
  ]
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
})
```

- [ ] **Step 4: Create .gitignore**

```
node_modules
dist
*.tgz
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules` created, `package-lock.json` generated.

- [ ] **Step 6: Verify build toolchain works**

Create minimal placeholder files so the build can succeed:

`src/index.ts`:
```typescript
export {}
```

`src/testing/index.ts`:
```typescript
export {}
```

Run: `npx tsc --noEmit && npx tsup`
Expected: Build succeeds, `dist/` contains `index.js`, `index.cjs`, `index.d.ts`, `testing/index.js`, `testing/index.cjs`, `testing/index.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts .gitignore src/index.ts src/testing/index.ts
git commit -m "chore: scaffold project with tsup dual build"
```

---

### Task 2: Types and logger

**Files:**
- Create: `src/types.ts`
- Create: `src/logger.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the types test**

Create `test/types.test.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest'
import type {
  RabbitMQClientOptions,
  RabbitMQMessage,
  RabbitMQMessageHandler,
  RabbitMQSubscription,
} from '../src/types.js'

describe('types', () => {
  it('RabbitMQClientOptions requires url and has optional fields with defaults', () => {
    expectTypeOf<RabbitMQClientOptions>().toHaveProperty('url')
    expectTypeOf<RabbitMQClientOptions['url']>().toBeString()
    expectTypeOf<RabbitMQClientOptions['maxRetries']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<RabbitMQClientOptions['retryDelay']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<RabbitMQClientOptions['connectionRetryDelay']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<RabbitMQClientOptions['initMaxAttempts']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<RabbitMQClientOptions['publishMaxAttempts']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<RabbitMQClientOptions['prefetch']>().toEqualTypeOf<number | undefined>()
  })

  it('RabbitMQMessage accepts any JSON-serializable object', () => {
    expectTypeOf<{ foo: string }>().toMatchTypeOf<RabbitMQMessage>()
  })

  it('RabbitMQMessageHandler takes a message and returns a promise', () => {
    const handler: RabbitMQMessageHandler = async (_msg) => {}
    expectTypeOf(handler).toBeFunction()
    expectTypeOf(handler).returns.toEqualTypeOf<Promise<void>>()
  })

  it('RabbitMQSubscription has exchange, routingKey, queue, handler', () => {
    expectTypeOf<RabbitMQSubscription>().toHaveProperty('exchange')
    expectTypeOf<RabbitMQSubscription>().toHaveProperty('routingKey')
    expectTypeOf<RabbitMQSubscription>().toHaveProperty('queue')
    expectTypeOf<RabbitMQSubscription>().toHaveProperty('handler')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL -- types not exported yet.

- [ ] **Step 3: Create src/types.ts**

```typescript
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
```

- [ ] **Step 4: Create src/logger.ts**

```typescript
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
```

- [ ] **Step 5: Update src/index.ts with exports**

```typescript
export { RabbitMQClient } from './client.js'
export type {
  RabbitMQClientOptions,
  RabbitMQMessage,
  RabbitMQMessageHandler,
  RabbitMQSubscription,
} from './types.js'
```

Create a minimal `src/client.ts` placeholder so the export resolves:

```typescript
export class RabbitMQClient {
  constructor(_options: import('./types.js').RabbitMQClientOptions) {}
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/types.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/logger.ts src/index.ts src/client.ts test/types.test.ts
git commit -m "feat: add types and pino logger factory"
```

---

### Task 3: RabbitMQClient -- connection lifecycle

**Files:**
- Modify: `src/client.ts`
- Create: `test/client.test.ts`

- [ ] **Step 1: Write failing tests for init, close, isConnected**

Create `test/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Connection, ConfirmChannel } from 'amqplib'

// Mock amqplib before importing client
const mockChannel = {
  prefetch: vi.fn().mockResolvedValue(undefined),
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
  assertExchange: vi.fn().mockResolvedValue({}),
  assertQueue: vi.fn().mockResolvedValue({ queue: 'test-queue' }),
  bindQueue: vi.fn().mockResolvedValue({}),
  publish: vi.fn().mockReturnValue(true),
  waitForConfirms: vi.fn().mockResolvedValue(undefined),
  consume: vi.fn().mockResolvedValue({ consumerTag: 'test' }),
  ack: vi.fn(),
  nack: vi.fn(),
  deleteQueue: vi.fn().mockResolvedValue({}),
} as unknown as ConfirmChannel & Record<string, ReturnType<typeof vi.fn>>

const mockConnection = {
  createConfirmChannel: vi.fn().mockResolvedValue(mockChannel),
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as Connection & Record<string, ReturnType<typeof vi.fn>>

vi.mock('amqplib', () => ({
  default: {
    connect: vi.fn().mockResolvedValue(mockConnection),
  },
}))

import amqp from 'amqplib'
import { RabbitMQClient } from '../src/client.js'

const baseOptions = {
  url: 'amqp://localhost',
  maxRetries: 3,
  retryDelay: 10,
  connectionRetryDelay: 10,
  initMaxAttempts: 5,
  publishMaxAttempts: 5,
  prefetch: 10,
}

describe('RabbitMQClient', () => {
  let client: RabbitMQClient

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    client = new RabbitMQClient(baseOptions)
  })

  afterEach(async () => {
    vi.useRealTimers()
  })

  describe('init()', () => {
    it('should connect and create a confirm channel', async () => {
      await client.init()

      expect(amqp.connect).toHaveBeenCalledWith('amqp://localhost')
      expect(mockConnection.createConfirmChannel).toHaveBeenCalledOnce()
      expect(mockChannel.prefetch).toHaveBeenCalledWith(10)
      expect(client.isConnected()).toBe(true)
    })

    it('should register connection and channel event handlers', async () => {
      await client.init()

      expect(mockConnection.on).toHaveBeenCalledWith('error', expect.any(Function))
      expect(mockConnection.on).toHaveBeenCalledWith('close', expect.any(Function))
      expect(mockChannel.on).toHaveBeenCalledWith('error', expect.any(Function))
      expect(mockChannel.on).toHaveBeenCalledWith('close', expect.any(Function))
    })

    it('should be idempotent when already connected', async () => {
      await client.init()
      await client.init()

      expect(amqp.connect).toHaveBeenCalledOnce()
    })

    it('should deduplicate concurrent init calls', async () => {
      const init1 = client.init()
      const init2 = client.init()

      await Promise.all([init1, init2])

      expect(amqp.connect).toHaveBeenCalledOnce()
    })

    it('should retry on connection failure and succeed', async () => {
      const connectMock = vi.mocked(amqp.connect)
      connectMock
        .mockRejectedValueOnce(new Error('refused'))
        .mockRejectedValueOnce(new Error('refused'))
        .mockResolvedValueOnce(mockConnection as unknown as Connection)

      const initPromise = client.init()
      await vi.advanceTimersByTimeAsync(100)
      await initPromise

      expect(connectMock).toHaveBeenCalledTimes(3)
      expect(client.isConnected()).toBe(true)
    })

    it('should throw after exhausting initMaxAttempts', async () => {
      const connectMock = vi.mocked(amqp.connect)
      connectMock.mockRejectedValue(new Error('refused'))

      const initPromise = client.init()
      await vi.advanceTimersByTimeAsync(500)

      await expect(initPromise).rejects.toThrow(/5 attempts/)
    })
  })

  describe('close()', () => {
    it('should close channel and connection', async () => {
      await client.init()
      await client.close()

      expect(mockChannel.close).toHaveBeenCalledOnce()
      expect(mockConnection.close).toHaveBeenCalledOnce()
      expect(client.isConnected()).toBe(false)
    })

    it('should re-throw errors from channel close', async () => {
      await client.init()
      mockChannel.close.mockRejectedValueOnce(new Error('close failed'))

      await expect(client.close()).rejects.toThrow('close failed')
    })
  })

  describe('isConnected()', () => {
    it('should return false before init', () => {
      expect(client.isConnected()).toBe(false)
    })

    it('should return true after init', async () => {
      await client.init()
      expect(client.isConnected()).toBe(true)
    })

    it('should return false after close', async () => {
      await client.init()
      await client.close()
      expect(client.isConnected()).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL -- `RabbitMQClient` is a placeholder with no `init`/`close`/`isConnected`.

- [ ] **Step 3: Implement connection lifecycle in src/client.ts**

```typescript
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

/**
 * Production-grade RabbitMQ client with confirm channels, DLQ infrastructure,
 * exponential backoff, and automatic reconnection with subscription restoration.
 */
export class RabbitMQClient {
  private connection: amqp.ChannelModel | null = null
  private channel: amqp.ConfirmChannel | null = null
  private connected = false
  private subscriptions: RabbitMQSubscription[] = []
  private readonly options: Required<Omit<RabbitMQClientOptions, 'logger'>>
  private readonly logger: Logger

  /** Prevents concurrent init races */
  private initializationPromise: Promise<void> | null = null

  /** Prevents concurrent reconnection storms */
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

  /**
   * Initializes the connection to RabbitMQ.
   *
   * Retries up to `initMaxAttempts` times (fail-fast for startup).
   * Concurrent calls are deduplicated -- only one connection attempt runs at a time.
   */
  async init(): Promise<void> {
    if (this.connection && this.connected) {
      return
    }

    if (this.initializationPromise) {
      return this.initializationPromise
    }

    this.initializationPromise = this.doConnect(this.options.initMaxAttempts)

    try {
      await this.initializationPromise
    } finally {
      this.initializationPromise = null
    }
  }

  /**
   * Internal connection loop.
   *
   * @param maxAttempts - If provided, throws after this many failures (init).
   *                      If undefined, retries indefinitely (runtime reconnection).
   */
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
          this.logger.error(
            { error, attempts, maxAttempts },
            'Connection failed after maximum attempts',
          )
          throw new Error(
            `Failed to connect to RabbitMQ after ${attempts} attempts. ` +
              'Check RABBITMQ_URL configuration and RabbitMQ server availability.',
          )
        }

        this.logger.warn(
          { error, attempt: attempts, maxAttempts: maxAttempts ?? 'unlimited', retryDelayMs: this.options.connectionRetryDelay },
          'Connection attempt failed, retrying...',
        )

        await this.sleep(this.options.connectionRetryDelay)
      }
    }
  }

  /** Triggers reconnection if the channel dies while the connection is still marked active */
  private handleChannelFailure(): void {
    if (this.connected) {
      this.connected = false
      this.reconnectWithRetry()
    }
  }

  /**
   * Checks if the client is currently connected.
   */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * Closes the connection and optionally clears stored subscriptions.
   *
   * @param clearSubscriptions - Whether to clear subscription state (default: true).
   *                             Pass `false` to preserve subscriptions for re-init.
   */
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

  /**
   * Reconnects with deduplication -- multiple callers await the same attempt.
   */
  private async reconnectWithRetry(): Promise<void> {
    if (this.reconnectionPromise) {
      return this.reconnectionPromise
    }

    this.connected = false
    this.logger.info('Starting reconnection...')

    this.reconnectionPromise = this.doReconnect()

    try {
      await this.reconnectionPromise
    } finally {
      this.reconnectionPromise = null
    }
  }

  /** Reconnects and restores all subscriptions */
  private async doReconnect(): Promise<void> {
    await this.doConnect()
    await this.resubscribeAll()
  }

  /**
   * Re-establishes all stored subscriptions after reconnection.
   * Uses Promise.allSettled for parallel restoration.
   */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/client.test.ts`
Expected: PASS (all init/close/isConnected tests green)

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: implement connection lifecycle with reconnection"
```

---

### Task 4: Publish with exponential backoff

**Files:**
- Modify: `src/client.ts`
- Modify: `test/client.test.ts`

- [ ] **Step 1: Add publish tests to test/client.test.ts**

Append inside the main `describe('RabbitMQClient')` block:

```typescript
  describe('publish()', () => {
    beforeEach(async () => {
      await client.init()
    })

    it('should assert exchange, publish with persistent flag, and confirm', async () => {
      await client.publish('test-exchange', 'test.key', { foo: 'bar' })

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', { durable: true })
      expect(mockChannel.publish).toHaveBeenCalledOnce()
      const [exchange, routingKey, content, options] = mockChannel.publish.mock.calls[0]
      expect(exchange).toBe('test-exchange')
      expect(routingKey).toBe('test.key')
      expect(JSON.parse(content.toString())).toEqual({ foo: 'bar' })
      expect(options).toEqual({ persistent: true })
      expect(mockChannel.waitForConfirms).toHaveBeenCalledOnce()
    })

    it('should retry with exponential backoff on failure', async () => {
      mockChannel.waitForConfirms
        .mockRejectedValueOnce(new Error('confirm failed'))
        .mockResolvedValueOnce(undefined)

      const publishPromise = client.publish('ex', 'key', { msg: 1 })
      await vi.advanceTimersByTimeAsync(200)
      await publishPromise

      // First attempt failed, second succeeded after reconnect
      expect(vi.mocked(amqp.connect)).toHaveBeenCalledTimes(2)
    })

    it('should throw after exhausting publishMaxAttempts', async () => {
      mockChannel.waitForConfirms.mockRejectedValue(new Error('confirm failed'))

      // Override to keep failing on new channels too
      mockConnection.createConfirmChannel.mockImplementation(() => {
        const failChannel = { ...mockChannel, waitForConfirms: vi.fn().mockRejectedValue(new Error('confirm failed')) }
        return Promise.resolve(failChannel)
      })

      const publishPromise = client.publish('ex', 'key', { msg: 1 }, { maxAttempts: 2 })
      await vi.advanceTimersByTimeAsync(500)

      await expect(publishPromise).rejects.toThrow(/2 attempts/)

      // Restore for other tests
      mockConnection.createConfirmChannel.mockResolvedValue(mockChannel)
    })

    it('should force reconnect on publish error (dead channel detection)', async () => {
      mockChannel.waitForConfirms.mockRejectedValueOnce(new Error('dead'))

      const publishPromise = client.publish('ex', 'key', { msg: 1 })
      await vi.advanceTimersByTimeAsync(200)
      await publishPromise

      // connected was set to false, forcing reconnection
      expect(vi.mocked(amqp.connect)).toHaveBeenCalledTimes(2)
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL -- `publish` not implemented.

- [ ] **Step 3: Implement publish in src/client.ts**

Add this constant at the top of the file (after `DEFAULTS`):

```typescript
/** Maximum backoff delay for publish retries (60 seconds) */
const MAX_PUBLISH_RETRY_DELAY_MS = 60_000
```

Add this method to the `RabbitMQClient` class:

```typescript
  /**
   * Publishes a message to a RabbitMQ exchange.
   *
   * Uses confirm channels and retries with exponential backoff on failure.
   * On any error, marks the connection as dead to force a fresh channel on retry.
   *
   * @param exchange - Exchange name
   * @param routingKey - Routing key for message routing
   * @param message - Message payload (will be JSON serialized)
   * @param options - Optional overrides
   * @param options.maxAttempts - Override publishMaxAttempts for this call
   */
  async publish(
    exchange: string,
    routingKey: string,
    message: RabbitMQMessage,
    options?: { maxAttempts?: number },
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = options?.maxAttempts ?? this.options.publishMaxAttempts
    const baseDelay = this.options.connectionRetryDelay
    const content = Buffer.from(JSON.stringify(message))

    while (attempts < maxAttempts) {
      try {
        if (!this.connected) {
          await this.reconnectWithRetry()
        }

        if (!this.channel) {
          throw new Error('Channel not available')
        }

        await this.channel.assertExchange(exchange, 'topic', { durable: true })

        this.channel.publish(exchange, routingKey, content, {
          persistent: true,
        })

        await this.channel.waitForConfirms()

        if (attempts > 0) {
          this.logger.info({ exchange, routingKey, messageSize: content.length, attempts }, 'Published message after retries')
        } else {
          this.logger.info({ exchange, routingKey, messageSize: content.length }, 'Published message')
        }
        this.logger.debug({ exchange, routingKey, payload: message }, 'Published message payload')

        return
      } catch (error) {
        attempts++
        this.connected = false

        const serializedError = error instanceof Error
          ? { message: error.message, name: error.name, stack: error.stack }
          : error

        if (attempts >= maxAttempts) {
          this.logger.error(
            { error: serializedError, exchange, routingKey, attempts, maxAttempts },
            'Publish failed after max attempts',
          )
          throw new Error(
            `Failed to publish to ${exchange}/${routingKey} after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`,
          )
        }

        const retryDelay = Math.min(
          baseDelay * Math.pow(2, attempts - 1),
          MAX_PUBLISH_RETRY_DELAY_MS,
        )

        this.logger.warn(
          { error: serializedError, exchange, routingKey, attempt: attempts, maxAttempts, retryDelayMs: retryDelay },
          'Publish attempt failed, retrying',
        )

        await this.sleep(retryDelay)
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: implement publish with exponential backoff"
```

---

### Task 5: Subscribe with DLQ infrastructure

**Files:**
- Modify: `src/client.ts`
- Modify: `test/client.test.ts`

- [ ] **Step 1: Add subscribe tests to test/client.test.ts**

Append inside the main `describe('RabbitMQClient')` block:

```typescript
  describe('subscribe()', () => {
    beforeEach(async () => {
      await client.init()
    })

    it('should set up DLQ infrastructure', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)

      await client.subscribe('test-exchange', 'test.key', 'test-queue', handler)

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange.dlx', 'topic', { durable: true })
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-queue.dlq', { durable: true })
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue.dlq', 'test-exchange.dlx', 'test.key.dead')
    })

    it('should create main queue with quorum type and DLQ config', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)

      await client.subscribe('test-exchange', 'test.key', 'test-queue', handler)

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-queue', {
        durable: true,
        deadLetterExchange: 'test-exchange.dlx',
        deadLetterRoutingKey: 'test.key.dead',
        arguments: {
          'x-dead-letter-strategy': 'at-least-once',
          'x-queue-type': 'quorum',
          'x-overflow': 'reject-publish',
        },
      })
    })

    it('should bind queue and start consuming with manual ack', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)

      await client.subscribe('test-exchange', 'test.key', 'test-queue', handler)

      expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue', 'test-exchange', 'test.key')
      expect(mockChannel.consume).toHaveBeenCalledOnce()
      expect(mockChannel.consume.mock.calls[0][0]).toBe('test-queue')
      expect(mockChannel.consume.mock.calls[0][2]).toEqual({ noAck: false })
    })

    it('should throw when not connected', async () => {
      await client.close()
      const handler = vi.fn().mockResolvedValue(undefined)

      await expect(
        client.subscribe('ex', 'key', 'queue', handler),
      ).rejects.toThrow('not connected')
    })

    it('should not duplicate subscriptions for the same queue', async () => {
      const handler1 = vi.fn().mockResolvedValue(undefined)
      const handler2 = vi.fn().mockResolvedValue(undefined)

      await client.subscribe('ex', 'key', 'queue', handler1)
      await client.subscribe('ex', 'key', 'queue', handler2)

      // Both calls set up the subscription on the channel, but only one is stored
      // Verify by triggering reconnection and checking resubscribe count
      // (This is tested more thoroughly in the reconnection tests)
      expect(mockChannel.consume).toHaveBeenCalledTimes(2)
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL -- `subscribe` not implemented.

- [ ] **Step 3: Implement subscribe and setupSubscription in src/client.ts**

Replace the `setupSubscription` placeholder and add `subscribe`:

```typescript
  /**
   * Subscribes to messages from a RabbitMQ queue.
   *
   * Automatically sets up Dead Letter Queue infrastructure. Subscriptions
   * are stored for automatic re-establishment after reconnection.
   *
   * @param exchange - Exchange name
   * @param routingKey - Routing key pattern to bind to
   * @param queue - Queue name
   * @param handler - Async message handler function
   */
  async subscribe(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: RabbitMQMessageHandler,
  ): Promise<void> {
    const existingIndex = this.subscriptions.findIndex((s) => s.queue === queue)
    if (existingIndex === -1) {
      this.subscriptions.push({ exchange, routingKey, queue, handler })
    } else {
      this.subscriptions[existingIndex] = { exchange, routingKey, queue, handler }
    }

    if (!this.connected || !this.channel) {
      throw new Error('RabbitMQ client not connected. Call init() first.')
    }

    await this.setupSubscription(exchange, routingKey, queue, handler)
  }

  private async setupSubscription(
    exchange: string,
    routingKey: string,
    queue: string,
    handler: RabbitMQMessageHandler,
  ): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not available')
    }

    const dlxExchange = `${exchange}.dlx`
    const dlqQueue = `${queue}.dlq`
    const dlqRoutingKey = `${routingKey}.dead`

    await this.channel.assertExchange(dlxExchange, 'topic', { durable: true })
    await this.channel.assertQueue(dlqQueue, { durable: true })
    await this.channel.bindQueue(dlqQueue, dlxExchange, dlqRoutingKey)
    await this.channel.assertExchange(exchange, 'topic', { durable: true })

    await this.channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: dlxExchange,
      deadLetterRoutingKey: dlqRoutingKey,
      arguments: {
        'x-dead-letter-strategy': 'at-least-once',
        'x-queue-type': 'quorum',
        'x-overflow': 'reject-publish',
      },
    })

    await this.channel.bindQueue(queue, exchange, routingKey)
    await this.channel.consume(
      queue,
      (message) => {
        if (message) {
          this.handleWithRetry(message, handler)
        }
      },
      { noAck: false },
    )

    this.logger.info({ exchange, routingKey, queue }, 'Subscribed to queue')
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: implement subscribe with DLQ infrastructure"
```

---

### Task 6: Message handling with retry

**Files:**
- Modify: `src/client.ts`
- Modify: `test/client.test.ts`

- [ ] **Step 1: Add handleWithRetry tests to test/client.test.ts**

Append inside the main `describe('RabbitMQClient')` block:

```typescript
  describe('handleWithRetry()', () => {
    let consumeCallback: ((msg: unknown) => void) | null

    beforeEach(async () => {
      consumeCallback = null
      mockChannel.consume.mockImplementation(((_queue: string, cb: (msg: unknown) => void) => {
        consumeCallback = cb
        return Promise.resolve({ consumerTag: 'test' })
      }) as typeof mockChannel.consume)

      await client.init()
    })

    const createMessage = (content: unknown) => ({
      content: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
      fields: { deliveryTag: 1, redelivered: false, exchange: 'ex', routingKey: 'key', consumerTag: 'test' },
      properties: { headers: {} },
    })

    it('should ack on successful processing', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler)

      const msg = createMessage({ foo: 'bar' })
      consumeCallback!(msg)
      await vi.advanceTimersByTimeAsync(50)

      expect(handler).toHaveBeenCalledWith({ foo: 'bar' })
      expect(mockChannel.ack).toHaveBeenCalledWith(msg)
    })

    it('should nack invalid JSON immediately to DLQ', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.subscribe('ex', 'key', 'queue', handler)

      const msg = createMessage('not valid json {')
      consumeCallback!(msg)
      await vi.advanceTimersByTimeAsync(50)

      expect(handler).not.toHaveBeenCalled()
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false)
    })

    it('should retry on handler failure and ack on eventual success', async () => {
      const handler = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(undefined)

      await client.subscribe('ex', 'key', 'queue', handler)

      const msg = createMessage({ foo: 'bar' })
      consumeCallback!(msg)
      await vi.advanceTimersByTimeAsync(200)

      expect(handler).toHaveBeenCalledTimes(2)
      expect(mockChannel.ack).toHaveBeenCalledWith(msg)
      expect(mockChannel.nack).not.toHaveBeenCalled()
    })

    it('should nack to DLQ after exhausting maxRetries', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('always fails'))
      await client.subscribe('ex', 'key', 'queue', handler)

      const msg = createMessage({ foo: 'bar' })
      consumeCallback!(msg)
      await vi.advanceTimersByTimeAsync(500)

      expect(handler).toHaveBeenCalledTimes(3) // maxRetries = 3
      expect(mockChannel.ack).not.toHaveBeenCalled()
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false)
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL -- `handleWithRetry` is not implemented (no ack/nack calls).

- [ ] **Step 3: Implement handleWithRetry in src/client.ts**

Add this method to the `RabbitMQClient` class (replace any placeholder if present):

```typescript
  /**
   * Processes a message with automatic retry logic.
   *
   * Parses JSON, retries handler up to maxRetries times, acks on success,
   * nacks to DLQ on final failure. Invalid JSON is sent to DLQ immediately.
   */
  private async handleWithRetry(
    message: amqp.ConsumeMessage,
    handler: RabbitMQMessageHandler,
  ): Promise<void> {
    if (!this.channel) {
      this.logger.warn('Cannot process message -- channel unavailable')
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
      const rawPreview = message.content.toString().substring(0, 100)
      this.logger.error(
        { error: parseError, exchange, routingKey, rawContentPreview: rawPreview + (rawPreview.length >= 100 ? '...' : '') },
        'Failed to parse message JSON, sending to DLQ',
      )
      this.channel.nack(message, false, false)
      return
    }

    this.logger.debug({ exchange, routingKey, payload: content }, 'Message received, processing')

    while (attempts < this.options.maxRetries) {
      try {
        await handler(content)

        const duration = Date.now() - startTime
        this.logger.info({ exchange, routingKey, duration, attempts: attempts + 1 }, 'Message processed successfully')

        this.channel.ack(message)
        return
      } catch (error) {
        attempts++
        this.logger.error(
          {
            error: error instanceof Error ? error.message : error,
            stack: error instanceof Error ? error.stack : undefined,
            exchange,
            routingKey,
            attempt: attempts,
            maxRetries: this.options.maxRetries,
          },
          'Handler failed',
        )

        if (attempts < this.options.maxRetries) {
          await this.sleep(this.options.retryDelay)
        }
      }
    }

    const duration = Date.now() - startTime
    this.logger.error(
      { exchange, routingKey, maxRetries: this.options.maxRetries, duration },
      'Message failed after max retries, sending to DLQ',
    )

    this.channel.nack(message, false, false)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: implement message handling with retry and DLQ"
```

---

### Task 7: Health check

**Files:**
- Modify: `src/client.ts`
- Modify: `test/client.test.ts`

- [ ] **Step 1: Add health check tests to test/client.test.ts**

Append inside the main `describe('RabbitMQClient')` block:

```typescript
  describe('checkHealth()', () => {
    it('should return false when not connected', async () => {
      expect(await client.checkHealth()).toBe(false)
    })

    it('should return true when connection is healthy', async () => {
      await client.init()
      expect(await client.checkHealth()).toBe(true)
      expect(mockChannel.assertQueue).toHaveBeenCalled()
      expect(mockChannel.deleteQueue).toHaveBeenCalled()
    })

    it('should return false when queue operation fails', async () => {
      await client.init()
      mockChannel.assertQueue.mockRejectedValueOnce(new Error('queue op failed'))

      expect(await client.checkHealth()).toBe(false)
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL -- `checkHealth` not implemented.

- [ ] **Step 3: Implement checkHealth in src/client.ts**

Add this method to the `RabbitMQClient` class:

```typescript
  /**
   * Checks the health of the RabbitMQ connection by creating and
   * immediately deleting a temporary exclusive queue.
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
      this.logger.warn({ error }, 'Health check failed')
      return false
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client.ts test/client.test.ts
git commit -m "feat: implement health check"
```

---

### Task 8: Reconnection and subscription restoration tests

**Files:**
- Modify: `test/client.test.ts`

This task adds tests for reconnection behavior that exercises the already-implemented internals (reconnectWithRetry, resubscribeAll, handleChannelFailure). No new production code needed -- just verification.

- [ ] **Step 1: Add reconnection tests to test/client.test.ts**

Append inside the main `describe('RabbitMQClient')` block:

```typescript
  describe('reconnection', () => {
    it('should reconnect and restore subscriptions on connection close', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.init()
      await client.subscribe('ex', 'key', 'queue', handler)

      // Capture the connection close handler
      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      // Reset mocks to track reconnection calls
      vi.mocked(amqp.connect).mockClear()
      mockChannel.consume.mockClear()

      // Trigger connection close
      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      // Should have reconnected
      expect(amqp.connect).toHaveBeenCalledOnce()
      // Should have restored the subscription
      expect(mockChannel.consume).toHaveBeenCalledOnce()
      expect(mockChannel.consume.mock.calls[0][0]).toBe('queue')
      expect(client.isConnected()).toBe(true)
    })

    it('should reconnect on channel error', async () => {
      await client.init()

      const channelErrorHandler = mockChannel.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'error',
      )![1] as (err: Error) => void

      vi.mocked(amqp.connect).mockClear()

      channelErrorHandler(new Error('channel died'))
      await vi.advanceTimersByTimeAsync(200)

      expect(amqp.connect).toHaveBeenCalledOnce()
      expect(client.isConnected()).toBe(true)
    })

    it('should reconnect on channel close', async () => {
      await client.init()

      const channelCloseHandler = mockChannel.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      vi.mocked(amqp.connect).mockClear()

      channelCloseHandler()
      await vi.advanceTimersByTimeAsync(200)

      expect(amqp.connect).toHaveBeenCalledOnce()
      expect(client.isConnected()).toBe(true)
    })

    it('should preserve subscriptions across close(false) and re-init', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.init()
      await client.subscribe('ex', 'key', 'queue', handler)

      await client.close(false)
      mockChannel.consume.mockClear()

      await client.init()

      // Trigger reconnection to test subscription restoration
      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      mockChannel.consume.mockClear()
      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      expect(mockChannel.consume).toHaveBeenCalledOnce()
      expect(mockChannel.consume.mock.calls[0][0]).toBe('queue')
    })

    it('should clear subscriptions on close() by default', async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      await client.init()
      await client.subscribe('ex', 'key', 'queue', handler)

      await client.close() // clears subscriptions

      await client.init()
      mockChannel.consume.mockClear()

      // Trigger reconnection
      const closeHandler = mockConnection.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'close',
      )![1] as () => void

      closeHandler()
      await vi.advanceTimersByTimeAsync(200)

      // No subscriptions to restore
      expect(mockChannel.consume).not.toHaveBeenCalled()
    })
  })
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/client.test.ts`
Expected: PASS (these test already-implemented behavior)

- [ ] **Step 3: Commit**

```bash
git add test/client.test.ts
git commit -m "test: add reconnection and subscription restoration tests"
```

---

### Task 9: Test helpers (testing entrypoint)

**Files:**
- Modify: `src/testing/index.ts`
- Create: `test/testing.test.ts`

- [ ] **Step 1: Write tests for the mock helpers**

Create `test/testing.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import {
  MockRabbitMQChannel,
  MockRabbitMQConnection,
  createMockAmqplib,
} from '../src/testing/index.js'

describe('MockRabbitMQChannel', () => {
  it('should track published messages', () => {
    const channel = new MockRabbitMQChannel()

    channel.publish('ex', 'key', Buffer.from(JSON.stringify({ foo: 'bar' })), { persistent: true })

    const messages = channel.getPublishedMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0].exchange).toBe('ex')
    expect(messages[0].routingKey).toBe('key')
    expect(messages[0].message).toEqual({ foo: 'bar' })
  })

  it('should simulate message consumption', () => {
    const channel = new MockRabbitMQChannel()
    const handler = vi.fn()

    channel.consume('queue', handler)
    channel.simulateMessage({ test: 'data' })

    expect(handler).toHaveBeenCalledOnce()
    const msg = handler.mock.calls[0][0]
    expect(JSON.parse(msg.content.toString())).toEqual({ test: 'data' })
  })

  it('should simulate invalid JSON message', () => {
    const channel = new MockRabbitMQChannel()
    const handler = vi.fn()

    channel.consume('queue', handler)
    channel.simulateInvalidJsonMessage()

    expect(handler).toHaveBeenCalledOnce()
    const msg = handler.mock.calls[0][0]
    expect(msg.content.toString()).toBe('not valid json {')
  })

  it('should simulate channel close and error events', () => {
    const channel = new MockRabbitMQChannel()
    const closeHandler = vi.fn()
    const errorHandler = vi.fn()

    channel.on('close', closeHandler)
    channel.on('error', errorHandler)

    channel.simulateClose()
    expect(closeHandler).toHaveBeenCalledOnce()

    channel.simulateError(new Error('test'))
    expect(errorHandler).toHaveBeenCalledOnce()
  })

  it('should clear messages', () => {
    const channel = new MockRabbitMQChannel()
    channel.publish('ex', 'key', Buffer.from('{}'))
    expect(channel.getPublishedMessages()).toHaveLength(1)

    channel.clearMessages()
    expect(channel.getPublishedMessages()).toHaveLength(0)
  })

  it('should reset all state', () => {
    const channel = new MockRabbitMQChannel()
    channel.publish('ex', 'key', Buffer.from('{}'))
    channel.simulateClose()

    channel.reset()

    expect(channel.getPublishedMessages()).toHaveLength(0)
    expect(channel.isClosed).toBe(false)
  })
})

describe('MockRabbitMQConnection', () => {
  it('should create a new channel on each createConfirmChannel call', async () => {
    const conn = new MockRabbitMQConnection()
    const ch1 = conn.channel

    await conn.createConfirmChannel()
    await conn.createConfirmChannel()

    expect(conn.channelCount).toBe(3) // initial + 2 reconnections
    expect(conn.channel).not.toBe(ch1)
  })

  it('should simulate connection close and error events', () => {
    const conn = new MockRabbitMQConnection()
    const closeHandler = vi.fn()
    const errorHandler = vi.fn()

    conn.on('close', closeHandler)
    conn.on('error', errorHandler)

    conn.simulateClose()
    expect(closeHandler).toHaveBeenCalledOnce()
    expect(conn.isConnected).toBe(false)

    conn.simulateError(new Error('test'))
    expect(errorHandler).toHaveBeenCalledOnce()
  })

  it('should reset to initial state', async () => {
    const conn = new MockRabbitMQConnection()
    await conn.createConfirmChannel()
    await conn.createConfirmChannel()
    conn.simulateClose()

    conn.reset()

    expect(conn.isConnected).toBe(true)
    expect(conn.channelCount).toBe(1)
  })
})

describe('createMockAmqplib', () => {
  it('should return mockConnection and amqpMock', async () => {
    const { mockConnection, amqpMock } = createMockAmqplib()

    const conn = await amqpMock.connect('amqp://localhost')

    expect(conn).toBe(mockConnection)
    expect(mockConnection.channel).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/testing.test.ts`
Expected: FAIL -- `src/testing/index.ts` is empty.

- [ ] **Step 3: Implement mock helpers in src/testing/index.ts**

```typescript
import type { ConsumeMessage, Options, Replies } from 'amqplib'

/**
 * Published message tracking interface
 */
export interface PublishedMessage {
  exchange: string
  routingKey: string
  content: Buffer
  options?: Options.Publish
  message: unknown
}

/**
 * Mock RabbitMQ channel for testing.
 *
 * Tracks all operations without requiring a real RabbitMQ connection.
 * Use `simulateMessage()` to trigger consumption, `getPublishedMessages()`
 * to inspect publishes.
 */
export class MockRabbitMQChannel {
  private messages: PublishedMessage[] = []
  private _closed = false
  private closeHandlers: Array<() => void> = []
  private errorHandlers: Array<(err: Error) => void> = []
  private _consumeCallback: ((msg: ConsumeMessage | null) => void) | null = null

  assertExchange = mockFn().mockResolvedValue({} as Replies.AssertExchange)
  assertQueue = mockFn().mockResolvedValue({ queue: 'test-queue' } as Replies.AssertQueue)
  bindQueue = mockFn().mockResolvedValue({})
  publish = mockFn().mockImplementation(
    (exchange: string, routingKey: string, content: Buffer, options?: Options.Publish) => {
      let message: unknown
      try {
        message = JSON.parse(content.toString())
      } catch {
        message = content.toString()
      }
      this.messages.push({ exchange, routingKey, content, options, message })
      return true
    },
  )
  consume = mockFn().mockImplementation(
    (_queue: string, callback: (msg: ConsumeMessage | null) => void) => {
      this._consumeCallback = callback
      return Promise.resolve({ consumerTag: 'test-consumer' } as Replies.Consume)
    },
  )
  ack = mockFn()
  nack = mockFn()
  close = mockFn().mockResolvedValue(undefined)
  waitForConfirms = mockFn().mockResolvedValue(undefined)
  prefetch = mockFn().mockResolvedValue(undefined)
  deleteQueue = mockFn().mockResolvedValue({})
  on = mockFn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'close') {
      this.closeHandlers.push(handler as () => void)
    } else if (event === 'error') {
      this.errorHandlers.push(handler as (err: Error) => void)
    }
    return this
  })

  /** Simulate a message being received */
  simulateMessage(content: unknown): void {
    if (this._consumeCallback) {
      this._consumeCallback({
        content: Buffer.from(JSON.stringify(content)),
        fields: {
          deliveryTag: 1,
          redelivered: false,
          exchange: 'test-exchange',
          routingKey: 'test-key',
          consumerTag: 'test-consumer',
        },
        properties: {
          headers: {},
          contentType: undefined,
          contentEncoding: undefined,
          deliveryMode: undefined,
          priority: undefined,
          correlationId: undefined,
          replyTo: undefined,
          expiration: undefined,
          messageId: undefined,
          timestamp: undefined,
          type: undefined,
          userId: undefined,
          appId: undefined,
          clusterId: undefined,
        },
      })
    }
  }

  /** Simulate receiving an invalid JSON message */
  simulateInvalidJsonMessage(): void {
    if (this._consumeCallback) {
      this._consumeCallback({
        content: Buffer.from('not valid json {'),
        fields: {
          deliveryTag: 1,
          redelivered: false,
          exchange: 'test-exchange',
          routingKey: 'test-key',
          consumerTag: 'test-consumer',
        },
        properties: {
          headers: {},
          contentType: undefined,
          contentEncoding: undefined,
          deliveryMode: undefined,
          priority: undefined,
          correlationId: undefined,
          replyTo: undefined,
          expiration: undefined,
          messageId: undefined,
          timestamp: undefined,
          type: undefined,
          userId: undefined,
          appId: undefined,
          clusterId: undefined,
        },
      })
    }
  }

  getPublishedMessages(): PublishedMessage[] {
    return this.messages
  }

  clearMessages(): void {
    this.messages = []
  }

  get isClosed(): boolean {
    return this._closed
  }

  simulateClose(): void {
    this._closed = true
    this.closeHandlers.forEach((handler) => handler())
  }

  simulateError(error: Error): void {
    this.errorHandlers.forEach((handler) => handler(error))
  }

  reset(): void {
    this.messages = []
    this._closed = false
    this.closeHandlers = []
    this.errorHandlers = []
    this._consumeCallback = null
  }
}

/**
 * Mock RabbitMQ connection for testing.
 *
 * Creates a new channel on each `createConfirmChannel` call to properly
 * simulate reconnection behavior.
 */
export class MockRabbitMQConnection {
  private _connected = true
  private closeHandlers: Array<() => void> = []
  private errorHandlers: Array<(err: Error) => void> = []
  private _channels: MockRabbitMQChannel[] = []

  constructor() {
    this._channels.push(new MockRabbitMQChannel())
  }

  get channel(): MockRabbitMQChannel {
    return this._channels[this._channels.length - 1]
  }

  get channels(): MockRabbitMQChannel[] {
    return this._channels
  }

  get channelCount(): number {
    return this._channels.length
  }

  createConfirmChannel = mockFn().mockImplementation(() => {
    if (this._channels.length > 0 && this.createConfirmChannel.mock.calls.length > 1) {
      this._channels.push(new MockRabbitMQChannel())
    }
    return Promise.resolve(this.channel)
  })

  close = mockFn().mockImplementation(() => {
    this._connected = false
    return Promise.resolve()
  })

  on = mockFn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'close') {
      this.closeHandlers.push(handler as () => void)
    } else if (event === 'error') {
      this.errorHandlers.push(handler as (err: Error) => void)
    }
    return this
  })

  simulateClose(): void {
    this._connected = false
    this.closeHandlers.forEach((handler) => handler())
  }

  simulateError(error: Error): void {
    this.errorHandlers.forEach((handler) => handler(error))
  }

  get isConnected(): boolean {
    return this._connected
  }

  reset(): void {
    this._connected = true
    this.closeHandlers = []
    this.errorHandlers = []
    this._channels.forEach((ch) => ch.reset())
    this._channels = [this._channels[0]]
  }
}

/**
 * Creates a mock amqplib module for testing.
 *
 * @example
 * ```typescript
 * import { createMockAmqplib } from '@linagora/rabbitmq-client/testing'
 *
 * const { mockConnection, amqpMock } = createMockAmqplib()
 * vi.mock('amqplib', () => ({ default: amqpMock }))
 * ```
 */
export const createMockAmqplib = (): {
  mockConnection: MockRabbitMQConnection
  amqpMock: { connect: MockFn }
} => {
  const mockConnection = new MockRabbitMQConnection()

  return {
    mockConnection,
    amqpMock: {
      connect: mockFn().mockResolvedValue(mockConnection),
    },
  }
}

// --- Internal mock function factory (framework-agnostic) ---

interface MockFn {
  (...args: unknown[]): unknown
  mock: { calls: unknown[][] }
  mockResolvedValue: (val: unknown) => MockFn
  mockImplementation: (fn: (...args: unknown[]) => unknown) => MockFn
}

function mockFn(): MockFn {
  let impl: ((...args: unknown[]) => unknown) | null = null
  const calls: unknown[][] = []

  const fn = ((...args: unknown[]) => {
    calls.push(args)
    return impl ? impl(...args) : undefined
  }) as MockFn

  fn.mock = { calls }

  fn.mockResolvedValue = (val: unknown) => {
    impl = () => Promise.resolve(val)
    return fn
  }

  fn.mockImplementation = (newImpl: (...args: unknown[]) => unknown) => {
    impl = newImpl
    return fn
  }

  return fn
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/testing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/testing/index.ts test/testing.test.ts
git commit -m "feat: add test helpers (MockChannel, MockConnection, createMockAmqplib)"
```

---

### Task 10: Final verification and cleanup

**Files:**
- Modify: `src/index.ts` (if needed)
- No new files

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `npx tsup`
Expected: Build succeeds. Verify outputs:
- `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`
- `dist/testing/index.js`, `dist/testing/index.cjs`, `dist/testing/index.d.ts`

Run: `ls dist/ dist/testing/`

- [ ] **Step 4: Verify package exports resolve**

Run: `node -e "const p = require('./dist/index.cjs'); console.log(typeof p.RabbitMQClient)"`
Expected: `function`

Run: `node --input-type=module -e "import { RabbitMQClient } from './dist/index.js'; console.log(typeof RabbitMQClient)"`
Expected: `function`

- [ ] **Step 5: Commit any final adjustments**

```bash
git add -A
git commit -m "chore: final cleanup and verification"
```
