import { createParser } from 'eventsource-parser'
import type { SSEvent } from '../translate/types'

// Parses an upstream SSE body into a stream of events. The parser invokes onEvent synchronously
// while feeding, so we buffer into a queue and yield between reads.
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const queue: SSEvent[] = []
  const parser = createParser({
    onEvent(event) {
      queue.push({ event: event.event, data: event.data })
    },
  })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
      yield* drain(queue)
    }
  } finally {
    reader.releaseLock()
  }
  yield* drain(queue)
}

function* drain(queue: SSEvent[]): Generator<SSEvent> {
  while (queue.length > 0) {
    const event = queue.shift()
    if (event) yield event
  }
}
