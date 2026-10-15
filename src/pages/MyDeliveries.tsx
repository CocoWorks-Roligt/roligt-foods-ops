/**
 * My Deliveries — the delivery agent's own app (SHIPMENT S2, mobile-first,
 * the only page the external `delivery_agent` tier ever holds).
 *
 * Reads: the agent's own trips (/api/shipments scopes by session email),
 * cached on the device so a morning round still shows with no bars. Writes:
 * `started`/`arrived` events and the ONE submit that closes a trip — each
 * parked, when offline, in the intent outbox (shipmentOutbox.ts) under the
 * Idempotency-Key it was born with, so a retry hours later is the same
 * intent on the server, never a second challan. Photos and the signature
 * PNG are attachment bytes (area `delivery`): the key is minted on the
 * device, travels in the submit, and the bytes drain through the attachment
 * outbox the moment the device is online — the record never waits on them.
 *
 * The `shipments` flag off is a card that says so — never a redirect: this
 * page is the agent's whole app, and a bounce would loop.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StatusBadge } from '../components/StatusBadge'
import { SignaturePad } from '../components/shell/SignaturePad'
import { useApp } from '../context/AppContext'
import { usePwa } from '../context/PwaContext'
import { postDeliveryEventCall, submitDeliveryCall, fetchShipments, PoApiError } from '../lib/shipmentApi'
import {
  canSubmitDelivery,
  draftLines,
  emptySignature,
  lineError,
  signatureError,
  submitBody,
  type DeliveryLineDraft,
  type SignatureDraft,
} from '../lib/deliveryDraft'
import {
  enqueueOutbox,
  flushOutbox,
  isFinalRefusal,
  noteOutboxError,
  outboxAll,
  type OutboxIntent,
} from '../lib/shipmentOutbox'
import { uploadAttachment } from '../lib/uploads'
import { useRevisionFeed } from '../lib/useRevisionFeed'
import type { DeliveryEventRequest, ShipmentDetail, SubmitDeliveryRequest } from '../lib/contracts'

/** The device cache — the list a morning round can still read offline. */
const CACHE_KEY = 'my-deliveries-cache-v1'
const CACHE_TTL_MS = 18 * 60 * 60 * 1000 // one working day; older reads as absent

interface CacheShape {
  at: number
  details: ShipmentDetail[]
}

function readCache(): ShipmentDetail[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as CacheShape
    return Date.now() - parsed.at < CACHE_TTL_MS && Array.isArray(parsed.details) ? parsed.details : []
  } catch {
    return []
  }
}

function writeCache(details: ShipmentDetail[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), details } satisfies CacheShape))
  } catch {
    // A device that will not cache simply refetches; the round keeps going.
  }
}

/** The statuses the agent can still move a trip from. */
const ACTIONABLE = new Set(['Created', 'Dispatched', 'Out for Delivery', 'Rescheduled'])

/** One intent's id — one started per trip, one submit per trip, forever. */
const intentId = (kind: OutboxIntent['kind'], shipmentId: string, what: string) => `${kind}:${shipmentId}:${what}`

/** Best-effort GPS — optional by design, never worth a wait at the door. */
function gps(): Promise<DeliveryEventRequest['gps']> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(undefined)
    const timer = setTimeout(() => resolve(undefined), 2500)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer)
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude })
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
      { timeout: 2000 },
    )
  })
}

export function MyDeliveries() {
  const { flags } = useApp()
  const { offline } = usePwa()

  // The list: the server's when reachable, yesterday's cache when not.
  const [details, setDetails] = useState<ShipmentDetail[]>(() => readCache())
  const [stale, setStale] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await fetchShipments()
      setDetails(list)
      writeCache(list)
      setStale(false)
      setListError(null)
    } catch (e) {
      setStale(true)
      setListError(e instanceof Error ? e.message : 'Could not load your trips.')
    }
  }, [])
  useEffect(() => {
    if (!offline) void load()
  }, [offline, load])
  useRevisionFeed(useCallback(() => void load(), [load]))

  // The outbox: what is still owed to the server, flushed the moment the
  // device is back. A final refusal (already submitted, replay mismatch) is
  // REMOVED — the same body would refuse again — and the list refresh shows
  // the server's truth instead.
  const [pending, setPending] = useState<readonly OutboxIntent[]>(() => outboxAll())
  const [lastError, setLastError] = useState<string | null>(null)
  const ship = useCallback(async (intent: OutboxIntent): Promise<boolean> => {
    try {
      if (intent.kind === 'event') {
        await postDeliveryEventCall(intent.shipmentId, intent.body as unknown as DeliveryEventRequest, intent.key)
      } else {
        await submitDeliveryCall(intent.shipmentId, intent.body as unknown as SubmitDeliveryRequest, intent.key)
      }
      return true
    } catch (e) {
      if (!(e instanceof PoApiError)) throw e // offline/unknown — keep it, try later
      if (isFinalRefusal(e.message)) return true
      noteOutboxError(intent.id, e.message)
      setLastError(e.message)
      return false
    }
  }, [])
  const flush = useCallback(async () => {
    const out = await flushOutbox(ship)
    setPending(outboxAll())
    if (out.shipped > 0) await load()
  }, [ship, load])
  useEffect(() => {
    if (!offline) void flush()
  }, [offline, flush])

  /** Post an event now when online; park it when not — same born key either way. */
  const sendEvent = useCallback(
    async (shipmentId: string, what: string, body: DeliveryEventRequest) => {
      const intent = enqueueOutbox({
        id: intentId('event', shipmentId, what),
        kind: 'event',
        shipmentId,
        key: `evt-${shipmentId}-${what}-${Date.now().toString(36)}`,
        body: body as unknown as Record<string, unknown>,
      })
      setPending(outboxAll())
      if (offline) return
      try {
        await postDeliveryEventCall(shipmentId, body, intent.key)
        await load()
      } catch {
        // it stays parked; the flush owns the retry
      }
    },
    [offline, load],
  )

  // The open trip.
  const [openId, setOpenId] = useState<string | null>(null)
  const open = useMemo(() => details.find((d) => d.shipment.id === openId) ?? null, [details, openId])
  const [lines, setLines] = useState<DeliveryLineDraft[]>([])
  const [signature, setSignature] = useState<SignatureDraft>(emptySignature())
  const [ink, setInk] = useState<string | null>(null) // the pad's PNG, until it is uploaded
  const [busy, setBusy] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  /** Opening a trip seeds the draft off the detail in hand — the fresh
   *  fetches that follow never wipe a half-confirmed round. */
  const openTrip = (d: ShipmentDetail) => {
    setOpenId(d.shipment.id)
    setLines(draftLines(d))
    setSignature(emptySignature())
    setInk(null)
    setDone(false)
    setFlowError(null)
  }

  const setLine = (i: number, over: Partial<DeliveryLineDraft>) =>
    setLines((prev) => prev.map((l, at) => (at === i ? { ...l, ...over } : l)))

  const attachPhoto = async (i: number, file: File) => {
    setBusy(true)
    setFlowError(null)
    try {
      const up = await uploadAttachment(file, 'delivery', `${openId}.${lines[i].dispatchId}.rejected`)
      setLine(i, { photoKey: up.path! })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'The photo could not be kept on this device.')
    } finally {
      setBusy(false)
    }
  }

  /** Start the trip — walks whatever the board left un-walked (the server's
   *  `started` event never strands an agent). */
  const start = async () => {
    if (!open) return
    await sendEvent(open.shipment.id, 'started', { type: 'started', gps: await gps() })
  }
  const arrive = async () => {
    if (!open) return
    await sendEvent(open.shipment.id, 'arrived', { type: 'arrived', gps: await gps() })
  }

  /** The submit's gate counts the ink on the pad — the upload happens on the
   *  press, and only its key travels. */
  const gateSignature: SignatureDraft =
    ink && !signature.signatureKey ? { ...signature, signatureKey: 'ink-on-pad' } : signature

  const submit = async () => {
    if (!open || !canSubmitDelivery(lines, gateSignature)) return
    setBusy(true)
    setFlowError(null)
    try {
      let sig = signature
      // The ink becomes bytes first — its key is what travels in the submit.
      if (ink && !sig.signatureKey) {
        const blob = await (await fetch(ink)).blob()
        const up = await uploadAttachment(
          new File([blob], 'signature.png', { type: 'image/png' }),
          'delivery',
          `${open.shipment.id}.signature`,
        )
        sig = { ...sig, signatureKey: up.path! }
        setSignature(sig)
      }
      await send(open.shipment.id, submitBody(lines, sig))
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'The delivery could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  /** The submit: out of the door now when online, parked with its born key when not. */
  const send = async (shipmentId: string, body: SubmitDeliveryRequest) => {
    const intent = enqueueOutbox({
      id: intentId('submit', shipmentId, 'submit'),
      kind: 'submit',
      shipmentId,
      key: `sub-${shipmentId}-${Date.now().toString(36)}`,
      body: body as unknown as Record<string, unknown>,
    })
    setPending(outboxAll())
    if (offline) {
      setDone(true)
      return
    }
    try {
      await submitDeliveryCall(shipmentId, body, intent.key)
      setDone(true)
      await load()
    } catch (e) {
      if (e instanceof PoApiError && isFinalRefusal(e.message)) {
        setDone(true) // the server already has this delivery — its truth stands
        await load()
        return
      }
      setFlowError(e instanceof Error ? e.message : 'The delivery could not be recorded. It stays queued on this device.')
    }
  }

  // ── the flag-off card ─────────────────────────────────────────────────────
  if (!flags.shipments) {
    return (
      <div className="card">
        <div className="section-head">
          <div>
            <h3>My Deliveries</h3>
            <span>Not switched on yet</span>
          </div>
        </div>
        <p>Deliveries are not running through the app yet — the office will tell you when they are.</p>
      </div>
    )
  }

  // ── the list ──────────────────────────────────────────────────────────────
  if (!open) {
    return (
      <div className="card my-deliveries">
        <div className="section-head">
          <div>
            <h3>My Deliveries</h3>
            <span>{offline ? 'Offline — showing this device\'s last list' : 'Your trips for today'}</span>
          </div>
        </div>

        {pending.length > 0 ? (
          <p className="sync-banner" role="status">
            {pending.length} {pending.length === 1 ? 'delivery waits' : 'deliveries wait'} to sync
            {offline ? ' — they go when you are back online' : ''}
            {lastError ? <span className="cell-sub"> · last try: {lastError}</span> : null}
          </p>
        ) : null}
        {stale && details.length === 0 ? (
          <p>{listError ?? 'No trips on this device yet — they appear once you are online.'}</p>
        ) : details.length === 0 ? (
          <p>No trips assigned to you yet.</p>
        ) : (
          details.map((d) => (
            <button key={d.shipment.id} type="button" className="trip-card" onClick={() => openTrip(d)}>
              <span className="trip-card-head">
                <strong>{d.shipment.stops[0]?.customerName ?? d.shipment.orderId}</strong>
                {d.shipment.stops.length > 1 ? <span> +{d.shipment.stops.length - 1} more stops</span> : null}
              </span>
              <span className="trip-card-sub">
                {d.shipment.vehicle} · {d.lines.length} line{d.lines.length === 1 ? '' : 's'}
                {d.shipment.eta ? ` · by ${d.shipment.eta}` : ''}
              </span>
              <StatusBadge value={d.shipment.status} />
            </button>
          ))
        )}
      </div>
    )
  }

  // ── the open trip ─────────────────────────────────────────────────────────
  const actionable = ACTIONABLE.has(open.shipment.status)
  // A `started` still parked (offline) means the walk is owed to the server in
  // flush order before the submit — the confirm flow opens straight away.
  const startedPending = pending.some((p) => p.shipmentId === open.shipment.id && p.body.type === 'started')
  const outOrStarting = open.shipment.status === 'Out for Delivery' || startedPending
  return (
    <div className="card my-deliveries">
      <div className="section-head">
        <div>
          <h3>{open.shipment.stops[0]?.customerName ?? open.shipment.orderId}</h3>
          <span>
            {open.shipment.vehicle} · {open.shipment.status}
          </span>
        </div>
        <button type="button" className="btn" onClick={() => setOpenId(null)}>
          Back
        </button>
      </div>

      {open.shipment.stops.map((s, i) => (
        <p key={`${s.customerId}-${i}`} className="trip-stop">
          <strong>{s.customerName}</strong>
          <br />
          {s.address}
        </p>
      ))}

      {done ? (
        <>
          <p className="sync-banner" role="status">
            {offline
              ? 'Recorded on this device — it syncs when you are back online.'
              : 'Delivery recorded. The challan is with the office.'}
          </p>
          <button type="button" className="btn" onClick={() => setOpenId(null)}>
            Back to my trips
          </button>
        </>
      ) : !actionable ? (
        <>
          <p>This trip is {open.shipment.status.toLowerCase()} — the office owns what happens next.</p>
          <button type="button" className="btn" onClick={() => setOpenId(null)}>
            Back
          </button>
        </>
      ) : (
        <>
          {!outOrStarting ? (
            <div className="stack">
              <button type="button" className="btn btn-primary" onClick={() => void start()}>
                Start delivery
              </button>
              <button type="button" className="btn" onClick={() => void arrive()}>
                I&apos;m at the door
              </button>
            </div>
          ) : (
            <>
              <div className="stack">
                {lines.map((l, i) => {
                  const err = lineError(l)
                  return (
                    <div key={l.dispatchId} className={`line-confirm${err ? ' line-error' : ''}`}>
                      <div className="line-confirm-head">
                        <strong>{l.sku}</strong>
                        <span className="cell-sub">lot {l.lot} · {l.qty} out</span>
                      </div>
                      <label>
                        Delivered
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={l.qty}
                          value={l.qtyDelivered}
                          onChange={(e) => setLine(i, { qtyDelivered: Number(e.target.value) })}
                        />
                      </label>
                      <label>
                        Rejected / damaged
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={l.qty}
                          value={l.qtyRejected}
                          onChange={(e) => setLine(i, { qtyRejected: Number(e.target.value) })}
                        />
                      </label>
                      {l.qtyRejected > 0 ? (
                        <>
                          <label>
                            Why it came back
                            <input
                              type="text"
                              value={l.reason}
                              placeholder="Two cartons crushed"
                              onChange={(e) => setLine(i, { reason: e.target.value })}
                            />
                          </label>
                          <label>
                            Photo
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) => {
                                const f = e.target.files?.[0]
                                if (f) void attachPhoto(i, f)
                              }}
                            />
                          </label>
                          {l.photoKey ? <span className="cell-sub">Photo kept on this device</span> : null}
                        </>
                      ) : null}
                      {err ? <p className="form-error">{err}</p> : null}
                    </div>
                  )
                })}
              </div>

              <SignaturePad onChange={setInk} label="Customer signature" />
              <label>
                Printed name
                <input
                  type="text"
                  value={signature.printedName}
                  onChange={(e) => setSignature((s) => ({ ...s, printedName: e.target.value }))}
                />
              </label>
              <label>
                Phone
                <input
                  type="tel"
                  value={signature.phone}
                  onChange={(e) => setSignature((s) => ({ ...s, phone: e.target.value }))}
                />
              </label>
              <details className="otp-fold">
                <summary>Customer asked for OTP verification</summary>
                <label>
                  OTP code
                  <input
                    type="text"
                    inputMode="numeric"
                    value={signature.otp}
                    onChange={(e) => setSignature((s) => ({ ...s, otp: e.target.value }))}
                  />
                </label>
              </details>

              {flowError ? <p className="form-error" role="alert">{flowError}</p> : null}
              {signatureError(gateSignature) ? <p className="cell-sub">{signatureError(gateSignature)}</p> : null}

              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !canSubmitDelivery(lines, gateSignature)}
                onClick={() => void submit()}
              >
                Submit delivery
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}
