import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_ATTEMPTS,
  backoffMs,
  drainAttachmentQueue,
  enqueueAttachment,
  getQueuedBlob,
  pickNext,
  setAttachmentStore,
  type AttachmentStore,
  type QueuedAttachment,
} from './attachmentQueue.ts'

/** IndexedDB does not exist under node — an in-memory store with the same contract. */
function memoryStore(refuse = false) {
  const rows = new Map<string, QueuedAttachment>()
  const store: AttachmentStore = {
    getAll: async () => [...rows.values()].map((r) => ({ ...r })),
    get: async (path) => rows.get(path),
    put: async (item) => {
      if (refuse) return false
      rows.set(item.path, { ...item })
      return true
    },
    delete: async (path) => void rows.delete(path),
  }
  return { store, rows }
}

const item = (path: string, over: Partial<QueuedAttachment> = {}): QueuedAttachment => ({
  path,
  fileName: `${path}.pdf`,
  contentType: 'application/pdf',
  blob: new Blob(['%PDF']),
  queuedAt: 0,
  attempts: 0,
  nextAttemptAt: 0,
  ...over,
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fetch that answers the gate with `gate(path)` and every PUT with `put()`. */
function stubFetch(gate: (path: string) => Response | Error, put: () => Response | Error = () => new Response(null, { status: 200 })) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/attachments/upload') {
      const path = JSON.parse(String(init?.body)).path as string
      calls.push(`gate:${path}`)
      const r = gate(path)
      if (r instanceof Error) throw r
      return r
    }
    calls.push(`put:${url}`)
    const r = put()
    if (r instanceof Error) throw r
    return r
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}

const signed = (path: string) => json(200, { path, url: `https://r2/${path}`, method: 'PUT', headers: { 'content-type': 'application/pdf' } })

let mem: ReturnType<typeof memoryStore>
beforeEach(() => {
  mem = memoryStore()
  setAttachmentStore(mem.store)
})
afterEach(() => {
  setAttachmentStore(null)
  vi.unstubAllGlobals()
})

describe('attachment outbox — pure rules', () => {
  it('backs off 30 s doubling, capped at 5 minutes', () => {
    expect([0, 1, 2, 3, 4, 10].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000])
  })

  it('picks the oldest due file, skipping ones backing off or given up on', () => {
    const items = [
      item('late', { queuedAt: 3 }),
      item('waiting', { queuedAt: 1, nextAttemptAt: 10_000 }),
      item('capped', { queuedAt: 0, attempts: MAX_ATTEMPTS }),
      item('due', { queuedAt: 2 }),
    ]
    expect(pickNext(items, 5_000)?.path).toBe('due')
    expect(pickNext(items, 10_000)?.path).toBe('waiting')
    expect(pickNext([item('capped', { attempts: MAX_ATTEMPTS })], 0)).toBeUndefined()
  })
})

describe('attachment outbox — drain', () => {
  it('posts the key to the gate, PUTs the bytes to R2, then forgets the file', async () => {
    const { calls, fn } = stubFetch((p) => signed(p))
    mem.rows.set('a', item('a'))
    expect(await drainAttachmentQueue()).toEqual({ uploaded: 1, stopped: false })
    expect(calls).toEqual(['gate:a', 'put:https://r2/a'])
    expect(JSON.parse(String(fn.mock.calls[0][1]?.body))).toEqual({
      path: 'a',
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      sizeInBytes: 4,
    })
    expect(mem.rows.size).toBe(0)
  })

  it('uploads oldest first', async () => {
    const { calls } = stubFetch((p) => signed(p))
    mem.rows.set('b', item('b', { queuedAt: 2 }))
    mem.rows.set('a', item('a', { queuedAt: 1 }))
    await drainAttachmentQueue()
    expect(calls.filter((c) => c.startsWith('gate'))).toEqual(['gate:a', 'gate:b'])
  })

  for (const [label, gate] of [
    ['no network', () => new TypeError('Failed to fetch')],
    ['no session (401)', () => json(401, { error: 'Not signed in.' })],
    ['storage not configured (503)', () => json(503, { error: 'Attachment storage is not configured (R2 env missing).' })],
  ] as const) {
    it(`stops on ${label} without counting it against the file`, async () => {
      const { calls } = stubFetch(gate)
      mem.rows.set('a', item('a', { queuedAt: 1 }))
      mem.rows.set('b', item('b', { queuedAt: 2 }))
      expect(await drainAttachmentQueue()).toEqual({ uploaded: 0, stopped: true })
      expect(calls).toEqual(['gate:a'])
      expect(mem.rows.get('a')?.attempts).toBe(0)
      expect(mem.rows.get('a')?.lastError).toBeTruthy()
    })
  }

  it('stops when R2 refuses the PUT — the bucket is at fault, not the file', async () => {
    stubFetch((p) => signed(p), () => new Response('cors', { status: 403 }))
    mem.rows.set('a', item('a', { queuedAt: 1 }))
    mem.rows.set('b', item('b', { queuedAt: 2 }))
    expect(await drainAttachmentQueue()).toEqual({ uploaded: 0, stopped: true })
    expect(mem.rows.get('a')).toMatchObject({ attempts: 0, lastError: 'The file store refused the upload (HTTP 403).' })
    expect(mem.rows.has('b')).toBe(true)
  })

  it('backs a 403 file off and moves on to the next', async () => {
    const { calls } = stubFetch((p) => (p === 'a' ? json(403, { error: 'no' }) : signed(p)))
    mem.rows.set('a', item('a', { queuedAt: 1 }))
    mem.rows.set('b', item('b', { queuedAt: 2 }))
    const before = Date.now()
    expect(await drainAttachmentQueue()).toEqual({ uploaded: 1, stopped: false })
    expect(calls).toEqual(['gate:a', 'gate:b', 'put:https://r2/b'])
    const a = mem.rows.get('a')!
    expect(a.attempts).toBe(1)
    expect(a.nextAttemptAt).toBeGreaterThanOrEqual(before + 30_000)
    expect(a.lastError).toBe('no')
  })

  it('gives up on a file the gate will never take (400) but keeps its bytes', async () => {
    stubFetch(() => json(400, { error: 'Only PDF or image files are allowed.' }))
    mem.rows.set('a', item('a'))
    await drainAttachmentQueue()
    expect(mem.rows.get('a')).toMatchObject({ attempts: MAX_ATTEMPTS, lastError: 'Only PDF or image files are allowed.' })
    expect(await getQueuedBlob('a')).toBeInstanceOf(Blob)
  })

  it('runs one drain at a time — a second call joins the first', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const fn = vi.fn(async (url: string) => {
      if (url === '/api/attachments/upload') {
        await held
        return signed('a')
      }
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fn)
    mem.rows.set('a', item('a'))
    const first = drainAttachmentQueue()
    const second = drainAttachmentQueue()
    expect(second).toBe(first)
    release()
    await first
    expect(fn.mock.calls.filter(([u]) => u === '/api/attachments/upload')).toHaveLength(1)
  })
})

describe('attachment outbox — enqueue', () => {
  it('stores the bytes and starts a drain', async () => {
    const { calls } = stubFetch(() => json(503, {}))
    expect(await enqueueAttachment({ path: 'k', fileName: 'r.pdf', contentType: 'application/pdf', blob: new Blob(['x']) })).toBe(true)
    await drainAttachmentQueue()
    expect(calls).toContain('gate:k')
    expect(mem.rows.get('k')).toMatchObject({ attempts: 0, fileName: 'r.pdf' })
    expect(await getQueuedBlob('k')).toBeInstanceOf(Blob)
    expect(await getQueuedBlob('missing')).toBeNull()
  })

  it('says so when the device refuses to store it', async () => {
    setAttachmentStore(memoryStore(true).store)
    const fn = stubFetch(() => json(503, {})).fn
    expect(await enqueueAttachment({ path: 'k', fileName: 'r.pdf', contentType: 'application/pdf', blob: new Blob(['x']) })).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })
})
