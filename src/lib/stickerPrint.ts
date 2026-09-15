/**
 * Printing stickers.
 *
 * The sheet is built as its own small HTML document and printed from a hidden
 * iframe rather than by styling the app and calling `window.print()`. Three reasons:
 * `@page` is global, so a label-sized page would fight the A4 rule the lab report
 * already sets; the app's stylesheet has no business deciding what lands on adhesive
 * stock; and an iframe is never caught by a popup blocker the way `window.open` is.
 *
 * Nothing here is app-specific — it takes finished lines and a size in millimetres.
 */

export interface StickerDoc {
  title: string
  lines: { label: string; value: string }[]
  /** How many identical copies of this sticker to print. */
  copies: number
}

export interface StickerSheet {
  widthMm: number
  heightMm: number
  stickers: StickerDoc[]
}

const escapeHtml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/**
 * Labels are small and the value column has to win the space, so the font steps down
 * as the line count climbs rather than letting a long list overflow the stock.
 */
function fontFor(lineCount: number, heightMm: number) {
  const perLine = heightMm / Math.max(lineCount + 2, 4)
  return Math.max(1.9, Math.min(3.6, perLine * 0.62))
}

export function buildStickerHtml({ widthMm, heightMm, stickers }: StickerSheet) {
  const pages = stickers
    .flatMap((s) => Array.from({ length: Math.max(1, s.copies) }, () => s))
    .map((s) => {
      const font = fontFor(s.lines.length, heightMm)
      const rows = s.lines
        .map(
          (l) =>
            `<tr><th>${escapeHtml(l.label)}</th><td>${escapeHtml(l.value)}</td></tr>`,
        )
        .join('')
      return `<section class="sticker" style="font-size:${font}mm">
  <h1>${escapeHtml(s.title)}</h1>
  <table>${rows}</table>
</section>`
    })
    .join('\n')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Stickers</title>
<style>
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sticker {
    width: ${widthMm}mm;
    height: ${heightMm}mm;
    padding: ${Math.max(1.5, heightMm * 0.06)}mm ${Math.max(2, widthMm * 0.04)}mm;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
    display: flex;
    flex-direction: column;
    gap: 0.4em;
  }
  .sticker:last-child { page-break-after: auto; break-after: auto; }
  h1 {
    margin: 0;
    font-size: 1.05em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border-bottom: 0.35mm solid #000;
    padding-bottom: 0.25em;
  }
  table { width: 100%; border-collapse: collapse; }
  /* Labels stay narrow and quiet; the value is what someone reads across a room. */
  th {
    text-align: left;
    font-weight: 400;
    width: 38%;
    padding: 0.1em 0.5em 0.1em 0;
    vertical-align: top;
    white-space: nowrap;
  }
  td {
    text-align: left;
    font-weight: 700;
    padding: 0.1em 0;
    vertical-align: top;
    word-break: break-word;
  }
</style>
</head>
<body>
${pages}
</body>
</html>`
}

/**
 * Prints the sheet and resolves once the dialog has been dismissed. The iframe is
 * torn down on a timer rather than immediately after `print()`, because Safari
 * returns from the call before it has finished rasterising the document.
 */
export function printStickerSheet(sheet: StickerSheet) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
  frame.srcdoc = buildStickerHtml(sheet)
  document.body.appendChild(frame)

  frame.onload = () => {
    const win = frame.contentWindow
    if (!win) {
      frame.remove()
      return
    }
    win.focus()
    win.print()
    setTimeout(() => frame.remove(), 1000)
  }
}
