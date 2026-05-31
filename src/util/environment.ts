import { basename } from 'node:path'

// Console/TUI browsers `open` would launch *inside* the terminal, hijacking the session instead of
// popping a window. Their presence means there is no usable GUI browser to receive an OAuth redirect.
const CONSOLE_BROWSERS = new Set([
  'w3m',
  'lynx',
  'links',
  'links2',
  'elinks',
  'www-browser',
  'browsh',
])

// Env vars set by SSH and browser-only cloud consoles. In each, a loopback redirect binds on the
// remote machine and the user's browser (on their laptop) can't reach it — the interactive flow fails.
const REMOTE_SESSION_VARS = [
  'SSH_CLIENT',
  'SSH_TTY',
  'CLOUD_SHELL',
  'CODESPACES',
  'CODESPACE_NAME',
  'GITPOD_WORKSPACE_ID',
  'REPL_ID',
  'STACKBLITZ',
]

export function isRemoteSession(): boolean {
  return REMOTE_SESSION_VARS.some((name) => Boolean(process.env[name]))
}

// Best-effort guess at whether launching a real (graphical) browser will work. False on a headless
// Linux box (no display server and no graphical `$BROWSER`) or when `$BROWSER` names a console
// browser; macOS and Windows always ship a usable default. Callers fall back to a paste-the-code flow.
export function canOpenBrowser(): boolean {
  const browser = process.env.BROWSER
  if (browser && namesConsoleBrowser(browser)) return false
  if (process.platform === 'linux' && !browser) {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  }
  return true
}

function namesConsoleBrowser(value: string): boolean {
  const token = value.trim().split(/\s+/)[0] ?? ''
  return CONSOLE_BROWSERS.has(basename(token).toLowerCase())
}
