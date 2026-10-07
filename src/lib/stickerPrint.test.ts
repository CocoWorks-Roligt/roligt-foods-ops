import { describe, expect, it } from 'vitest'
import { buildStickerHtml, type StickerSheet } from './stickerPrint'

/**
 * The sticker dimensions are the one value the print sheet interpolates without
 * escaping — they ride inside the <style> block, where markup in the value
 * would close it and run as the signed-in user (the 2026-10-07 audit's
 * stored-XSS finding). The sink coerces: only a real, positive, finite number
 * reaches the HTML; everything else falls back to label stock.
 */
describe('buildStickerHtml — dimensions are coerced, never interpolated raw', () => {
  const sheet: StickerSheet = {
    widthMm: 100,
    heightMm: 50,
    stickers: [{ title: 'LOT-1', lines: [{ label: 'Lot', value: 'LOT-1' }], copies: 1 }],
  }

  it('keeps numeric dimensions as given', () => {
    expect(buildStickerHtml(sheet)).toContain('@page { size: 100mm 50mm;')
    expect(buildStickerHtml(sheet)).toContain('width: 100mm')
  })

  it('falls a crafted string dimension back to stock — no markup reaches the sheet', () => {
    const html = buildStickerHtml({
      ...sheet,
      widthMm: '50;}</style><img src=x onerror=fetch("/api/commit")>' as unknown as number,
    })
    expect(html).toContain('@page { size: 100mm 50mm;') // the default, not the string
    expect(html).not.toContain('</style><img')
    expect(html).not.toContain('onerror')
  })

  it('rejects zero, negative, absurd and NaN dimensions', () => {
    for (const bad of [0, -5, 1e9, Number.NaN, Number.POSITIVE_INFINITY, '', null]) {
      const html = buildStickerHtml({ ...sheet, heightMm: bad as unknown as number })
      expect(html).toContain('height: 50mm') // the default
    }
  })
})
