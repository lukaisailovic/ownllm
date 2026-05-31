import { CookieJar as ToughCookieJar } from 'tough-cookie'

// Thin wrapper over tough-cookie. Codex needs this because fetch/undici does NOT persist cookies,
// yet Cloudflare's cf_clearance/__cf_bm must be replayed on every request (PLAN risk A).
export class CookieJar {
  private readonly jar = new ToughCookieJar()

  cookieHeader(url: string): string | undefined {
    const value = this.jar.getCookieStringSync(url)
    return value.length > 0 ? value : undefined
  }

  store(url: string, setCookies: string[]): void {
    for (const cookie of setCookies) {
      this.jar.setCookieSync(cookie, url, { ignoreError: true })
    }
  }
}
