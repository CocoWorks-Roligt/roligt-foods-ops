import type { VercelRequest } from '@vercel/node'

/** Vercel's req → standard Request, for the auth guard. */
export function toWebRequest(req: VercelRequest): Request {
  const url = `https://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  })
}

/**
 * A Location header that can only stay on this origin: '/…' but never '//host'
 * or '/\host' — both of those are scheme-relative URLs a browser would follow
 * off-site. Everything the auth routes redirects to passes through here, on the
 * way in (?return=) and on the way out (the state-sealed return path).
 */
export function siteRelative(path: string | null | undefined, fallback = '/'): string {
  if (!path) return fallback
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
    ? path
    : fallback
}
