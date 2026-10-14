/**
 * The Control Sample destruction shelf's pure folds (WORKFLOW W12). Samples are
 * recorded on the packing run that kept them back (W10's form does it) and are
 * never stock; the only thing a kept sample still owes is the day it was
 * destroyed. This is the shelf's queue — the same kept-and-inside-the-horizon
 * predicate pipelineStages counts, offered nearest expiry first so what the
 * tile flags as past expiry is the first row the shelf sees.
 *
 * Nothing is re-derived: sampleStatus and controlSampleRows are the register's
 * own folds, and the write is updateControlSample — the register's own path.
 */
import { addDays, controlSampleRows, type ControlSampleRow } from './controlSamples.ts'
import type { AppState } from '../types.ts'

/** How far ahead the shelf looks — the pipeline tile's own 7-day horizon. */
export const SAMPLE_SHELF_DAYS = 7

/**
 * The destruction shelf's queue: samples still kept whose expiry lands inside
 * the tile's 7-day horizon (an expiry already past counts — the shelf owes a
 * destruction record either way), nearest expiry first. A sample drops out the
 * moment destroyedOn lands (updateControlSample stamps it).
 */
export function dueSamples(state: AppState, today: string): ControlSampleRow[] {
  const horizon = addDays(today, SAMPLE_SHELF_DAYS)
  return controlSampleRows(state, today)
    .filter((r) => r.status !== 'Destroyed' && !!r.sample.expiresOn && r.sample.expiresOn <= horizon)
    .sort(
      (a, b) =>
        (a.sample.expiresOn || '').localeCompare(b.sample.expiresOn || '') ||
        a.producedOn.localeCompare(b.producedOn) ||
        a.key.localeCompare(b.key),
    )
}
