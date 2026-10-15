import { describe, expect, it } from 'vitest'
import {
  canSubmitDelivery,
  draftLines,
  emptySignature,
  lineError,
  signatureError,
  submitBody,
  type DeliveryLineDraft,
} from './deliveryDraft.ts'
import type { ShipmentDetail } from './contracts.ts'

const detail: ShipmentDetail = {
  shipment: {
    id: 'S-1',
    orderId: 'O-1',
    dispatchIds: ['D-1', 'D-2'],
    vehicle: 'AP-07-1234',
    status: 'Out for Delivery',
    stops: [{ customerId: 'C-1', customerName: 'Green Grocer', address: '12 Market Road', dispatchIds: ['D-1', 'D-2'] }],
    times: { created: 't', dispatched: 't', outForDelivery: 't' },
    packaging: 'BOXED',
    agentUserId: 'driver@roligt.local',
    version: 2,
  },
  lines: [
    { dispatchId: 'D-1', sku: 'FG-TCW-250', lot: 'B-9', qty: 40, customerId: 'C-1', customerName: 'Green Grocer', challan: 'DC0201/2026' },
    { dispatchId: 'D-2', sku: 'FG-CM-1L', lot: 'B-4', qty: 12, customerId: 'C-1', customerName: 'Green Grocer', challan: 'DC0202/2026' },
  ],
  challans: [],
}

describe('deliveryDraft', () => {
  it('starts from the best of the trip: everything delivered, nothing rejected', () => {
    const lines = draftLines(detail)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ dispatchId: 'D-1', qty: 40, qtyDelivered: 40, qtyRejected: 0 })
    expect(lines.every((l) => lineError(l) === '')).toBe(true)
  })

  it('a line is honest when the quantities reconcile and rejections say why', () => {
    const bad = (over: Partial<DeliveryLineDraft>) => lineError({ ...draftLines(detail)[0], ...over })
    expect(bad({ qtyDelivered: 38, qtyRejected: 2, reason: '' })).toBe('Say why it came back.')
    expect(bad({ qtyDelivered: 41 })).toMatch(/more than left the gate/)
    expect(bad({ qtyRejected: -1 })).toMatch(/negative/)
    expect(bad({ qtyDelivered: 38, qtyRejected: 2, reason: 'Two cartons crushed' })).toBe('')
    // all-rejected is a valid line — the trip ends Returned, not refused
    expect(bad({ qtyDelivered: 0, qtyRejected: 40, reason: 'Refused at the door' })).toBe('')
  })

  it('the signature is the one required proof', () => {
    expect(signatureError(emptySignature())).toMatch(/signature/i)
    const inked = { ...emptySignature(), signatureKey: 'attachments/delivery/S-1.sig-x-y-signature.png' }
    expect(signatureError(inked)).toMatch(/printed name/i)
    expect(signatureError({ ...inked, printedName: 'Ravi' })).toMatch(/phone/i)
    expect(signatureError({ ...inked, printedName: 'Ravi', phone: '98xxxx' })).toBe('')
  })

  it('canSubmit is every line honest plus the signature; the body carries only what varies', () => {
    const lines = draftLines(detail).map((l, i) =>
      i === 0 ? { ...l, qtyDelivered: 38, qtyRejected: 2, reason: 'Damaged cartons', photoKey: 'attachments/delivery/D-1-x.jpg' } : l,
    )
    const sig = { ...emptySignature(), signatureKey: 'k', printedName: 'Ravi', phone: '98xxxx', otp: '' }
    expect(canSubmitDelivery(lines, { ...sig, signatureKey: '' })).toBe(false)
    expect(canSubmitDelivery(lines.map((l) => ({ ...l, reason: l.qtyRejected > 0 ? '' : l.reason })), sig)).toBe(false)
    expect(canSubmitDelivery(lines, sig)).toBe(true)

    const body = submitBody(lines, sig)
    expect(body.lines[0]).toEqual({
      dispatchId: 'D-1',
      sku: 'FG-TCW-250',
      lot: 'B-9',
      qtyDelivered: 38,
      qtyRejected: 2,
      reason: 'Damaged cartons',
      photoKey: 'attachments/delivery/D-1-x.jpg',
    })
    // a clean line carries neither reason nor photo; no OTP means no otp field
    expect(body.lines[1]).toMatchObject({ dispatchId: 'D-2', qtyRejected: 0 })
    expect('reason' in body.lines[1]).toBe(false)
    expect('otp' in body.signature).toBe(false)
    expect(body.signature).toMatchObject({ signatureKey: 'k', printedName: 'Ravi', phone: '98xxxx' })
  })
})
