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
