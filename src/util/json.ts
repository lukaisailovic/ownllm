export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

export function getString(value: unknown, key: string): string | undefined {
  const field = asRecord(value)?.[key]
  return typeof field === 'string' ? field : undefined
}

export function getNumber(value: unknown, key: string): number | undefined {
  const field = asRecord(value)?.[key]
  return typeof field === 'number' ? field : undefined
}

export function omit(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) result[key] = value
  }
  return result
}
