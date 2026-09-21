import { DocLink } from './DocLink'
import type { DetailSection } from './DetailView'
import { categoryTitle } from '../lib/qcCategories'
import { scoreSensory } from '../lib/sensory'
import { fmtDate } from '../lib/utils'
import type { AppState } from '../types'

/**
 * The "Lab reports" section of a batch's detail view: every report linked to the batch,
 * with what it found and when. Null when there are none, so batches that were never
 * tested this way simply do not show the section.
 */
export function labReportSection(state: AppState, batchId: string): DetailSection | null {
  const reports = state.labReports.filter((r) => r.batchId === batchId)
  if (!reports.length) return null
  return {
    title: 'Lab reports',
    fields: reports.map((r) => {
      const decision = r.scores ? scoreSensory(r.scores, r).decision : null
      return {
        label: categoryTitle(state, r.category),
        value: (
          <>
            <DocLink doc={r.id} />
            {decision ? ` · ${decision.toLowerCase()}` : ''} ·{' '}
            {fmtDate(r.scores ? r.sampleDate : r.issueDate)}
          </>
        ),
      }
    }),
  }
}
