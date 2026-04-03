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
