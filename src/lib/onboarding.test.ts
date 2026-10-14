/**
 * onboarding folds under test (WORKFLOW W16): page-gated tour steps drop for
 * callers who cannot reach them; the cheat sheet lists exactly the pages the
 * caller holds, in the order the catalog gave them; every page in the catalog
 * carries a PAGE_HELP line (a tooltip can never be blank); every pipeline
 * stage id has tooltip words.
 */
import { describe, expect, it } from 'vitest'
import { PAGE_CATALOG } from './pages'
import { PAGE_HELP, STAGE_HELP, cheatSheetRows, tourSteps } from './onboarding'
import { pipelineStages } from './pipeline'
import { migrateState } from './migrate'

describe('tourSteps', () => {
  it('keeps every step for an open-tier caller (pipeline held)', () => {
    const open = PAGE_CATALOG.filter((p) => p.tier === 'open').map((p) => p.id)
    expect(tourSteps(open).map((s) => s.id)).toEqual([
      'welcome', 'pipeline', 'nav', 'search', 'forms', 'trust', 'help',
    ])
  })

  it('drops the pipeline step for a scoped caller who cannot reach the board', () => {
    const steps = tourSteps(['quality', 'control-samples'])
    expect(steps.map((s) => s.id)).not.toContain('pipeline')
    // the anchorless steps survive — the tour never depends on the viewport
    expect(steps[0]!.id).toBe('welcome')
    expect(steps.at(-1)!.id).toBe('help')
  })
})

describe('cheatSheetRows', () => {
  it('lists the held pages in catalog order, each with its one-liner', () => {
    const rows = cheatSheetRows([
      { id: 'procurement', label: 'Procurement' },
      { id: 'admin-roles', label: 'Roles & Permissions' },
    ])
    expect(rows).toEqual([
      { id: 'procurement', label: 'Procurement', line: expect.stringContaining('receive') },
      { id: 'admin-roles', label: 'Roles & Permissions', line: expect.any(String) },
    ])
  })
})

describe('PAGE_HELP coverage', () => {
  it('covers every page in the catalog — no tooltip can render blank', () => {
    const missing = PAGE_CATALOG.filter((p) => !PAGE_HELP[p.id]).map((p) => p.id)
    expect(missing).toEqual([])
  })
})

describe('STAGE_HELP coverage', () => {
  it('covers every stage id the pipeline board emits', () => {
    const ids = pipelineStages(migrateState({}), '2026-10-14').map((s) => s.id)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(STAGE_HELP[id], id).toBeTruthy()
  })
})
