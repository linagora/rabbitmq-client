# @linagora/rabbitmq-client

Production-grade RabbitMQ client for Node.js with confirm channels, automatic DLQ infrastructure, exponential backoff, and reconnection with subscription restoration.

## Install

```bash
npm install @linagora/rabbitmq-client
```

## Usage

```typescript
import { RabbitMQClient } from '@linagora/rabbitmq-client'

const client = new RabbitMQClient({
  url: 'amqp://user:pass@localhost:5672',
})

await client.init()

// Publish with confirm channels and automatic retry
await client.publish('auth', 'user.created', {
  userId: '123',
  email: 'user@example.com',
})

// Subscribe with automatic DLQ setup
await client.subscribe('auth', 'user.created', 'my-service.user-created', async (message) => {
  console.log('Received:', message)
})

// Health check for readiness probes
const healthy = await client.checkHealth()

await client.close()
```

## Configuration

All options except `url` are optional with sensible defaults.

```typescript
const client = new RabbitMQClient({
  url: 'amqp://localhost',          // required
  maxRetries: 3,                     // handler retries before DLQ
  retryDelay: 1000,                  // ms between handler retries
  connectionRetryDelay: 5000,        // ms between reconnection attempts
  initMaxAttempts: 5,                // connection attempts on startup (fail-fast)
  publishMaxAttempts: 5,             // publish retries with exponential backoff
  prefetch: 10,                      // channel prefetch count
  logger: parentPinoLogger,          // optional parent pino instance
})
```

## What it does

**Publishing** -- asserts a durable topic exchange, publishes with `persistent: true`, and awaits broker confirmation via confirm channels. On failure, retries with exponential backoff (capped at 60s) and forces a fresh channel on each retry to avoid silent dead-channel loops.

**Subscribing** -- automatically wires Dead Letter Queue infrastructure for each subscription: a `.dlx` exchange, a `.dlq` queue, and a `.dead` routing key. Main queues are quorum type with `at-least-once` dead letter strategy and `reject-publish` overflow. Messages are consumed with manual acknowledgment.

**Message handling** -- parses JSON (malformed messages go straight to DLQ), retries the handler up to `maxRetries` times with `retryDelay` between attempts, acks on success, nacks to DLQ after exhausting retries. Payloads are never logged at error level.

**Reconnection** -- on connection or channel loss, automatically reconnects and restores all subscriptions in parallel. Concurrent reconnection attempts are deduplicated via a shared promise.

**Health check** -- creates and immediately deletes a temporary exclusive queue to verify the connection is alive.

## Test helpers

The library ships framework-agnostic mock helpers for testing your consumers without a real RabbitMQ connection.

```typescript
import { MockRabbitMQChannel, MockRabbitMQConnection, createMockAmqplib } from '@linagora/rabbitmq-client/testing'

// Create mock amqplib for dependency injection
const { mockConnection, amqpMock } = createMockAmqplib()

// Inspect published messages
const channel = mockConnection.channel
channel.getPublishedMessages() // [{ exchange, routingKey, content, message }]

// Simulate incoming messages
channel.simulateMessage({ userId: '123' })
channel.simulateInvalidJsonMessage()

// Simulate failures
mockConnection.simulateClose()
channel.simulateError(new Error('channel died'))
```

## License

AGPL-3.0
