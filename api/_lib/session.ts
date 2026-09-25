/**
 * The WorkOS AuthKit session, wrapped so the rest of the BFF never sees the
 * package: configure-from-env on first use, a Request-typed cookie storage
 * adapter, and every operation returning plain `Set-Cookie` strings for the
 * Vercel response to append — the package's documented contract is one header
 * per cookie, never comma-joined.
 *
 * The adapter is headers-only: every `response` parameter is passed undefined,
 * so the package hands back a HeadersBag instead of mutating a response object
 * we do not have. The one thing that MUST NOT be dropped: a refresh performed
 * inside `withAuth` re-seals the session, and those cookies have to travel
 * back on the same response — the data handlers forward `setCookies` for
 * exactly that reason, or the session would re-refresh on every request.
 */
import {
  CookieSessionStorage,
  configure,
  createAuthService,
  type AuthResult,
  type HeadersBag,
} from '@workos/authkit-session'

/** All three server env vars present — the cookie branch of authenticate() and the auth routes gate on this. */
export function workosConfigured(): boolean {
  return Boolean(
    process.env.WORKOS_CLIENT_ID &&
      process.env.WORKOS_API_KEY &&
      process.env.WORKOS_COOKIE_PASSWORD,
  )
}

let configuredOnce = false
function ensureConfigured(): void {
  if (configuredOnce) return
  configuredOnce = true
  configure({
    clientId: process.env.WORKOS_CLIENT_ID,
    apiKey: process.env.WORKOS_API_KEY,
    cookiePassword: process.env.WORKOS_COOKIE_PASSWORD,
    // The flow's redirect is derived per request (deriveRedirectUri) and sealed
    // into the PKCE state at sign-in, so this config value only drives
    // cookie-attribute inference — notably the session cookie's Secure flag.
    // WORKOS_REDIRECT_URI pins it; set it to the production callback so
    // production cookies carry Secure.
    redirectUri:
      process.env.WORKOS_REDIRECT_URI ?? 'http://localhost:3000/api/auth/callback',
    apiHostname: process.env.WORKOS_API_HOSTNAME ?? 'api.eu.workos.com',
    ...(process.env.WORKOS_COOKIE_NAME ? { cookieName: process.env.WORKOS_COOKIE_NAME } : {}),
  })
}

/**
 * Cookies out of a standard Request, headers back as values. getCookie MUST
 * URL-decode: the seal was written with encodeURIComponent, and PKCE state
 * verification byte-compares against the decoded original.
 */
export class VercelCookieSessionStorage extends CookieSessionStorage<Request, undefined> {
  override async getCookie(request: Request, name: string): Promise<string | null> {
    const header = request.headers.get('cookie')
    if (!header) return null
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      if (part.slice(0, eq).trim() !== name) continue
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
    return null
  }
}

const authService = createAuthService<Request, undefined>({
  sessionStorageFactory: (config) => new VercelCookieSessionStorage(config),
})

/** HeadersBag['Set-Cookie'] → one string per cookie, in order. */
export function setCookiesOf(bag?: HeadersBag): string[] {
  if (!bag) return []
  const raw = bag['Set-Cookie'] ?? bag['set-cookie']
  if (raw === undefined) return []
  return Array.isArray(raw) ? raw : [raw]
}

function hostProto(req: Request): { host: string; proto: string } {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000'
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || (local ? 'http' : 'https')
  return { host, proto }
}

/** The callback URL for this exact origin — sealed into the PKCE state at sign-in, recovered at callback. */
export function deriveRedirectUri(req: Request): string {
  const { host, proto } = hostProto(req)
  return `${proto}://${host}/api/auth/callback`
}

/** Validate the session cookie, refreshing the short-lived access token server-side. */
export async function withAuth(req: Request): Promise<{ auth: AuthResult; setCookies: string[] }> {
  ensureConfigured()
  const { auth, refreshedSessionData } = await authService.withAuth(req)
  if (!refreshedSessionData) return { auth, setCookies: [] }
  const { headers } = await authService.saveSession(undefined, refreshedSessionData)
  return { auth, setCookies: setCookiesOf(headers) }
}

/** The sign-in door: builds the hosted AuthKit URL and writes the PKCE verifier cookie. */
export async function createSignInUrl(
  req: Request,
  options: { returnPathname: string; organizationId?: string },
): Promise<{ url: string; setCookies: string[] }> {
  ensureConfigured()
  const { url, headers } = await authService.createSignIn(undefined, {
    returnPathname: options.returnPathname,
    redirectUri: deriveRedirectUri(req),
    ...(options.organizationId ? { organizationId: options.organizationId } : {}),
  })
  return { url, setCookies: setCookiesOf(headers) }
}

/** Exchange the callback code server-side and seal the session cookie. */
export async function handleAuthCallback(
  req: Request,
  options: { code: string; state?: string },
): Promise<{ returnPathname: string; setCookies: string[] }> {
  ensureConfigured()
  const { headers, returnPathname } = await authService.handleCallback(req, undefined, {
    code: options.code,
    state: options.state,
  })
  return { returnPathname, setCookies: setCookiesOf(headers) }
}

/** Best-effort verifier cleanup for a failed callback, so the state cookie cannot linger its full TTL. */
export async function clearVerifierCookies(req: Request, state: string): Promise<string[]> {
  ensureConfigured()
  const { headers } = await authService.clearPendingVerifier(undefined, {
    state,
    redirectUri: deriveRedirectUri(req),
  })
  return setCookiesOf(headers)
}

/** End the session at WorkOS and locally; the logout URL lands on a registered post-logout redirect. */
export async function signOutUrl(
  req: Request,
): Promise<{ logoutUrl: string | null; setCookies: string[] }> {
  if (!workosConfigured()) return { logoutUrl: null, setCookies: [] }
  ensureConfigured()
  let sessionId: string | null = null
  try {
    const { auth } = await authService.withAuth(req)
    if (auth.user) sessionId = auth.sessionId
  } catch {
    // unreadable seal — clear the cookie anyway below
  }
  if (!sessionId) {
    const { headers } = await authService.clearSession(undefined)
    return { logoutUrl: null, setCookies: setCookiesOf(headers) }
  }
  const { host, proto } = hostProto(req)
  const { logoutUrl, headers } = await authService.signOut(sessionId, { returnTo: `${proto}://${host}/` })
  return { logoutUrl, setCookies: setCookiesOf(headers) }
}

/** The sealed session cookie's name. */
export function sessionCookieName(): string {
  return process.env.WORKOS_COOKIE_NAME || 'wos-session'
}
