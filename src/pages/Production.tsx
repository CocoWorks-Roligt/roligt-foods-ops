/**
 * Production — both stages of it, on one page.
 *
 * Extraction and melange runs were two separate pages, each filtering the same batch
 * list to hide the other's rows. They are the same operation: both post through
 * `createBatch`, both mint a lot, a QC record and packs, and Quality Control does not
 * tell them apart. The only difference is what gets issued — raw produce, or bulk that
 * an earlier batch pressed — which is a choice of form, not a choice of page.
 */

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ExtractionBatches } from '../components/ExtractionBatches'
import { MelangeRuns } from '../components/MelangeRuns'

type Stage = 'extraction' | 'melange'

const STAGES: { id: Stage; label: string; blurb: string }[] = [
  { id: 'extraction', label: 'Extraction', blurb: 'Press raw produce into bulk' },
  { id: 'melange', label: 'Melange', blurb: 'Blend that bulk to a recipe' },
]

export function Production() {
  // /production?stage=melange is where the old /melanges link lands.
  const [params] = useSearchParams()
  const [stage, setStage] = useState<Stage>(
    params.get('stage') === 'melange' ? 'melange' : 'extraction',
  )
  // A link to a melange run lands here with ?stage=melange while the page may already be
  // open on extraction, so the tab follows the address as well as the click.
  const linkedStage = params.get('stage')
  useEffect(() => {
    if (linkedStage === 'melange' || linkedStage === 'extraction') setStage(linkedStage)
  }, [linkedStage])

  return (
    <div className="production-page">
      <div className="stage-picker stage-picker-2">
        {STAGES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`stage-card${stage === s.id ? ' active' : ''}`}
            onClick={() => setStage(s.id)}
          >
            <b>{s.label}</b>
            <span>{s.blurb}</span>
          </button>
        ))}
      </div>

      {stage === 'melange' ? <MelangeRuns /> : <ExtractionBatches />}
    </div>
  )
}
