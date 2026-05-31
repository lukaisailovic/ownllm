import { styleText } from 'node:util'

// Terminal styling for the CLI. `styleText` strips its own escapes when the target stream isn't a
// TTY or NO_COLOR is set, so piped output stays plain without us checking anything here.
type Format = Parameters<typeof styleText>[0]

const paint =
  (format: Format, stream: NodeJS.WriteStream) =>
  (text: string): string =>
    styleText(format, text, { stream })

export const style = {
  bold: paint('bold', process.stdout),
  dim: paint('dim', process.stdout),
  cyan: paint('cyan', process.stdout),
  green: paint('green', process.stdout),
  red: paint('red', process.stdout),
  yellow: paint('yellow', process.stdout),
}

export type StatusKind = 'ok' | 'warn' | 'bad' | 'info'

const GLYPHS: Record<StatusKind, string> = {
  ok: style.green('✓'),
  warn: style.yellow('⚠'),
  bad: style.red('✗'),
  info: style.dim('•'),
}

const writeLine = (text = ''): void => {
  process.stdout.write(`${text}\n`)
}

export const out = {
  line: writeLine,
  blank: () => writeLine(),
  status: (kind: StatusKind, text: string) => writeLine(`  ${GLYPHS[kind]} ${text}`),
  table: (rows: string[][], opts: { head?: boolean } = {}) => writeLine(renderTable(rows, opts)),
}

// Goes to stderr (its own color check), so a failure line is colored even when stdout is piped.
export function fail(text: string): void {
  process.stderr.write(`${paint('red', process.stderr)('✗')} ${text}\n`)
}

// SGR sequences (ESC '[' … 'm') take no visible columns; strip them so colored cells still align.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const visibleWidth = (text: string): number => text.replace(ANSI_PATTERN, '').length

function renderTable(rows: string[][], opts: { head?: boolean }): string {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, visibleWidth(cell))
    })
  }
  const lines = rows.map((row, rowIndex) => {
    const padded = row.map((cell, index) => {
      if (index === row.length - 1) return cell
      return cell + ' '.repeat((widths[index] ?? 0) - visibleWidth(cell))
    })
    const line = `  ${padded.join('   ')}`
    return opts.head && rowIndex === 0 ? style.dim(line) : line
  })
  return lines.join('\n')
}
