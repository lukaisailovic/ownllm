import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolvePaths } from '../config/paths'
import { Credential, type CredentialData } from './credential'

const STORE_VERSION = 1
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 50
const LOCK_STALE_MS = 30_000

interface StoreFile {
  version: number
  providers: Record<string, CredentialData[]>
}

function emptyStore(): StoreFile {
  return { version: STORE_VERSION, providers: {} }
}

// Persists per-provider OAuth credentials at 0600 in a 0700 dir, with an advisory lockfile that
// serializes read-modify-write across processes (a second `serve`/`doctor`). v1 keeps a single
// active credential per provider; the array shape leaves room for pooling without a migration.
export class AuthStore {
  constructor(
    private readonly file: string,
    private readonly lockFile: string,
  ) {}

  async getCredential(providerId: string): Promise<Credential | undefined> {
    const entry = (await this.read()).providers[providerId]?.[0]
    return entry ? new Credential(entry) : undefined
  }

  async listProviders(): Promise<string[]> {
    return Object.keys((await this.read()).providers)
  }

  async setCredential(providerId: string, credential: Credential): Promise<void> {
    await this.withLock(async () => {
      const store = await this.read()
      store.providers[providerId] = [credential.toStored()]
      await this.write(store)
    })
  }

  async removeCredential(providerId: string): Promise<boolean> {
    return this.withLock(async () => {
      const store = await this.read()
      if (!(providerId in store.providers)) return false
      delete store.providers[providerId]
      await this.write(store)
      return true
    })
  }

  // Locked read -> transform -> persist. The transform sees the credential as read INSIDE the
  // lock, so a refresh that lost the race observes the winner's rotated token instead of clobbering.
  async update(
    providerId: string,
    transform: (current: Credential | undefined) => Promise<Credential>,
  ): Promise<Credential> {
    return this.withLock(async () => {
      const store = await this.read()
      const current = store.providers[providerId]?.[0]
      const next = await transform(current ? new Credential(current) : undefined)
      store.providers[providerId] = [next.toStored()]
      await this.write(store)
      return next
    })
  }

  private async read(): Promise<StoreFile> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
      throw error
    }
    const parsed = JSON.parse(raw) as StoreFile
    return parsed.providers ? parsed : emptyStore()
  }

  private async write(store: StoreFile): Promise<void> {
    const dir = dirname(this.file)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const tmp = `${this.file}.${process.pid}.${tmpSuffix()}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`)
    } finally {
      await handle.close()
    }
    await rename(tmp, this.file)
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await this.acquireLock()
    try {
      return await action()
    } finally {
      await unlink(this.lockFile).catch(() => {})
    }
  }

  private async acquireLock(): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        await mkdir(dirname(this.lockFile), { recursive: true, mode: 0o700 })
        const handle = await open(this.lockFile, 'wx', 0o600)
        await handle.writeFile(String(process.pid))
        await handle.close()
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await this.breakStaleLock()
        if (Date.now() > deadline) {
          throw new Error(`timed out acquiring auth store lock: ${this.lockFile}`)
        }
        await sleep(LOCK_RETRY_MS)
      }
    }
  }

  private async breakStaleLock(): Promise<void> {
    try {
      const info = await stat(this.lockFile)
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(this.lockFile).catch(() => {})
    } catch {
      // lock released between EEXIST and stat; the retry loop will reacquire
    }
  }
}

export function openAuthStore(): AuthStore {
  const { authFile, authLockFile } = resolvePaths()
  return new AuthStore(authFile, authLockFile)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tmpSuffix(): string {
  return Math.floor(Math.random() * 1e9).toString(36)
}
