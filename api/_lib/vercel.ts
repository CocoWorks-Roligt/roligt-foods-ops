import type { VercelRequest } from '@vercel/node'

/** Vercel's req → standard Request, for the auth guard. */
export function toWebRequest(req: VercelRequest): Request {
  const url = `https://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  })
}
