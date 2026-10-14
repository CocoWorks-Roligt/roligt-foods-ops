/**
 * The challan PDF — rendered server-side (jsPDF works in Node; the client
 * already ships it) and uploaded to R2 under the challan's key. Rendered
 * lazily: the submit endpoint stores the key, and the first /file request
 * (or a render that failed) produces the bytes — a failed render costs a
 * retry, never the delivery.
 *
 * The built-in fonts carry Latin-1 only (the client pdf.ts note): no rupee
 * sign, no arrows — the challan carries quantities, not amounts, so nothing
 * outside the set is wanted. Times print in IST, the plant's clock.
 */
import type { Challan, Shipment } from '../../src/lib/contracts.js'
import type { Customer } from '../../src/types.js'

const IST = 'Asia/Kolkata'

const ist = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: IST,
    dateStyle: 'medium',
    timeStyle: 'short',
  })

/** One challan as PDF bytes — A4, mm, plain tables. */
export async function renderChallanPdf(
  challan: Challan,
  shipment: Shipment,
  customers: Map<string, Customer>,
): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW = doc.internal.pageSize.getWidth()
  const left = 15
  let y = 18

  // Header — the operating name, the document's own name.
  doc.setFont('helvetica', 'bold').setFontSize(16)
  doc.text('Roligt Foods', left, y)
  doc.setFont('helvetica', 'normal').setFontSize(10)
  y += 6
  doc.text('Delivery Challan', left, y)
  doc.setFontSize(9)
  y += 12

  // The numbers that identify the paper.
  doc.setFont('helvetica', 'bold').setFontSize(11)
  doc.text(`Challan ${challan.number}`, left, y)
  doc.setFont('helvetica', 'normal').setFontSize(9)
  const right = (s: string) => doc.text(s, pageW - left, y, { align: 'right' })
  right(`Delivered ${ist(challan.deliveredAt)}`)
  if (challan.supersedesId) right(`Supersedes ${challan.supersedesId}`)
  y += 6

  // Buyer — the trip's first stop (a multi-stop trip names it and counts).
  const first = shipment.stops[0]
  const buyer = first ? (customers.get(first.customerId)?.name ?? first.customerName) : ''
  const buyerAddress = first ? (customers.get(first.customerId)?.shipTo ?? first.address) : ''
  doc.text(`Buyer: ${buyer}${shipment.stops.length > 1 ? ` (and ${shipment.stops.length - 1} more stop${shipment.stops.length > 2 ? 's' : ''})` : ''}`, left, y)
  if (buyerAddress) {
    y += 4.5
    doc.text(buyerAddress, left, y)
  }
  y += 6
  doc.text(`Order ${challan.orderId} · Vehicle ${challan.vehicle} · Trip ${challan.shipmentId}`, left, y)
  y += 8

  // Lines — a plain ruled table, Qty in the line's own uom.
  const cols: { label: string; w: number; align?: 'right' }[] = [
    { label: 'Item', w: 62 },
    { label: 'Lot', w: 30 },
    { label: 'Qty', w: 18, align: 'right' },
    { label: 'UOM', w: 16 },
    { label: 'Expiry', w: 24 },
    { label: 'Pack', w: 15 },
  ]
  const drawHead = () => {
    doc.setFillColor(240, 240, 240).rect(left, y - 4, pageW - left * 2, 6, 'F')
    doc.setFont('helvetica', 'bold').setFontSize(8.5)
    let x = left + 2
    for (const c of cols) {
      doc.text(c.label, c.align === 'right' ? x + c.w - 4 : x, y, { align: c.align === 'right' ? 'right' : 'left' })
      x += c.w
    }
    doc.setFont('helvetica', 'normal')
    y += 6
  }
  drawHead()
  for (const line of challan.lines) {
    if (y > 250) {
      doc.addPage()
      y = 20
      drawHead()
    }
    const cells = [
      line.skuName,
      line.lot,
      String(Number(line.qty.toFixed(2))),
      line.uom,
      line.expiry ?? '',
      line.packaging,
    ]
    let x = left + 2
    cells.forEach((cell, i) => {
      doc.text(String(cell), cols[i].align === 'right' ? x + cols[i].w - 4 : x, y, {
        align: cols[i].align === 'right' ? 'right' : 'left',
        maxWidth: cols[i].w - 2,
      })
      x += cols[i].w
    })
    doc.setDrawColor(210, 210, 210).line(left, y + 1.5, pageW - left, y + 1.5)
    y += 5.5
  }

  // Tax fields — printed only when configured, and always caveated: the
  // business has not signed them off yet (DECISIONS #11).
  const tax = challan.taxFields
  const taxEntries = Object.entries(tax ?? {}).filter(([, v]) => v !== undefined && v !== '')
  if (taxEntries.length > 0) {
    y += 6
    doc.setFont('helvetica', 'bold').setFontSize(9)
    doc.text('Tax details', left, y)
    doc.setFont('helvetica', 'normal').setFontSize(8.5)
    for (const [k, v] of taxEntries) {
      y += 4.5
      doc.text(`${k}: ${String(v)}`, left, y)
    }
    y += 4.5
    doc.setTextColor(120, 120, 120)
    doc.text('Tax details pending accountant sign-off - not valid for filing.', left, y)
    doc.setTextColor(0, 0, 0)
  }

  // The proof the whole document exists for.
  y = Math.max(y + 14, 245)
  doc.line(pageW - left - 60, y, pageW - left, y)
  doc.text(`${challan.agentId ? `Received by ` : ''}${shipment.signature?.printedName ?? ''}`, pageW - left - 60, y + 5, { maxWidth: 60 })
  y += 5
  doc.setFontSize(8)
  doc.setTextColor(120, 120, 120)
  doc.text(`Signed at the door · phone ${shipment.signature?.phone ?? ''}`, pageW - left - 60, y + 4, { maxWidth: 60 })
  doc.setTextColor(0, 0, 0)

  // Footer.
  doc.setFontSize(8)
  doc.setTextColor(120, 120, 120)
  doc.text(
    `Generated ${ist(new Date().toISOString())} · version ${challan.version}${challan.reason ? ` · correction: ${challan.reason}` : ''}`,
    left,
    285,
  )
  doc.setTextColor(0, 0, 0)

  return new Uint8Array(doc.output('arraybuffer'))
}
