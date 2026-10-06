import type { VendorType } from '../types'

/**
 * The vendor types the app knows. They are constants of the application, not
 * plant data: no page edits them, `migrateState` pins them into every state,
 * and because both sides of the client's diff always hold the same list, a
 * device can never write them up. The BFF seeds them into the base's Vendor
 * Types table instead (api/_lib/commit.ts) — the first vendors commit upserts
 * any the base is missing, so the Vendors 'Vendor Type' link column always has
 * a row to point at. Kept in this leaf module because the api build imports it
 * too and must not pull the client's migrate graph.
 */
export const FIXED_VENDOR_TYPES: VendorType[] = [
  {
    id: 'VT-FARMER',
    name: 'Farmer',
    sourceKind: 'Farmer',
    description: 'Produce suppliers',
    status: 'Active',
  },
  {
    id: 'VT-VENDOR',
    name: 'Vendor',
    sourceKind: 'Vendor',
    description: 'Material and packing suppliers',
    status: 'Active',
  },
]
