/**
 * One D1Client for the whole BFF — the store seam's construction home.
 *
 * The client is nothing but three strings until a route uses it, so one
 * deployment image serves by env alone: D1_* present ⇒ the store answers;
 * absent ⇒ `d1` stays null and the gated endpoints answer 503 (postRoutes)
 * while the core routes refuse through requireStore (engine.ts) — a
 * misconfigured deployment fails honestly, never silently. The engines'
 * selection seam is engine.ts; this module only owns construction.
 */
import { D1Client } from './d1.js'
import { d1Enabled, type Store } from './store.js'

export const d1: D1Client | null = d1Enabled() ? new D1Client() : null
export const store: Store | null = d1
