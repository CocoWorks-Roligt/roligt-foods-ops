import type { Dispatch, SetStateAction } from 'react'
import type { Attachment, AppState, StockRow } from '../../types'

/**
 * The plumbing every domain hook shares.
 *
 * `AppContext` used to be one file of nearly three thousand lines holding every write
 * the application can make — procurement, production, packing, QC, dispatch, six
 * masters, stickers, numbering and cleanup — which is about as clear a Single
 * Responsibility failure as a codebase produces. The operations themselves were
 * already grouped by domain and already closed over the same handful of things; this
 * is that handful, named, so each group can live in its own file.
 *
 * The provider still owns the state and its persistence. Nothing below it decides how
 * anything is stored — a hook is handed `setState` and writes a draft, exactly as it
 * did when it lived in the same file.
 */
export interface CoreDeps {
  state: AppState
  setState: Dispatch<SetStateAction<AppState>>
  /** Mints the next code in a series, advancing its counter on the draft. */
  nextId: (draft: AppState, type: keyof AppState['counters']) => string
  nextLot: (draft: AppState) => string
  log: (draft: AppState, action: string, doc: string, details: string) => void
  showToast: (message: string) => void
  /**
   * A message naming a document that does not exist yet. Set inside a `setState`
   * updater and shown once React has committed it — see the note in AppContext.
   */
  announcement: { current: string | null }
  /** Refuses an action that is not this user's to take, and says so. */
  forbidden: (what: string) => boolean
  rows: StockRow[]
  /** Who is signed in, for the audit trail and QC signatures. */
  actor: string
  vendorTypeName: (id: string) => string
}

/**
 * What a posting returns when it worked but its document code is not yet readable.
 * Callers use the result as a success flag, never as an id.
 */
export const POSTED = 'ok'

/**
 * A packing-material receipt as the form states it. Shared by add and edit.
 *
 * Raised on the Procurement page beside a produce receipt, because receiving a pallet
 * of BiBs and receiving a load of coconuts are the same job — they used to live on
 * two different screens with two different vocabularies.
 */
export interface PackingStockInput {
  /** When it arrived. Defaults to now for a receipt posted before this was asked for. */
  date?: string
  /** The purchase product picked on the form; the item it books is read off it. */
  purchaseProductId?: string
  itemId: string
  qty: number
  unitCost: number
  lot: string
  location?: string
  /** Optional: packing material may come from a vendor the plant never registered. */
  vendorId?: string
}

/** What closing a delivery records. The photographs are the proof. */
export interface DeliveryInput {
  status: string
  /** Who signed for it, or the slip reference. */
  pod: string
  note?: string
  /** Photographs taken at the door. */
  photos?: Attachment[]
}
