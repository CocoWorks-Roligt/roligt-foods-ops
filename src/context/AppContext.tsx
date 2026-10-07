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
import { fetchDb, fetchRevision, saveDb, ThrottledError, UnauthorizedError } from '../lib/dbApi'
import { readLocal, writeLocal, type LocalCopy } from '../lib/localDb'
import { adoptServerRows, installOver, offlineBootBase, restoreWithheld } from '../lib/sync'
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
import { itemName, overdrawnLots, stockRows, type OverdrawnLot } from '../lib/stock'
import {
  type StickerJob,
} from '../lib/stickers'
import { nowISO, uid } from '../lib/utils'
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
  /** A save was refused because another device saved the same records first;
   *  the winning versions are shown and this device's copy of them is kept
   *  only until reviewed. */
  conflict: boolean
  /** The device's own mirror refused its write — storage full, or a private
   *  window. Until a write lands again this tab is the only copy of the work
   *  on it, so the header says so and keeps saying so. */
  mirrorFailed: boolean
}

interface AppContextValue {
  state: AppState
  /** Re-exported so screens do not have to reach for a second context to say something. */
  showToast: (message: string) => void
  rows: StockRow[]
  /**
   * Lots whose balance went negative (the audit's S2-8) — two offline devices
   * drawing the same released lot, detected after the fact. Detect, not block:
   * the banner and the Storage page carry it; nothing refuses on its behalf.
   */
  overdrawn: OverdrawnLot[]
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
const SaveStatusContext = createContext<SaveStatus>({
  dirty: false,
  offline: false,
  conflict: false,
  mirrorFailed: false,
})

/** The number inside a revision token (`<n>:<nonce>`) — the only part that orders. */
const revNum = (t: number | string) => Number.parseInt(String(t), 10) || 0

/**
 * Installs a snapshot over the live state. Every one of these used to be a
 * direct `setState(ready-made)`, which silently discarded anything the operator
 * queued while the read was in flight; the functional form lets React run the
 * merge against the state it actually holds. The reference compare is the fast
 * path: when live is still exactly the state the snapshot was expected to sit
 * over (no edits in the window), the source is installed whole — which keeps
 * `state === synced.current` true, so an idle device still writes nothing.
 */
const installSnapshot = (source: AppState, base: AppState | null) => (live: AppState) =>
  live === base ? source : installOver(live, base, source)

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
   * paint, and flashing fabricated masters for a plant that has real ones
   * would be a lie.
   */
  const boot = useRef<{ state: AppState; mirrored: boolean } | null>(null)
  if (!boot.current) {
    const local = readLocal()
    boot.current = {
      // Nothing is seeded, ever: a device with no mirror starts empty and the
      // plant's own masters arrive with the first snapshot.
      state: local ? migrateState(local.state) : migrateState({}),
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
  /** The database's change token (`<n>:<nonce>`), as of our last read or write. */
  const revision = useRef('0')
  /** True while a save is in flight, so the poll does not read a half-written plant. */
  const saving = useRef(false)

  /** True while this device's last save was refused for losing a race. */
  const [conflictHeld, setConflictHeld] = useState(false)
  /** Bumped by the retry timer so a failed save is attempted again on its own. */
  const [retryTick, setRetryTick] = useState(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * A save that failed for something time heals — no signal, or the server's
   * write budget spent for this minute — used to never be tried again until the
   * operator happened to change something else, so work sat on the device while
   * its holder believed it had saved. One timer, one retry at a time.
   */
  const scheduleRetry = useCallback((sec: number) => {
    const wait = Math.min(300, Math.max(5, sec))
    if (retryTimer.current) clearTimeout(retryTimer.current)
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null
      setRetryTick((n) => n + 1)
    }, wait * 1000)
  }, [])
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
    },
    [],
  )

  /** True while the device's own mirror refuses writes — see writeMirror. */
  const [mirrorFailed, setMirrorFailed] = useState(false)
  const mirrorFailedRef = useRef(false)
  /**
   * Writes the mirror and reports honestly whether it landed. A quota blown or
   * a private window used to swallow inside localDb, so "changes are held on
   * this device" stayed printed while nothing was being held anywhere. The
   * banner this raises (SaveIndicator) clears only when a write lands again —
   * and the offline toasts below read the ref to stop promising a copy that is
   * not being made.
   */
  const writeMirror = useCallback(
    (copy: Omit<LocalCopy, 'savedAt'>) => {
      if (writeLocal(copy)) {
        if (mirrorFailedRef.current) {
          mirrorFailedRef.current = false
          setMirrorFailed(false)
        }
        return
      }
      if (!mirrorFailedRef.current) {
        mirrorFailedRef.current = true
        setMirrorFailed(true)
        showToast('This device cannot store its local copy — keep this tab open until changes are saved.')
      }
    },
    [showToast],
  )

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
   *  - This device holds work that never reached the server, and the server *has*
   *    moved on. Both are real, and the merge is per document: writes are keyed
   *    upserts, so this device's work lands on top of the server's without erasing
   *    anything posted meanwhile. The diff runs against the base recorded when the
   *    work was done, NOT against the server just read — diffing against the fresh
   *    server made every untouched row look already-present, and the push then
   *    deleted the colleagues' rows wholesale.
   *  - This device holds nothing unsaved. Take the server's copy, which is the record.
   */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const local = readLocal()
      // The state this device painted from before the first read went out —
      // held in a local because the awaits below defeat narrowing on the ref.
      const painted = boot.current!.state
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
            const mirror = migrateState(local.state)
            synced.current = mirror
            revision.current = rev
            setState(installSnapshot(mirror, painted))
            return
          }
        }
        const remote = await fetchDb()
        if (cancelled) return
        revision.current = remote.revision
        // The BFF speaks the caller's permissions with every snapshot — adopting
        // them here means a role change lands on the next poll, no reload needed.
        setSessionPermissions(remote.permissions)

        // What the database holds is the plant, empty or not — reading it back
        // never invents masters, so a plant somebody cleared stays cleared. A
        // scoped caller's snapshot arrives without the tables they may not read
        // (named in `withheld`): those keys are restored from what this device
        // painted, BEFORE migrate — the server was never asked about them, so
        // this device's last view of them stays the truth, and an absent key
        // would otherwise read as "never written" to the seeding and as a wipe
        // to the merge.
        const server = remote.state ? migrateState(restoreWithheld(remote, painted).state) : null
        if (server) synced.current = server

        // Work this device did without a signal is real work, and the only copy of it.
        // It is adopted and pushed up; because writes are now per-document upserts,
        // that merges with whatever else was posted meanwhile instead of erasing it.
        const unsaved = local?.dirty && activityScore(local.state) > 0
        if (unsaved) {
          // Diff against the recorded base — the last state this device knows the
          // database held — never the fresh server (see the effect note above). A
          // mirror with no base recorded predates bases or lost them to a quota
          // squeeze; it knows nothing about the server, so everything is written
          // and nothing removed — the safe direction to be wrong in.
          synced.current = local.base ? migrateState(local.base) : null
          setState(installSnapshot(migrateState(local.state), painted))
          setDirty(true)
          if (server) showToast('Reconnected — saving the work done on this device.')
          return
        }

        // No row at all means a first run: an empty state, nothing seeded.
        setState(
          installSnapshot(
            server ?? (local ? migrateState(local.state) : migrateState({})),
            painted,
          ),
        )
      } catch (e) {
        if (cancelled) return
        if (e instanceof UnauthorizedError) {
          // A dead session is not an outage — dbApi has already told AuthContext,
          // which swaps in the login screen. This device's copy stays the record.
          synced.current = null
          if (local) setState(installSnapshot(migrateState(local.state), painted))
          showToast(e.message)
          return
        }
        // Offline at startup. The device's own copy is the only record there is —
        // but a device that has synced before still holds a legitimate view of
        // the server (a clean mirror at its recorded revision, or a dirty
        // mirror's recorded base), and diffing against null made every edit of
        // an existing row a guaranteed 409 'exists' at reconnect even when
        // nobody else had touched it. Only a mirror with no view at all falls
        // back to null: everything written, nothing removed.
        synced.current = offlineBootBase(
          local && {
            dirty: local.dirty,
            hasRevision: local.revision !== undefined,
            base: local.base ? migrateState(local.base) : null,
            mirror: migrateState(local.state),
          },
        )
        if (local) {
          setState(installSnapshot(migrateState(local.state), painted))
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
        // A read that straddled a commit is not a snapshot: the revision moved
        // between the two reads, so these rows belong to a version that is no
        // longer the token that asked for them. The next poll reads a
        // consistent pair.
        if (remote.revision !== rev) return
        // Our own save may have landed while the snapshot was in flight — the
        // guard above passed because saving.current had already cleared. A
        // revision older than ours means what this device holds is already
        // newer than anything this snapshot can teach it: installing it would
        // undo the save row by row and roll the token back to before it.
        if (revNum(remote.revision) < revNum(revision.current)) return
        revision.current = remote.revision
        setSessionPermissions(remote.permissions)
        if (!remote.state) return
        // Same withheld rule as the reconcile: the tables this caller may not
        // read come back from the last synced view, so a partial snapshot never
        // installs as a wipe.
        const server = migrateState(restoreWithheld(remote, synced.current).state)
        const was = synced.current
        setState(installSnapshot(server, was))
        synced.current = server
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
   * a signal that drops keeps the work. It also records the base the diff runs
   * against — the last state the database is known to hold — so a reload pushes the
   * same difference it would have, instead of re-deriving one against whatever the
   * server holds by then. The server write refuses to land on top of a row somebody
   * else changed first (409), and the conflict branch below adopts the winner
   * rather than overwriting them.
   */
  useEffect(() => {
    if (!ready) return
    // Already what the database holds — after adopting the poll's copy, say. Recording
    // it as unsaved would have the next startup treat it as offline work and announce
    // that it was saving something that had never left.
    if (state === synced.current) {
      writeMirror({ state, dirty: false, revision: revision.current })
      return
    }
    writeMirror({ state, dirty: true, revision: revision.current, base: synced.current ?? null })

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
            setConflictHeld(false)
            writeMirror({ state, dirty: false, revision: revision.current })
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
          if (result.reason === 'conflict') {
            // Another device saved the same records first and the server refused
            // the whole push before writing any of it. Their versions win for the
            // documents named in the refusal; the whole slice of each — row,
            // ledger lines, audit entries, counters — is adopted into both the
            // state and the base, so what is shown is the plant and the re-save
            // pushes only what is genuinely this device's. Work on those documents
            // that was entered here is the operator's to re-enter; the toast names
            // what lost.
            setConflictHeld(true)
            showToast(
              `Another device saved ${result.conflicts.map((c) => c.id).join(', ')} first — ` +
                'their version is now shown. Re-enter your changes to those documents.',
            )
            ;(async () => {
              try {
                const remote = await fetchDb()
                if (!live || !remote.state) return
                revision.current = remote.revision
                setSessionPermissions(remote.permissions)
                const serverState = migrateState(remote.state)
                if (synced.current) {
                  // The base takes the SERVER's counters verbatim while the live
                  // state (below) takes the per-key max — the difference between
                  // them is the counter diff the re-save re-emits, so the server
                  // catches up to the higher number this device minted offline.
                  synced.current = adoptServerRows(synced.current, serverState, result.conflicts, {
                    counters: 'server',
                  })
                }
                // Functional, and merged against the live state rather than the
                // one this save started from: anything edited while the adoption
                // read was in flight is this device's pending work and must
                // survive it (the doc-chain scan inside adoptServerRows reads
                // the live state for exactly that).
                setState((liveNow) => adoptServerRows(liveNow, serverState, result.conflicts))
              } catch {
                // The read can fail offline. Without a retry the flag stayed up
                // until the operator happened to change something else, so the
                // plant sat showing a lost race that had already been won. The
                // tick re-runs the save effect; the 409 it gets back — or the
                // adoption on success — comes with it.
                scheduleRetry(5)
              }
            })()
            return
          }
          setOffline(true)
          // Said once per outage rather than once per session: the old flag latched
          // forever, so an operator working through a bad afternoon saw one toast and
          // then silence while nothing at all was reaching the database.
          if (!saveErrorShown.current) {
            saveErrorShown.current = true
            showToast(
              mirrorFailedRef.current
                ? 'Offline — and this device cannot store its copy, so changes live only in this tab. Keep it open.'
                : 'Offline — changes are held on this device until you reconnect.',
            )
          }
          scheduleRetry(30)
        })
        .catch((e) => {
          if (!live) return
          setDirty(true)
          setOffline(true)
          // Throttled carries the server's own Retry-After; anything else gets a
          // half-minute probe.
          scheduleRetry(e instanceof ThrottledError ? e.retryAfterSec : 30)
          if (!saveErrorShown.current) {
            saveErrorShown.current = true
            showToast(
              mirrorFailedRef.current
                ? 'Offline — and this device cannot store its copy, so changes live only in this tab. Keep it open.'
                : 'Offline — changes are held on this device until you reconnect.',
            )
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
  }, [ready, retryTick, scheduleRetry, showToast, state, writeMirror])

  const saveStatus: SaveStatus = useMemo(
    () => ({ dirty, offline, conflict: conflictHeld, mirrorFailed }),
    [conflictHeld, dirty, mirrorFailed, offline],
  )

  const rows = useMemo(() => stockRows(state), [state])

  // The over-draw fold runs on the same ledger as `rows`; empty on a healthy
  // plant, so the banner below simply stays gone.
  const overdrawn = useMemo(() => overdrawnLots(state), [state])

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
      overdrawn,
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
      overdrawn,
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
