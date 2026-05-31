import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Credential, type CredentialData } from '../../src/auth/credential'
import { AuthError } from '../../src/auth/errors'
import { RefreshManager } from '../../src/auth/refresh'
import { AuthStore } from '../../src/auth/store'
import type { AuthProvider } from '../../src/providers/types'
import { delay } from '../../src/util/async'

const nowSeconds = () => Math.floor(Date.now() / 1000)

function credential(overrides: Partial<CredentialData> = {}): Credential {
  return new Credential({
    type: 'oauth',
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: nowSeconds() + 3600,
    ...overrides,
  })
}

class CountingProvider implements AuthProvider {
  readonly id = 'fake'
  refreshCount = 0

  async login(): Promise<Credential> {
    throw new Error('login not used in this test')
  }

  isExpired(c: Credential): boolean {
    return c.isExpired(60)
  }

  async refresh(): Promise<Credential> {
    this.refreshCount += 1
    await delay(20)
    return credential({ access_token: `refreshed-${this.refreshCount}` })
  }
}

let dir: string
let store: AuthStore
let provider: CountingProvider
let manager: RefreshManager

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownllm-refresh-'))
  store = new AuthStore(join(dir, 'auth.json'), join(dir, 'auth.json.lock'))
  provider = new CountingProvider()
  manager = new RefreshManager(store, new Map([[provider.id, provider]]))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('RefreshManager', () => {
  it('coalesces concurrent refreshes into a single rotation (single-flight)', async () => {
    await store.setCredential('fake', credential({ expires_at: nowSeconds() - 100 }))

    const results = await Promise.all(Array.from({ length: 8 }, () => manager.ensureFresh('fake')))

    expect(provider.refreshCount).toBe(1)
    const tokens = new Set(results.map((c) => c.accessToken))
    expect(tokens).toEqual(new Set(['refreshed-1']))
    expect((await store.getCredential('fake'))?.accessToken).toBe('refreshed-1')
  })

  it('returns the stored credential without refreshing when still valid', async () => {
    await store.setCredential('fake', credential({ access_token: 'still-good' }))
    const result = await manager.ensureFresh('fake')
    expect(result.accessToken).toBe('still-good')
    expect(provider.refreshCount).toBe(0)
  })

  it('throws credential_missing when nothing is stored', async () => {
    await expect(manager.ensureFresh('fake')).rejects.toMatchObject({ code: 'credential_missing' })
  })

  it('blocks a reactive refresh inside the min-interval guard', async () => {
    await store.setCredential(
      'fake',
      credential({ last_refresh: new Date().toISOString(), expires_at: nowSeconds() + 3600 }),
    )
    await expect(manager.refreshAfterUnauthorized('fake')).rejects.toBeInstanceOf(AuthError)
    await expect(manager.refreshAfterUnauthorized('fake')).rejects.toMatchObject({
      code: 'refresh_too_soon',
    })
    expect(provider.refreshCount).toBe(0)
  })

  it('allows a reactive refresh once the guard window has passed', async () => {
    const old = new Date(Date.now() - 60_000).toISOString()
    await store.setCredential('fake', credential({ last_refresh: old }))
    const refreshed = await manager.refreshAfterUnauthorized('fake')
    expect(refreshed.accessToken).toBe('refreshed-1')
    expect(provider.refreshCount).toBe(1)
  })
})
