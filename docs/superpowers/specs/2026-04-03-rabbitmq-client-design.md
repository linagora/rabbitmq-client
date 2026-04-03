# @linagora/rabbitmq-client -- Design Spec

## Purpose

Shared RabbitMQ client library extracted from Twake Workplace's registration and admin-panel backends. Both services independently evolved the same production pattern (confirm channels, DLQ with quorum queues, exponential backoff, auto-reconnection with subscription restoration). This library mutualizes that pattern so new services get battle-tested messaging out of the box without copy-pasting ~700 lines of infrastructure code.

## Public API

```typescript
import { RabbitMQClient } from '@linagora/rabbitmq-client'

const client = new RabbitMQClient({
  url: 'amqp://localhost',        // required
  maxRetries: 3,                   // handler retries before DLQ (default: 3)
  retryDelay: 1000,                // ms between handler retries (default: 1000)
  connectionRetryDelay: 5000,      // ms between reconnection attempts (default: 5000)
  initMaxAttempts: 5,              // fail-fast on startup; undefined = unlimited (default: 5)
  publishMaxAttempts: 5,           // publish retries with exponential backoff (default: 5)
  prefetch: 10,                    // channel prefetch count (default: 10)
  logger: parentPinoInstance,      // optional parent pino logger
})

await client.init()
await client.publish(exchange, routingKey, message)
await client.subscribe(exchange, routingKey, queue, handler)
const healthy = await client.checkHealth()
client.isConnected()
await client.close()
```

The library does not read environment variables. Configuration is the consumer's responsibility.

### Types

```typescript
interface RabbitMQClientOptions {
  url: string
  maxRetries?: number              // default: 3
  retryDelay?: number              // default: 1000
  connectionRetryDelay?: number    // default: 5000
  initMaxAttempts?: number         // default: 5
  publishMaxAttempts?: number      // default: 5
  prefetch?: number                // default: 10
  logger?: pino.Logger             // optional parent logger
}

type RabbitMQMessage = Record<string, unknown>

type RabbitMQMessageHandler = (message: RabbitMQMessage) => Promise<void>

interface RabbitMQSubscription {
  exchange: string
  routingKey: string
  queue: string
  handler: RabbitMQMessageHandler
}
```

## Internals

### Connection lifecycle

- `init()` connects via amqplib, creates a confirm channel, sets prefetch. Uses `initializationPromise` to prevent concurrent init races.
- `doConnect(maxAttempts?)` is the internal connection loop. When `maxAttempts` is provided (startup), it throws after exhausting attempts (fail-fast). When undefined (runtime reconnection), it retries indefinitely.
- Connection and channel each register `error` and `close` event handlers. Channel failure triggers reconnection independently of connection state.
- `reconnectWithRetry()` deduplicates via `reconnectionPromise` -- multiple callers await the same reconnection attempt.
- After reconnecting, `resubscribeAll()` restores all stored subscriptions in parallel using `Promise.allSettled`.

### Publishing

- Asserts a durable topic exchange (idempotent).
- Publishes with `persistent: true` and awaits `waitForConfirms()` for broker acknowledgment.
- On failure: exponential backoff (`baseDelay * 2^(attempt-1)`, capped at 60s), up to `publishMaxAttempts`.
- On any publish error, `connected` is set to `false` to force a fresh channel on the next attempt. This prevents silent retries on a dead channel.

### Subscribing

Automatic DLQ infrastructure per subscription:

- Dead letter exchange: `${exchange}.dlx` (topic, durable)
- Dead letter queue: `${queue}.dlq` (durable)
- Dead letter routing key: `${routingKey}.dead`
- Main queue: durable, quorum type (`x-queue-type: quorum`), `at-least-once` dead letter strategy, `reject-publish` overflow
- Binding: main queue bound to exchange with the given routing key
- Consumption: manual ack (`noAck: false`)

Subscriptions are stored in memory for restoration after reconnection. If a subscription for the same queue already exists, its handler is updated.

### Message handling (handleWithRetry)

1. Parse JSON. If parsing fails, nack immediately to DLQ (no retry -- the message is malformed).
2. Call the handler. On success, ack.
3. On handler failure, retry up to `maxRetries` with `retryDelay` between attempts.
4. After exhausting retries, nack without requeue (routes to DLQ).
5. Message payloads are never logged at error level to protect sensitive data. The DLQ preserves the original message for investigation.

### Logging

- Ships with pino.
- Creates a child logger with `{ service: 'rabbitmq-client' }`.
- If the consumer passes a parent pino instance via options, the child is derived from it (unified log output). Otherwise, the library creates its own root logger.

## Project Structure

```
@linagora/rabbitmq-client
src/
  index.ts              # Public exports: RabbitMQClient + all types
  client.ts             # RabbitMQClient class implementation
  types.ts              # All type definitions
  logger.ts             # Pino child logger factory
src/testing/
  index.ts              # Test helpers: MockChannel, MockConnection, createMockClient
test/
  client.test.ts        # Full test suite: connection, publish, subscribe, retry, reconnection, health
  testing.test.ts       # Verify mock helpers work correctly
tsconfig.json
tsup.config.ts          # Dual ESM + CJS build
package.json
```

## Build and Distribution

- **Build tool**: tsup (dual ESM + CJS output)
- **Outputs**: `dist/index.js` + `dist/index.cjs`, `dist/testing/index.js` + `dist/testing/index.cjs`
- **Package exports**:
  - `"."` -- main client (`import`/`require`)
  - `"./testing"` -- test helpers (`import`/`require`)
- **Runtime dependencies**: `amqplib`, `pino`
- **Dev dependencies**: `@types/amqplib`, `typescript`, `tsup`, `vitest`
- **Test framework**: vitest

## Migration Path

For each consuming service:

1. `npm install @linagora/rabbitmq-client`
2. Replace the local RabbitMQ client with an import from the library
3. Pass configuration via the constructor (move env var reading to the service's config layer)
4. Replace local test mocks with `@linagora/rabbitmq-client/testing`
5. Delete the local RabbitMQ client code

The API is intentionally identical to what both services already use, so migration is mechanical.
