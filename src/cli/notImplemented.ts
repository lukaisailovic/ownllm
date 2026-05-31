export function notImplemented(feature: string): never {
  process.stderr.write(`${feature}: not implemented yet\n`)
  process.exit(1)
}
