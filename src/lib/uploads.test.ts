import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachmentPath, signedUrlFor, uploadAttachment } from './uploads.ts'
import { setAttachmentStore, type AttachmentStore, type QueuedAttachment } from './attachmentQueue.ts'
import { setUnauthorizedHandler } from './authEvents.ts'
import { UnauthorizedError } from './dbApi.ts'

function memoryStore(refuse = false) {
  const rows = new Map<string, QueuedAttachment>()
  const store: AttachmentStore = {
    getAll: async () => [...rows.values()],
    get: async (path) => rows.get(path),
    put: async (item) => {
      if (refuse) return false
      rows.set(item.path, item)
      return true
    },
    delete: async (path) => void rows.delete(path),
  }
  return { store, rows }
}

const pdf = (name = 'report.pdf', type = 'application/pdf', bytes = '%PDF-1.4') => new File([bytes], name, { type })

/** Every network call parks on a 503 unless a test says otherwise. */
let fetchMock: ReturnType<typeof vi.fn>
let mem: ReturnType<typeof memoryStore>
beforeEach(() => {
  mem = memoryStore()
  setAttachmentStore(mem.store)
  fetchMock = vi.fn(async () => new Response('{}', { status: 503 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  setAttachmentStore(null)
  setUnauthorizedHandler(null)
  vi.unstubAllGlobals()
})

describe('uploadAttachment', () => {
  it('mints an area key, queues the bytes and reports them durable', async () => {
    const up = await uploadAttachment(pdf(), 'qc', 'QC-1.micro')
    expect(up.path).toMatch(/^attachments\/qc\/QC-1\.micro-[a-z0-9]+-[a-z0-9]{6}-report\.pdf$/)
    expect(up).toMatchObject({ fileName: 'report.pdf', url: '', sessionOnly: false })
    expect(mem.rows.get(up.path!)).toMatchObject({ fileName: 'report.pdf', contentType: 'application/pdf' })
  })

  it('marks the file session-only when the device will not keep it', async () => {
    setAttachmentStore(memoryStore(true).store)
    const up = await uploadAttachment(pdf(), 'pod', 'DSP-1')
    expect(up.sessionOnly).toBe(true)
    // still opens for the rest of the session
    expect(await signedUrlFor(up)).toMatch(/^blob:/)
  })

  it('stores an unlabelled PDF as application/pdf', async () => {
    const up = await uploadAttachment(pdf('scan.PDF', ''), 'qc', 'r')
    expect(mem.rows.get(up.path!)?.contentType).toBe('application/pdf')
  })

  it('refuses other file types and anything over 12 MB', async () => {
    await expect(uploadAttachment(pdf('x.exe', 'application/octet-stream'), 'qc', 'r')).rejects.toThrow(
      'Only PDF or image files are allowed.',
    )
    const big = pdf()
    Object.defineProperty(big, 'size', { value: 12 * 1024 * 1024 + 1 })
    await expect(uploadAttachment(big, 'qc', 'r')).rejects.toThrow('File must be under 12 MB.')
  })
})

describe('signedUrlFor', () => {
  it('says so when a record has no file at all', async () => {
    await expect(signedUrlFor({ url: '/reports/LR-1' })).rejects.toThrow('That report has no file attached any more.')
  })

  it('opens a file still waiting in the outbox without asking the server for it', async () => {
    const key = 'attachments/qc/queued-1-aaaaaa-r.pdf'
    mem.rows.set(key, {
      path: key,
      fileName: 'r.pdf',
      contentType: 'application/pdf',
      blob: new Blob(['x']),
      queuedAt: 0,
      attempts: 0,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    })
    expect(await signedUrlFor({ path: key })).toMatch(/^blob:/)
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/attachments/file'))).toBe(false)
  })

  it('names the two kinds of pre-store keys without touching the network', async () => {
    await expect(signedUrlFor({ path: 'qc-QC-1-micro-lx2-r.pdf' })).rejects.toThrow(/never uploaded/)
    await expect(
      signedUrlFor({ url: 'https://x.supabase.co/storage/v1/object/public/qc-reports/a%20b.pdf' }),
    ).rejects.toThrow(/old storage/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches a stored file through the gate once, then serves it from memory', async () => {
    fetchMock.mockImplementation(async () => new Response(new Blob(['%PDF']), { status: 200 }))
    const key = 'attachments/qc/remote-1-bbbbbb-r.pdf'
    expect(await signedUrlFor({ path: key })).toMatch(/^blob:/)
    expect(fetchMock).toHaveBeenCalledWith(`/api/attachments/file?path=${encodeURIComponent(key)}`, {
      credentials: 'same-origin',
    })
    await signedUrlFor({ path: key })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [404, 'Not uploaded yet — this file is still waiting on the device that added it.'],
    [403, 'You do not have permission to open this file.'],
    [503, 'Attachment storage is not configured yet.'],
    [500, 'The file could not be opened (HTTP 500).'],
  ])('explains a %i', async (status, message) => {
    fetchMock.mockImplementation(async () => new Response('{}', { status }))
    await expect(signedUrlFor({ path: `attachments/pod/s${status}-1-cccccc-p.jpg` })).rejects.toThrow(message)
  })

  it('treats a 401 as the session ending', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }))
    await expect(signedUrlFor({ path: 'attachments/qc/u-1-dddddd-r.pdf' })).rejects.toBeInstanceOf(UnauthorizedError)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('says the connection failed when the fetch itself does', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(signedUrlFor({ path: 'attachments/qc/n-1-eeeeee-r.pdf' })).rejects.toThrow(/check the connection/)
  })
})

describe('attachmentPath', () => {
  it('prefers the key and recovers one from a Supabase-era public URL', () => {
    expect(attachmentPath({ path: 'attachments/qc/x.pdf', url: 'ignored' })).toBe('attachments/qc/x.pdf')
    expect(attachmentPath({ url: 'https://x.supabase.co/storage/v1/object/public/qc-reports/a%20b.pdf' })).toBe('a b.pdf')
    expect(attachmentPath({ url: '/reports/LR-1' })).toBeNull()
  })
})
