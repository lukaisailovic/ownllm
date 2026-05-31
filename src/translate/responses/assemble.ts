import { asRecord, getString } from '../../util/json'
import type { SSEvent, Usage } from '../types'
import { eventType, parseEventData, responseUsage } from './wire'

export interface AssembledResponse {
  items: unknown[]
  usage?: Usage
  status?: string
  incompleteReason?: string
}

// Buffers every output_item.done and reads the final response object. If response.completed carries
// an empty `output`, it is patched from the buffer (PLAN §10 "empty-output patch insurance").
export async function assembleResponse(events: AsyncIterable<SSEvent>): Promise<AssembledResponse> {
  const buffered: unknown[] = []
  let response: Record<string, unknown> | undefined

  for await (const event of events) {
    const data = parseEventData(event.data)
    const type = eventType(data)
    if (type === 'response.output_item.done') {
      const item = asRecord(data)?.item
      if (item) buffered.push(item)
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      response = asRecord(asRecord(data)?.response)
    }
  }

  const output = response?.output
  const items = Array.isArray(output) && output.length > 0 ? output : buffered

  return {
    items,
    usage: responseUsage(response),
    status: getString(response, 'status'),
    incompleteReason: getString(asRecord(response?.incomplete_details), 'reason'),
  }
}
