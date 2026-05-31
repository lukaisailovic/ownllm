import { afterEach, describe, expect, it, vi } from 'vitest'
import { canOpenBrowser, isRemoteSession } from '../../src/util/environment'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isRemoteSession', () => {
  it('detects an SSH session', () => {
    vi.stubEnv('SSH_TTY', '/dev/pts/0')
    expect(isRemoteSession()).toBe(true)
  })

  it('detects a browser-only cloud console', () => {
    vi.stubEnv('CODESPACES', 'true')
    expect(isRemoteSession()).toBe(true)
  })
})

describe('canOpenBrowser', () => {
  it('refuses when $BROWSER names a console browser', () => {
    vi.stubEnv('BROWSER', '/usr/bin/w3m')
    expect(canOpenBrowser()).toBe(false)
  })
})
