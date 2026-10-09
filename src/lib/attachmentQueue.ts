/**
 * The device outbox for record attachments — the bytes of a QC lab report or a
 * proof-of-delivery photo, held in IndexedDB until they reach R2.
 *
 * The record itself (its attachment's key, name and time) rides the ordinary
 * commit queue; only the bytes wait here. So an attach on a dead connection is
 * an ordinary save, and the file follows the moment the device is online and
 * signed in — through the same gate-then-PUT the compliance page uses
 * (/api/attachments/upload answers a presigned URL, the bytes go straight to
 * Cloudflare). A row is deleted only once R2 has accepted the bytes.
 *
 * What stops the drain, without counting against the file: no network, no
 * session (401), storage not configured yet (503), any other server trouble,
 * and an R2 refusal of the PUT — a missing CORS rule or a bad token is the
 * bucket's fault, not this file's, and every file would fail the same way. A
 * 403 is this file's (the role lost the area): it backs off and the next file
 * goes. A 400 means the gate will never take it. Either way a file that will
 * not upload keeps its bytes here, so it still opens on this device.
 */

export interface QueuedAttachment {
  /** The client-minted object key (attachmentRules.mintAttachmentKey) — also the row key. */
  path: string
  fileName: string
  contentType: string
  blob: Blob
  queuedAt: number
  attempts: number
  nextAttemptAt: number
  lastError?: string
}

/** What the outbox needs of a store — injectable so tests run without IndexedDB. */
export interface AttachmentStore {
  getAll(): Promise<QueuedAttachment[]>
  get(path: string): Promise<QueuedAttachment | undefined>
  /** False when the device refused to store it (private mode, quota, no IndexedDB). */
  put(item: QueuedAttachment): Promise<boolean>
  delete(path: string): Promise<void>
}

/** Past this, a file stops retrying and only opens locally. */
export const MAX_ATTEMPTS = 6

const DB_NAME = 'roligt-ops-attachments'
const STORE = 'outbox'
const MIN_WAIT_MS = 5_000
const MAX_WAIT_MS = 300_000

export function backoffMs(attempts: number): number {
  return Math.min(MAX_WAIT_MS, 30_000 * 2 ** Math.max(0, attempts))
}

/** The next file due: oldest first, skipping ones backing off or given up on. */
export function pickNext(items: QueuedAttachment[], now: number): QueuedAttachment | undefined {
  return items
    .filter((i) => i.attempts < MAX_ATTEMPTS && i.nextAttemptAt <= now)
    .sort((a, b) => a.queuedAt - b.queuedAt || (a.path < b.path ? -1 : 1))[0]
}

function idbStore(): AttachmentStore {
  let db: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'))
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'path' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('IndexedDB blocked'))
    }).catch((e: unknown) => {
      db = null // the next call tries again rather than inheriting one bad open
      throw e
    })
    return db
  }
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const conn = await open()
    return new Promise<T>((resolve, reject) => {
      const tx = conn.transaction(STORE, mode)
      const req = op(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  return {
    getAll: () => run('readonly', (s) => s.getAll() as IDBRequest<QueuedAttachment[]>).catch(() => []),
    get: (path) => run('readonly', (s) => s.get(path) as IDBRequest<QueuedAttachment | undefined>).catch(() => undefined),
    put: (item) => run('readwrite', (s) => s.put(item)).then(
      () => true,
      () => false,
    ),
    delete: (path) => run('readwrite', (s) => s.delete(path)).then(
      () => undefined,
      () => undefined,
    ),
  }
}

let store: AttachmentStore | null = null
const activeStore = (): AttachmentStore => (store ??= idbStore())

/** Swap the store (tests) — null goes back to IndexedDB. Also clears the drain state. */
export function setAttachmentStore(next: AttachmentStore | null): void {
  store = next
  resetAttachmentQueue()
}

let inflight: Promise<DrainResult> | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let started = false
/** Consecutive stopped drains — spaces out the retry timer while the bucket is unreachable. */
let stalls = 0

export function resetAttachmentQueue(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  inflight = null
  started = false
  stalls = 0
}

/** Keep these bytes until R2 has them. False: the device would not store them. */
export async function enqueueAttachment(item: {
  path: string
  fileName: string
  contentType: string
  blob: Blob
}): Promise<boolean> {
  const now = Date.now()
  const ok = await activeStore().put({ ...item, queuedAt: now, attempts: 0, nextAttemptAt: now })
  if (ok) void drainAttachmentQueue()
  return ok
}

/** The bytes of a file still waiting on this device, if it is one. */
export async function getQueuedBlob(path: string): Promise<Blob | null> {
  return (await activeStore().get(path))?.blob ?? null
}

type Outcome =
  | { kind: 'done' }
  | { kind: 'stop'; error: string }
  | { kind: 'retry'; error: string }
  | { kind: 'reject'; error: string }

async function errorOf(res: Response): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  return j.error ?? `HTTP ${res.status}`
}

async function uploadOne(item: QueuedAttachment): Promise<Outcome> {
  let gate: Response
  try {
    gate = await fetch('/api/attachments/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: item.path,
        fileName: item.fileName,
        contentType: item.contentType,
        sizeInBytes: item.blob.size,
      }),
    })
  } catch {
    return { kind: 'stop', error: 'offline' }
  }
  if (gate.status === 403) return { kind: 'retry', error: await errorOf(gate) }
  if (gate.status === 400 || gate.status === 415) return { kind: 'reject', error: await errorOf(gate) }
  if (!gate.ok) return { kind: 'stop', error: await errorOf(gate) }

  const signed = (await gate.json()) as { url: string; method: string; headers: Record<string, string> }
  try {
    const put = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: item.blob })
    if (!put.ok) return { kind: 'stop', error: `The file store refused the upload (HTTP ${put.status}).` }
  } catch {
    return { kind: 'stop', error: 'The file store could not be reached.' }
  }
  return { kind: 'done' }
}

export interface DrainResult {
  uploaded: number
  /** True when the drain halted on something that is not any one file's fault. */
  stopped: boolean
}

async function runDrain(): Promise<DrainResult> {
  const s = activeStore()
  let uploaded = 0
  let stopped = false
  for (;;) {
    const next = pickNext(await s.getAll(), Date.now())
    if (!next) break
    const outcome = await uploadOne(next)
    if (outcome.kind === 'done') {
      await s.delete(next.path)
      uploaded++
    } else if (outcome.kind === 'stop') {
      await s.put({ ...next, lastError: outcome.error })
      stopped = true
      break
    } else if (outcome.kind === 'retry') {
      await s.put({
        ...next,
        attempts: next.attempts + 1,
        nextAttemptAt: Date.now() + backoffMs(next.attempts),
        lastError: outcome.error,
      })
    } else {
      await s.put({ ...next, attempts: MAX_ATTEMPTS, lastError: outcome.error })
    }
  }
  stalls = stopped ? stalls + 1 : 0
  if (started) await arm(stopped)
  return { uploaded, stopped }
}

/** One retry timer, armed only while something is still worth retrying. */
async function arm(stopped: boolean): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = undefined
  const live = (await activeStore().getAll()).filter((i) => i.attempts < MAX_ATTEMPTS)
  if (!live.length) return
  const wait = stopped
    ? backoffMs(stalls - 1)
    : Math.min(...live.map((i) => i.nextAttemptAt)) - Date.now()
  timer = setTimeout(() => void drainAttachmentQueue(), Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, wait)))
}

/** Push every due file to R2. One drain at a time; a second call joins the first. */
export function drainAttachmentQueue(): Promise<DrainResult> {
  inflight ??= runDrain()
    .catch(() => ({ uploaded: 0, stopped: true }))
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Boot: drain what earlier sessions left, and again whenever the device comes back online. */
export function initAttachmentQueue(): void {
  if (started) return
  started = true
  if (typeof window !== 'undefined') window.addEventListener('online', () => void drainAttachmentQueue())
  void drainAttachmentQueue()
}
