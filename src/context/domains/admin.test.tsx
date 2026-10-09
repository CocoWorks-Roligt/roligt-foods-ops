// @vitest-environment happy-dom
/**
 * The Stickers page's size presets were the one config writer without a client
 * gate: an operator could tap "50×30", get a success toast, and wedge their
 * device's whole save queue — the config diff rides every later commit and the
 * server (which demands page.settings for these two keys) refuses them all.
 * The gate mirrors saveConfig and saveNumbering; these tests pin both arms.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAdmin } from './admin'
import type { CoreDeps } from './deps'
import { migrateState } from '../../lib/migrate'
import type { PermissionKey } from '../../lib/permissions'

/** The hook's plumbing, stubbed the way AppContext hands it over. */
function deps(permissions: readonly string[]) {
  const showToast = vi.fn()
  const setState = vi.fn()
  const d: CoreDeps = {
    state: migrateState({}),
    setState,
    nextId: vi.fn(() => 'ST-0001'),
    nextLot: vi.fn(() => 'LOT-0001'),
    log: vi.fn(),
    showToast,
    announcement: { current: null },
    // the AppContext rule, verbatim: hold any one of the named permissions or refuse
    forbidden: (what: string, perm: PermissionKey | readonly PermissionKey[]) => {
      const list = Array.isArray(perm) ? perm : [perm]
      if (list.some((p) => permissions.includes(p))) return false
      showToast(`${what} is an admin task — ask an administrator.`)
      return true
    },
    rows: [],
    actor: 'store@roligt.local',
    vendorTypeName: () => 'Farmer',
  }
  return { d, setState, showToast }
}

afterEach(cleanup)

describe('saveStickerSize', () => {
  it('refuses the operator before any config diff exists — the preset cannot wedge the save queue', () => {
    const { d, setState, showToast } = deps([]) // the operator: no page permissions at all
    const { result } = renderHook(() => useAdmin(d))
    result.current.saveStickerSize(50, 30)
    expect(setState).not.toHaveBeenCalled() // no draft, no config diff, no audit row
    expect(showToast).toHaveBeenCalledWith('Changing sticker size is an admin task — ask an administrator.')
  })

  it('sets the size for a page.settings holder', () => {
    const { d, setState, showToast } = deps(['page.settings'])
    const { result } = renderHook(() => useAdmin(d))
    result.current.saveStickerSize(50, 30)
    expect(setState).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('Sticker size set to 50×30 mm.')
  })
})
