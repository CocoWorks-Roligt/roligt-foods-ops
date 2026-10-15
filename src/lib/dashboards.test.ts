/**
 * D1b tests: the dashboards catalog's visibility fold — the flag × page rule
 * /api/kpis/:module enforces, pre-checked client-side — and the export client's
 * stream-vs-job decision (fetch stubbed; the DOM side injected as a spy).
 */
import { describe, expect, it, vi } from 'vitest'
import { DASHBOARDS, visibleDashboards } from './dashboards.ts'
import { downloadExport } from './exportJob.ts'
import { ALL_FLAGS_OFF, readFlags, type FlagMap } from './rules/flags.ts'

const flagsWith = (on: Record<string, boolean>): FlagMap => ({
  ...ALL_FLAGS_OFF,
  dashboards: on,
})

describe('visibleDashboards', () => {
  it('shows a module only when its own flag is on', () => {
    const flags = flagsWith({ procurement: true })
    const held: string[] = [] // the open tier — procurement is an open page
    expect(visibleDashboards(flags, held).map((d) => d.module)).toEqual(['procurement'])
  })

  it('is all-OFF when no dashboards flags exist (the rollback position)', () => {
    expect(visibleDashboards(readFlags([]), [])).toEqual([])
  })

  it('never offers a module whose flag is on but whose KPI pages a scoped caller lacks', () => {
    // A lab role ticks only Quality: the procurement flag being on does not
    // put procurement in THEIR catalog — /api/kpis/procurement would refuse.
    const flags = flagsWith({ procurement: true, qc: true })
    const lab = ['page.quality']
    expect(visibleDashboards(flags, lab).map((d) => d.module)).toEqual(['qc'])
  })

  it('shows grading-extraction to a production-only holder (either KPI page)', () => {
    const flags = flagsWith({ 'grading-extraction': true })
    expect(visibleDashboards(flags, ['page.production']).map((d) => d.module)).toEqual([
      'grading-extraction',
    ])
  })

  it('never shows a delivery agent anything (the external clamp)', () => {
    const flags = flagsWith({ procurement: true, 'shipment-tracking': true })
    expect(visibleDashboards(flags, ['page.my-deliveries'])).toEqual([])
  })

  it('catalog lists every KPI module exactly once, keyed by its module id', async () => {
    expect(DASHBOARDS.map((d) => d.module)).toEqual([
      'procurement',
      'grading-extraction',
      'intermediates-blending',
      'packing',
      'qc',
      'control-samples',
      'inventory',
      'packaging-materials',
      'orders-dispatch',
      'shipment-tracking',
    ])
    // Every export key the catalog names is a real registered spec — an Export
    // row must never offer a register the engine would 404 — and every report
    // key is a real classic report def.
    const { EXPORT_SPECS } = await import('./exports/index.ts')
    const { REPORTS } = await import('./reports/index.ts')
    for (const d of DASHBOARDS) {
      for (const key of d.exports) {
        expect(EXPORT_SPECS[key as keyof typeof EXPORT_SPECS], `${d.module} → ${key}`).toBeDefined()
      }
      for (const key of d.reports) {
        expect(REPORTS.some((r) => r.key === key), `${d.module} → ${key}`).toBe(true)
      }
    }
  })
})

describe('downloadExport', () => {
  const blobOf = (text: string): Blob => new Blob([text], { type: 'text/csv' })

  it('streams a small export and hands the browser the blob with the server filename', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(blobOf('a,b'), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="lot-report-2026.csv"' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const open = vi.fn()
    const out = await downloadExport('procurement-lots', { format: 'csv', from: '2026-09-01', to: '2026-10-15' }, open)
    expect(out).toEqual({ kind: 'streamed', filename: 'lot-report-2026.csv' })
    expect(fetchMock).toHaveBeenCalledWith('/api/exports/procurement-lots?format=csv&from=2026-09-01&to=2026-10-15')
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![1]).toBe('lot-report-2026.csv')
    vi.unstubAllGlobals()
  })

  it('polls a 202 job to ready and opens the presigned URL without a filename', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'J1', status: 'queued' }), { status: 202 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'J1', status: 'ready', downloadUrl: 'https://r2/x.csv?sig=1' })))
      vi.stubGlobal('fetch', fetchMock)
      const open = vi.fn()
      const pending = downloadExport('purchase-orders', { format: 'xlsx' }, open)
      await vi.advanceTimersByTimeAsync(1500) // the poll sleep
      const out = await pending
      expect(out.kind).toBe('job')
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/exports/jobs/J1')
      expect(open).toHaveBeenCalledWith('https://r2/x.csv?sig=1')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('a failed job surfaces the server error words', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'J1', status: 'queued' }), { status: 202 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'J1', status: 'failed', error: 'R2 is not configured' })))
      vi.stubGlobal('fetch', fetchMock)
      const pending = downloadExport('spoilage', { format: 'pdf' }, vi.fn())
      // Attach the handler before the timers advance, or the rejection lands
      // unhandled for a turn and vitest counts it.
      const assertion = expect(pending).rejects.toThrow('R2 is not configured')
      await vi.advanceTimersByTimeAsync(1500)
      await assertion
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('a refusal answers the server error, never a raw status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'role_allowed' }), { status: 403 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(downloadExport('quality', { format: 'csv' }, vi.fn())).rejects.toThrow('role_allowed')
    vi.unstubAllGlobals()
  })
})
