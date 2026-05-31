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
