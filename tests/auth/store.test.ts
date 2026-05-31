import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Credential, type CredentialData } from '../../src/auth/credential'
import { AuthStore } from '../../src/auth/store'

function credential(overrides: Partial<CredentialData> = {}): Credential {
  return new Credential({
    type: 'oauth',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: 2_000_000_000,
    ...overrides,
  })
}

let dir: string
let store: AuthStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'llmgate-store-'))
  store = new AuthStore(join(dir, 'auth.json'), join(dir, 'auth.json.lock'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('AuthStore', () => {
  it('returns undefined for an absent credential', async () => {
    expect(await store.getCredential('openai-codex')).toBeUndefined()
    expect(await store.listProviders()).toEqual([])
  })

  it('round-trips a stored credential', async () => {
    await store.setCredential('xai', credential({ email: 'me@example.com' }))
    const loaded = await store.getCredential('xai')
    expect(loaded?.email).toBe('me@example.com')
    expect(loaded?.accessToken).toBe('access-token')
    expect(await store.listProviders()).toEqual(['xai'])
  })

  it('writes the store file 0600 inside a 0700 dir', async () => {
    await store.setCredential('xai', credential())
    const fileMode = (await stat(join(dir, 'auth.json'))).mode & 0o777
    const dirMode = (await stat(dirname(join(dir, 'auth.json')))).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(dirMode).toBe(0o700)
  })

  it('removes a credential and reports whether one existed', async () => {
    await store.setCredential('xai', credential())
    expect(await store.removeCredential('xai')).toBe(true)
    expect(await store.removeCredential('xai')).toBe(false)
    expect(await store.getCredential('xai')).toBeUndefined()
  })

  it('keeps providers independent', async () => {
    await store.setCredential('xai', credential({ email: 'x@example.com' }))
    await store.setCredential('openai-codex', credential({ account_id: 'acct_1' }))
    expect((await store.getCredential('xai'))?.email).toBe('x@example.com')
    expect((await store.getCredential('openai-codex'))?.accountId).toBe('acct_1')
  })
})
