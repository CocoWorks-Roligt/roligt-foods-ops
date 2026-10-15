/**
 * The delivery PWA's confirmation draft (SHIPMENT S2) — the pure model behind
 * the per-line form: what a trip's lines look like before anybody touches
 * them (everything delivered, nothing rejected), what makes a line honest
 * (the two quantities reconcile with what left the gate, a rejection carries
 * a reason), and what makes a submit valid (every line honest, the signature
 * captured — printed name and phone, the PNG already uploaded so only its
 * key travels).
 *
 * The server re-derives every one of these verdicts (submit's coverage and
 * arithmetic guards); this model exists so the agent's phone refuses before
 * the bytes ever leave it.
 */
import type {
  DeliveryLineConfirmation,
  ShipmentDetail,
  SubmitDeliveryRequest,
} from './contracts.ts'

export interface DeliveryLineDraft {
  dispatchId: string
  sku: string
  lot: string
  /** What left the gate on this line — the ceiling on the two quantities. */
  qty: number
  qtyDelivered: number
  qtyRejected: number
  reason: string
  /** Rejection photo, when one was taken — the uploaded object's key. */
  photoKey?: string
}

/** A trip starts believing the best of itself: everything delivered. */
export function draftLines(detail: ShipmentDetail): DeliveryLineDraft[] {
  return detail.lines.map((l) => ({
    dispatchId: l.dispatchId,
    sku: l.sku,
    lot: l.lot,
    qty: l.qty,
    qtyDelivered: l.qty,
    qtyRejected: 0,
    reason: '',
  }))
}

/** Why a line cannot be submitted, or '' when it can. */
export function lineError(l: DeliveryLineDraft): string {
  if (!Number.isFinite(l.qtyDelivered) || l.qtyDelivered < 0) return 'Delivered cannot be negative.'
  if (!Number.isFinite(l.qtyRejected) || l.qtyRejected < 0) return 'Rejected cannot be negative.'
  if (l.qtyDelivered + l.qtyRejected > l.qty + 1e-9) return 'Delivered + rejected is more than left the gate.'
  if (l.qtyRejected > 0 && !l.reason.trim()) return 'Say why it came back.'
  return ''
}

export interface SignatureDraft {
  /** The uploaded PNG's object key — empty until the pad's ink has landed in R2. */
  signatureKey: string
  printedName: string
  phone: string
  /** Entered only when the customer asked for code verification (default off). */
  otp: string
}

export const emptySignature = (): SignatureDraft => ({ signatureKey: '', printedName: '', phone: '', otp: '' })

/** The signature is the submit's one required proof: ink (its key), a printed
 *  name, and a phone number to reach the person who signed. */
export function signatureError(s: SignatureDraft): string {
  if (!s.signatureKey) return 'Take the customer\'s signature.'
  if (!s.printedName.trim()) return 'Who signed — the printed name.'
  if (!s.phone.trim()) return 'A phone number for the person who signed.'
  return ''
}

/** The one verdict the submit button lives on. */
export const canSubmitDelivery = (lines: readonly DeliveryLineDraft[], signature: SignatureDraft): boolean =>
  lines.every((l) => lineError(l) === '') && signatureError(signature) === ''

/** The wire body — only honest lines and the signature's key travel. */
export function submitBody(lines: readonly DeliveryLineDraft[], signature: SignatureDraft): SubmitDeliveryRequest {
  return {
    lines: lines.map<DeliveryLineConfirmation>((l) => ({
      dispatchId: l.dispatchId,
      sku: l.sku,
      lot: l.lot,
      qtyDelivered: l.qtyDelivered,
      qtyRejected: l.qtyRejected,
      ...(l.qtyRejected > 0 ? { reason: l.reason.trim() } : {}),
      ...(l.photoKey ? { photoKey: l.photoKey } : {}),
    })),
    signature: {
      signatureKey: signature.signatureKey,
      printedName: signature.printedName.trim(),
      phone: signature.phone.trim(),
      ...(signature.otp.trim() ? { otp: signature.otp.trim() } : {}),
    },
  }
}
