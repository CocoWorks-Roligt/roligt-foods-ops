import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from './AuthContext'
import { useToast } from './ToastContext'
import { useAdmin } from './domains/admin'
import { useBulkProducts } from './domains/bulk'
import { useCatalog } from './domains/catalog'
import type { ControlSamplePatch, CoreDeps, DeliveryInput, PackingStockInput } from './domains/deps'
import { useInventory } from './domains/inventory'
import { usePacking } from './domains/packing'
import { useParties } from './domains/parties'
import { useProcurement } from './domains/procurement'
import { useProduction } from './domains/production'
import { useQuality, type LabReportInput, type TestCategoryInput, type TestParameterPatch } from './domains/quality'
import { useSales } from './domains/sales'
import { usePlanning, type PlanInput } from './domains/planning'
import { useStaffRoster, type ShiftInput, type StaffInput } from './domains/roster'
import { useStorageLocations } from './domains/storage'
import { seed } from '../data/seed'
import { fetchDb, fetchRevision, saveDb, UnauthorizedError } from '../lib/dbApi'
import { readLocal, writeLocal } from '../lib/localDb'
import { canAny, type PermissionKey } from '../lib/permissions.ts'
import { setSessionPermissions, useSessionPermissions } from '../lib/sessionPermissions'
import {
  activityScore,
  type BatchInput,
  type BulkProductInput,
  type DispatchInput,
  type MelangeInput,
  type MoveStockInput,
  type OrderAllocation,
  type PackingInput,
  type ProductInput,
  type QcUpdate,
  type StorageLocationInput,
} from '../lib/posting'
import { type GrnInput } from '../lib/grn'
import { migrateState } from '../lib/migrate'
import { formatDocNo, periodKeyFor, ruleFor } from '../lib/numbering'
import {
  type StockIssueInput,
} from '../lib/issues'
import { itemName, stockRows } from '../lib/stock'
import {
  type StickerJob,
} from '../lib/stickers'
import { deepClone, nowISO, uid } from '../lib/utils'
import type {
  AreaPurpose,
  AppState,
  Config,
  OrderLine,
  StickerTemplate,
  Customer,
  NumberingRule,
  PurchaseProduct,
  QcRecord,
  StockRow,
  TestParameter,
  Vendor,
} from '../types'

export type { ControlSamplePatch, DeliveryInput, LabReportInput, PackingStockInput, TestCategoryInput, TestParameterPatch }

export type {
  BatchInput,
  BulkProductInput,
  StockIssueInput,
  DispatchInput,
  MelangeInput,
  MoveStockInput,
  PackingInput,
  ProductInput,
  QcUpdate,
  StorageLocationInput,
}

/** What the header needs to say about whether this device's work is safe yet. */
export interface SaveStatus {
  /** Work sitting on this device that the server has not accepted. */
  dirty: boolean
  /** The last save failed for a reason worth retrying — usually no signal. */
  offline: boolean
}

interface AppContextValue {
  state: AppState
  /** Re-exported so screens do not have to reach for a second context to say something. */
  showToast: (message: string) => void
  rows: StockRow[]
  getItemName: (id: string) => string
  vendorTypeName: (id: string) => string
  createGrn: (input: GrnInput) => string | null
  updateGrn: (id: string, input: GrnInput) => string | null
  deleteGrn: (id: string) => void
  createBatch: (input: BatchInput) => string | null
  updateBatch: (id: string, input: BatchInput) => string | null
  deleteBatch: (id: string) => void
  createPackingRun: (input: PackingInput) => string | null
  updatePackingRun: (id: string, input: PackingInput) => string | null
  deletePackingRun: (id: string) => void
  saveQc: (id: string, updates: QcUpdate) => string | null
  startQc: (batchId: string, item: string) => string | null
  createDispatch: (input: DispatchInput) => string | null
  updateDispatch: (id: string, input: DispatchInput) => string | null
  deleteDispatch: (id: string) => void
  completeDelivery: (id: string, input: DeliveryInput) => void
  addVendor: (input: Omit<Vendor, 'id' | 'status'>) => string | null
  setVendorStatus: (id: string, status: string) => void
  updateVendor: (id: string, patch: Omit<Vendor, 'id' | 'status' | 'vendorTypeId'>) => string | null
  deleteVendor: (id: string) => void
  addCustomer: (input: Omit<Customer, 'id' | 'status'>) => string | null
  setCustomerStatus: (id: string, status: string) => void
  updateCustomer: (id: string, patch: Omit<Customer, 'id' | 'status'>) => string | null
  deleteCustomer: (id: string) => void
  addPurchaseProduct: (
    input: Omit<PurchaseProduct, 'id' | 'status' | 'itemId'> & { itemId?: string },
  ) => string | null
  updatePurchaseProduct: (
    id: string,
    input: { name: string; uom: string; description: string },
  ) => string | null
  deletePurchaseProduct: (id: string) => void
  updatePurchaseProductVendors: (id: string, vendorIds: string[]) => void
  addProduct: (input: ProductInput) => string | null
  updateProduct: (id: string, input: ProductInput) => string | null
  deleteProduct: (id: string) => void
  addBulkProduct: (input: BulkProductInput) => string | null
  updateBulkProduct: (id: string, input: BulkProductInput) => string | null
  deleteBulkProduct: (id: string) => void
  addMelange: (input: MelangeInput) => string | null
  updateMelange: (id: string, input: MelangeInput) => string | null
  setMelangeStatus: (id: string, status: string) => void
  deleteMelange: (id: string) => void
  addPackingStock: (input: PackingStockInput) => string | null
  updatePackingStock: (doc: string, input: PackingStockInput) => string | null
  deletePackingStock: (doc: string) => void
  updateControlSample: (runId: string, index: number, patch: ControlSamplePatch) => string | null
  moveStock: (input: MoveStockInput) => string | null
  addStorageLocation: (input: StorageLocationInput) => string | null
  updateStorageLocation: (id: string, patch: StorageLocationInput) => string | null
  setStorageLocationStatus: (id: string, status: string) => void
  deleteStorageLocation: (id: string) => void
  setDefaultArea: (purpose: AreaPurpose, id: string) => string | null
  addStaff: (input: StaffInput) => string | null
  updateStaff: (id: string, patch: StaffInput) => string | null
  setStaffStatus: (id: string, status: 'Active' | 'Inactive') => void
  setShift: (staffId: string, date: string, input: ShiftInput) => void
  clearShift: (staffId: string, date: string) => void
  setAttendance: (
    staffId: string,
    date: string,
    status: 'Present' | 'Absent' | 'Leave' | 'Half day',
  ) => void
  addPlan: (input: PlanInput) => string | null
  updatePlan: (id: string, input: PlanInput) => string | null
  setPlanStatus: (id: string, status: 'Planned' | 'In progress' | 'Done' | 'Cancelled') => void
  deletePlan: (id: string) => void
  saveTestCategory: (input: TestCategoryInput, key?: string) => string | null
  setTestCategoryStatus: (key: string, status: string) => void
  deleteTestCategory: (key: string) => void
  addTestParameter: (input: Omit<TestParameter, 'id'>) => string | null
  updateTestParameter: (id: string, patch: TestParameterPatch) => string | null
  deleteTestParameter: (id: string) => void
  generateReport: (input: LabReportInput) => string | null
  updateReport: (id: string, input: LabReportInput) => string | null
  deleteReport: (id: string) => void
  saveConfig: (config: Config) => void
  printStickers: (jobs: StickerJob[]) => string | null
  saveStickerTemplate: (template: StickerTemplate) => void
  saveStickerSize: (widthMm: number, heightMm: number) => void
  saveNumbering: (key: string, rule: NumberingRule, next: number) => string | null
  createStockIssue: (input: StockIssueInput) => string | null
  updateStockIssue: (id: string, input: StockIssueInput) => string | null
  deleteStockIssue: (id: string) => void
  exportData: () => void
  saveOrder: (
    input: { customerId: string; date: string; dueDate: string; lines: OrderLine[]; notes?: string },
    id?: string,
  ) => string | null
  cancelOrder: (id: string) => void
  deleteOrder: (id: string) => void
  dispatchOrder: (
    orderId: string,
    allocations: OrderAllocation[],
    vehicle: string,
    expected?: string,
  ) => string | null
}

const AppContext = createContext<AppContextValue | null>(null)

/**
 * Kept apart from `AppContext` on purpose. `dirty` flips on every single save, and
 * folding that into the main value would re-render every screen in the app twice per
 * keystroke-worth of work — for a line of text in the sidebar.
 */
const SaveStatusContext = createContext<SaveStatus>({ dirty: false, offline: false })

/** State read back from the database describes a real plant — do not invent masters
 *  it does not have. See `MigrateOptions.seedMasters`. */
const fromDb = { seedMasters: false } as const

export function AppProvider({ children }: { children: ReactNode }) {
  // Every audit line and QC signature used to read "Admin" no matter who was signed
  // in, which makes the trail useless as evidence of who did what.
  const { session } = useAuth()
  // Live permissions — the same store AuthContext seeds; snapshots below refresh it.
  const permissions = useSessionPermissions()
  const showToast = useToast()
  const actor = session?.user?.email || 'Unknown user'
  /**
   * The device's mirror, read once before the first render. When it exists it
   * IS a legitimate view of the plant — the same copy the app renders
   * wholesale whenever it starts offline — so the shell paints from it
   * immediately and the reconcile effect below verifies it against the server
   * in the background. Only a device with no mirror at all (a first run,
   * cleared storage) waits on the Loading gate: there is nothing real to
   * paint, and flashing the seed masters for a plant that has real ones would
   * be a lie.
   */
  const boot = useRef<{ state: AppState; mirrored: boolean } | null>(null)
  if (!boot.current) {
    const local = readLocal()
    boot.current = {
      state: local ? migrateState(local.state, fromDb) : deepClone(seed),
      mirrored: local !== null,
    }
  }
  const [state, setState] = useState<AppState>(boot.current.state)
  const [ready, setReady] = useState(false)
  const saveErrorShown = useRef(false)

  /**
   * A message that names a document React has not finished creating yet.
   *
   * Every posting mints its code inside the `setState` updater, because that is the
   * only place the counter can be advanced against the state actually being written.
   * The code was then read straight back out through a variable the updater assigns —
   * which works only while React takes its eager-state shortcut, and it skips that
   * shortcut whenever the provider already has an update queued. The `|| 'GRN'`
   * fallbacks scattered through this file were the tell: the toast quietly degraded to
   * a generic word instead of the receipt number the operator needs to write on a bin
   * card.
   *
   * So the updater records what to say, and this is flushed once the update is
   * committed, when the code is certain. Setting a ref twice under StrictMode's double
   * invoke is harmless — it is the same value both times.
   */
  const announcement = useRef<string | null>(null)
  useEffect(() => {
    if (!announcement.current) return
    const message = announcement.current
    announcement.current = null
    showToast(message)
  })

  /** True while this device holds work the database has not accepted. */
  const [dirty, setDirty] = useState(false)
  /** True once a save has failed for a reason that is worth retrying. */
  const [offline, setOffline] = useState(false)
  /**
   * The last state the database is known to hold. A save writes the difference between
   * this and the current state, which is what makes two operators posting two receipts
   * two independent writes rather than a race to overwrite the plant.
   *
   * Null means this client has no idea what is up there — a first run, or a
   * reconnection after working offline — and everything gets written. That is safe
   * because every write is an upsert keyed by the document's own code.
   */
  const synced = useRef<AppState | null>(null)
  /** The database's change counter, as of our last read or write. */
  const revision = useRef(0)
  /** True while a save is in flight, so the poll does not read a half-written plant. */
  const saving = useRef(false)

  /**
   * Refuses an action that is not this user's to take, and says so.
   *
   * Note what this is and is not. It stops an operator changing a tolerance or rewriting
   * a numbering series — real accidents, on screens they have no
   * reason to be on. It is not a security boundary: the whole plant is one JSON blob
   * and an operator must be able to write it to do their job, so the client cannot
   * tell one kind of edit from another. The server side of the split is real — the
   * BFF refuses commits to tables whose writePermission the caller does not hold
   * (lib/tables); this is the same rule applied before the fact.
   */
  const forbidden = useCallback(
    (what: string, perm: PermissionKey | readonly PermissionKey[]) => {
      if (canAny(permissions, ...(Array.isArray(perm) ? perm : [perm]))) return false
      showToast(`${what} is an admin task — ask an administrator.`)
      return true
    },
    [permissions, showToast],
  )

  /**
   * Startup: reconcile the copy on this device with the row on the server.
   *
   * Four things can be true, and they need telling apart.
   *  - This device holds nothing unsaved and the server has not moved since it was
   *    last written here. The mirror is the plant, one revision read confirms it,
   *    and no snapshot is read at all.
   *  - This device holds work that never reached the server, and the server has not
   *    moved on since. That work is real; adopt it and let the save effect push it up.
   *  - This device holds work that never reached the server, and the server has not
   *    moved on since. That work is real; adopt it and let the save effect push it up.
   *  - This device holds work that never reached the server, and the server *has*
   *    moved on. Two people have edited from one starting point and a blob cannot be
   *    merged, so say so rather than silently picking a winner.
   *  - This device holds nothing unsaved. Take the server's copy, which is the record.
   */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const local = readLocal()
      try {
        // A clean mirror whose revision the database still stands at IS the plant.
        // One revision read answers that. A full snapshot instead is 26 reads
        // against an API budget of 26 a minute, which is why a reload used to sit
        // a full minute on the loading screen. Anything not lining up — a stale or
        // dirty mirror, no revision recorded, somebody else has posted since —
        // falls through to the full read.
        if (local && !local.dirty && local.revision !== undefined) {
          const rev = await fetchRevision()
          if (cancelled) return
          if (rev === local.revision) {
            const mirror = migrateState(local.state, fromDb)
            synced.current = mirror
            revision.current = rev
            setState(mirror)
            return
          }
        }
        const remote = await fetchDb()
        if (cancelled) return
        revision.current = remote.revision
        // The BFF speaks the caller's permissions with every snapshot — adopting
        // them here means a role change lands on the next poll, no reload needed.
        setSessionPermissions(remote.permissions)

        // `fromDb`: what the database holds is the plant, empty or not. Seeding
        // masters in here would quietly refill a plant somebody had just cleared.
        const server = remote.state ? migrateState(remote.state, fromDb) : null
        if (server) synced.current = server

        // Work this device did without a signal is real work, and the only copy of it.
        // It is adopted and pushed up; because writes are now per-document upserts,
        // that merges with whatever else was posted meanwhile instead of erasing it.
        const unsaved = local?.dirty && activityScore(local.state) > 0
        if (unsaved) {
          setState(migrateState(local.state, fromDb))
          setDirty(true)
          if (server) showToast('Reconnected — saving the work done on this device.')
          return
        }

        // No row at all means a first run, and only then does the seed apply.
        setState(server ?? (local ? migrateState(local.state, fromDb) : migrateState(seed)))
      } catch (e) {
        if (cancelled) return
        if (e instanceof UnauthorizedError) {
          // A dead session is not an outage — dbApi has already told AuthContext,
          // which swaps in the login screen. This device's copy stays the record.
          synced.current = null
          if (local) setState(migrateState(local.state, fromDb))
          showToast(e.message)
          return
        }
        // Offline at startup. The device's own copy is the only record there is, and
        // nothing is known about the server, so nothing may be diffed against it.
        synced.current = null
        if (local) {
          setState(migrateState(local.state, fromDb))
          setOffline(true)
          showToast('Offline — working from this device. Changes save when you reconnect.')
        } else {
          showToast('Could not reach the database. Using in-memory data until reconnect.')
        }
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showToast])

  /**
   * Notice when somebody else posts something.
   *
   * The database bumps one number on every write, so this polls that number rather
   * than pulling the whole plant down the wire to find out nothing has changed. When
   * it moves for a reason that is not our own last save, the plant is re-read.
   *
   * Skipped while this device is holding unsaved work: adopting the server's copy then
   * would throw that work away, and it is about to be written up anyway.
   */
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const timer = setInterval(async () => {
      if (cancelled || dirty || saving.current) return
      try {
        const rev = await fetchRevision()
        if (cancelled || rev === revision.current) return
        const remote = await fetchDb()
        if (cancelled || dirty || saving.current) return
        revision.current = remote.revision
        setSessionPermissions(remote.permissions)
        if (!remote.state) return
        const server = migrateState(remote.state, fromDb)
        synced.current = server
        setState(server)
      } catch {
        // A poll that cannot reach the database says nothing new; the save path is
        // what reports being offline.
      }
    }, 20000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [dirty, ready])

  /**
   * Persist every change: to this device first, then to the server.
   *
   * The local write is synchronous and unconditional, so a tab closed mid-thought or
   * a signal that drops keeps the work. The server write is guarded on the version
   * this copy was built on, so it can never overwrite somebody else's postings.
   */
  useEffect(() => {
    if (!ready) return
    // Already what the database holds — after adopting the poll's copy, say. Recording
    // it as unsaved would have the next startup treat it as offline work and announce
    // that it was saving something that had never left.
    if (state === synced.current) {
      writeLocal({ state, dirty: false, revision: revision.current })
      return
    }
    writeLocal({ state, dirty: true, revision: revision.current })

    let live = true
    const t = setTimeout(() => {
      saving.current = true
      saveDb(state, synced.current)
        .then((result) => {
          if (!live) return
          if (result.ok) {
            synced.current = state
            revision.current = result.revision
            setDirty(false)
            setOffline(false)
            writeLocal({ state, dirty: false, revision: revision.current })
            saveErrorShown.current = false
            return
          }
          setDirty(true)
          if (result.reason === 'forbidden') {
            // Row-level security refused. The database is what enforces who may change
            // a master, so this is the honest place to hear about it — and it means
            // the local copy is now ahead of what the plant will accept.
            showToast(result.message)
            return
          }
          if (result.reason === 'unauthorized') {
            // Session expired: dbApi has already routed the user to the login
            // screen. The work stays held on this device and goes up after the
            // next sign-in — showing the offline banner instead would promise a
            // reconnect that signing in again, not the network, delivers.
            showToast(result.message)
            return
          }
          setOffline(true)
          // Said once per outage rather than once per session: the old flag latched
          // forever, so an operator working through a bad afternoon saw one toast and
          // then silence while nothing at all was reaching the database.
          if (!saveErrorShown.current) {
            saveErrorShown.current = true
            showToast('Offline — changes are held on this device until you reconnect.')
          }
        })
        .catch(() => {
          if (live) {
            setDirty(true)
            setOffline(true)
          }
        })
        .finally(() => {
          saving.current = false
        })
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [ready, showToast, state])

  const saveStatus: SaveStatus = useMemo(() => ({ dirty, offline }), [dirty, offline])

  const rows = useMemo(() => stockRows(state), [state])

  const getItemName = useCallback((id: string) => itemName(state, id), [state])

  /**
   * Mints the next code in a series. The shape — prefix, dated middle, padding — is
   * the admin's, held in config and defaulting to the plant's original scheme, so
   * every document type is named in one place instead of an `if` per prefix here.
   */
  const nextId = useCallback((draft: AppState, type: keyof AppState['counters']) => {
    const key = type as keyof AppState['counters']
    const rule = ruleFor(draft.config, key)
    const now = new Date()

    /**
     * A series whose code carries a date starts a fresh run of numbers each period,
     * so crossing into one resets the counter. `LOT-{YYYYMMDD}-{N}` used to climb
     * across days — `LOT-20260910-0047` on the morning of the tenth — and a challan
     * series that has to restart every year had no way to.
     *
     * A counter with no period recorded yet is adopted into the current one rather
     * than reset, because a database saved before this existed is mid-period with
     * codes already issued, and starting it again at 1 would reissue them.
     */
    const periods = (draft.counterPeriods ||= {})
    const period = periodKeyFor(rule, now)
    if (period && periods[key] !== undefined && periods[key] !== period) {
      draft.counters[key] = 0
    }
    periods[key] = period

    draft.counters[key] = (Number(draft.counters[key]) || 0) + 1
    return formatDocNo(rule, Number(draft.counters[key]), now)
  }, [])

  const nextLot = useCallback((draft: AppState) => nextId(draft, 'lot'), [nextId])

  const log = useCallback(
    (draft: AppState, action: string, doc: string, details: string) => {
      draft.audits.unshift({ id: uid('AUD'), time: nowISO(), role: actor, action, doc, details })
    },
    [actor],
  )

  const vendorTypeName = useCallback(
    (id: string) => state.vendorTypes.find((t) => t.id === id)?.name || id,
    [state.vendorTypes],
  )
  /**
   * The plumbing every domain hook is handed. The provider keeps ownership of the
   * state and of how it is stored; a hook is given `setState` and writes a draft,
   * exactly as it did when all of this lived in one file.
   */
  const deps: CoreDeps = useMemo(
    () => ({
      state,
      setState,
      nextId,
      nextLot,
      log,
      showToast,
      announcement,
      forbidden,
      rows,
      actor,
      vendorTypeName,
    }),
    [actor, forbidden, log, nextId, nextLot, rows, showToast, state, vendorTypeName],
  )

  // One group per part of the plant, in the order the work happens in.
  const procurement = useProcurement(deps)
  const production = useProduction(deps)
  const packing = usePacking(deps)
  const quality = useQuality(deps)
  const sales = useSales(deps)
  const inventory = useInventory(deps)
  const parties = useParties(deps)
  const catalog = useCatalog(deps)
  const bulk = useBulkProducts(deps)
  const storage = useStorageLocations(deps)
  const roster = useStaffRoster(deps)
  const planning = usePlanning(deps)
  const admin = useAdmin(deps)

  /**
   * Rebuilt only when something in it actually changed.
   *
   * This was a fresh object literal on every render, so every consumer of `useApp`
   * re-rendered whenever the provider did — for any reason at all. Each group below
   * memoises its own operations, so the value now holds steady across renders that
   * changed nothing.
   */
  const value: AppContextValue = useMemo(
    () => ({
      state,
      showToast,
      rows,
      getItemName,
      vendorTypeName,
      ...procurement,
      ...production,
      ...packing,
      ...quality,
      ...sales,
      ...inventory,
      ...parties,
      ...catalog,
      ...bulk,
      ...storage,
      ...roster,
      ...planning,
      ...admin,
    }),
    [
      admin,
      bulk,
      catalog,
      getItemName,
      inventory,
      packing,
      parties,
      procurement,
      production,
      quality,
      planning,
      roster,
      rows,
      sales,
      showToast,
      state,
      storage,
      vendorTypeName,
    ],
  )

  // A mirrored device paints straight away (see `boot`); the reconcile effect
  // is still running, and `ready` continues to gate the poll and the save
  // effect below until it finishes.
  if (!ready && !boot.current.mirrored) {
    return (
      <div className="empty" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        Loading…
      </div>
    )
  }

  return (
    <SaveStatusContext.Provider value={saveStatus}>
      <AppContext.Provider value={value}>{children}</AppContext.Provider>
    </SaveStatusContext.Provider>
  )
}

/** Whether this device's work has reached the database yet. */
export function useSaveStatus() {
  return useContext(SaveStatusContext)
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

export type { QcRecord }
