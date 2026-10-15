import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueOutbox,
  flushOutbox,
  isFinalRefusal,
  noteOutboxError,
  outboxAll,
  outboxFor,
  removeOutbox,
} from './shipmentOutbox.ts'

const store = new Map<string, string>()

afterEach(() => {
  store.clear()
  vi.restoreAllMocks()
})

// localStorage stands in — the module's contract is "survives, small, best-effort".
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})

const started = { id: 'event:S-1:started', kind: 'event' as const, shipmentId: 'S-1', key: 'evt-1', body: { type: 'started' } }

describe('shipmentOutbox', () => {
  it('parks an intent with its born idempotency key; a double-tap adds nothing', () => {
    const first = enqueueOutbox(started)
    const again = enqueueOutbox({ ...started, key: 'evt-OTHER' })
    expect(again).toEqual(first) // the standing intent wins, key untouched
    expect(outboxAll()).toHaveLength(1)
    expect(outboxFor('S-1')[0].key).toBe('evt-1')
  })

  it('flushes oldest first, removes what landed, keeps what did not', async () => {
    enqueueOutbox(started)
    const later = enqueueOutbox({ ...started, id: 'event:S-1:arrived', key: 'evt-2', body: { type: 'arrived' } })
    const order: string[] = []
    const out = await flushOutbox(async (i) => {
      order.push(i.id)
      return i.id !== later.id // the second one "fails"
    })
    expect(order).toEqual(['event:S-1:started', 'event:S-1:arrived'])
    expect(out).toEqual({ shipped: 1, remaining: 1 })
    expect(outboxAll()[0].id).toBe('event:S-1:arrived')
  })

  it('a throwing shipper stops the flush and notes the error', async () => {
    enqueueOutbox(started)
    const out = await flushOutbox(async () => {
      throw new Error('offline')
    })
    expect(out).toEqual({ shipped: 0, remaining: 1 })
    expect(outboxAll()[0].attempts).toBe(1)
    expect(outboxAll()[0].lastError).toBe('offline')
  })

  it('removeOutbox clears a queued intent (a done submit)', () => {
    enqueueOutbox(started)
    removeOutbox(started.id)
    expect(outboxAll()).toHaveLength(0)
  })

  it('the final refusals never retry — the same body would refuse again', () => {
    expect(isFinalRefusal('This trip is already submitted.')).toBe(true)
    expect(isFinalRefusal('already used with a different request body')).toBe(true)
    expect(isFinalRefusal('FG-TCW-250 from lot B-9 was not on this trip.')).toBe(true)
    expect(isFinalRefusal('Could not send.')).toBe(false)
    expect(isFinalRefusal('offline')).toBe(false)
  })

  it('a refusing device (quota/private mode) reads as an empty queue, never a crash', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('quota')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => undefined,
    })
    expect(outboxAll()).toEqual([])
    expect(() => noteOutboxError('x', 'e')).not.toThrow()
  })
})
