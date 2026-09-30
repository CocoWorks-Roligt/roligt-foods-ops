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

const makeAuthService = (redirectUri?: string) =>
  createAuthService<Request, undefined>({
    // only the SCHEME of the config's redirectUri ever reaches the storage (it
    // is what the cookie's Secure flag is baked from, at construction); the
    // spread below re-bakes that flag and touches nothing else
    sessionStorageFactory: (config) =>
      new VercelCookieSessionStorage(redirectUri ? { ...config, redirectUri } : config),
  })

const authService = makeAuthService()

/**
 * The service that seals THIS request's cookies. The storage instance bakes the
 * session cookie's Secure flag from the configured redirectUri's scheme —
 * WORKOS_REDIRECT_URI, defaulting to the http localhost callback — so a deploy
 * that omits the env var silently strips Secure off every cookie it seals. The
 * request's own protocol is the truth the env var only approximates: a request
 * that arrived over https while the effective redirectUri is http-prefixed is
 * served by a second service, its storage built over an https URI so Secure is
 * baked in. Memoized — the URI's host is never read, so one https variant
 * speaks for every https host — while plain-http dev traffic and an https env
 * pin keep the default service exactly as it was.
 */
let secureAuthService: ReturnType<typeof makeAuthService> | null = null
export function authServiceFor(req: Request) {
  const configured = process.env.WORKOS_REDIRECT_URI ?? 'http://localhost:3000/api/auth/callback'
  if (configured.startsWith('https://')) return authService
  const { host, proto } = hostProto(req)
  if (proto !== 'https') return authService
  if (!secureAuthService) secureAuthService = makeAuthService(`https://${host}/api/auth/callback`)
  return secureAuthService
}

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
  const service = authServiceFor(req)
  const { auth, refreshedSessionData } = await service.withAuth(req)
  if (!refreshedSessionData) return { auth, setCookies: [] }
  const { headers } = await service.saveSession(undefined, refreshedSessionData)
  return { auth, setCookies: setCookiesOf(headers) }
}

/** The sign-in door: builds the hosted AuthKit URL and writes the PKCE verifier cookie. */
export async function createSignInUrl(
  req: Request,
  options: { returnPathname: string; organizationId?: string },
): Promise<{ url: string; setCookies: string[] }> {
  ensureConfigured()
  const { url, headers } = await authServiceFor(req).createSignIn(undefined, {
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
  const { headers, returnPathname } = await authServiceFor(req).handleCallback(req, undefined, {
    code: options.code,
    state: options.state,
  })
  return { returnPathname, setCookies: setCookiesOf(headers) }
}

/** Best-effort verifier cleanup for a failed callback, so the state cookie cannot linger its full TTL. */
export async function clearVerifierCookies(req: Request, state: string): Promise<string[]> {
  ensureConfigured()
  const { headers } = await authServiceFor(req).clearPendingVerifier(undefined, {
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
  const service = authServiceFor(req)
  let sessionId: string | null = null
  try {
    const { auth } = await service.withAuth(req)
    if (auth.user) sessionId = auth.sessionId
  } catch {
    // unreadable seal — clear the cookie anyway below
  }
  if (!sessionId) {
    const { headers } = await service.clearSession(undefined)
    return { logoutUrl: null, setCookies: setCookiesOf(headers) }
  }
  const { host, proto } = hostProto(req)
  const { logoutUrl, headers } = await service.signOut(sessionId, { returnTo: `${proto}://${host}/` })
  return { logoutUrl, setCookies: setCookiesOf(headers) }
}

/** The sealed session cookie's name. */
export function sessionCookieName(): string {
  return process.env.WORKOS_COOKIE_NAME || 'wos-session'
}
