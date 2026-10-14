/**
 * Production — both stages of it, on one page.
 *
 * Extraction and melange runs were two separate pages, each filtering the same batch
 * list to hide the other's rows. They are the same operation: both post through
 * `createBatch`, both mint a lot, a QC record and packs, and Quality Control does not
 * tell them apart. The only difference is what gets issued — raw produce, or bulk that
 * an earlier batch pressed — which is a choice of form, not a choice of page.
 *
 * The pipeline flag adds a third card (WORKFLOW W8): the Extraction stage form,
 * where a pressing is posted AND closed — graded lots in, water and malai out,
 * spoilage said out loud. It is its own lazy chunk; Classic never loads it.
 */

import { Suspense, lazy, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ExtractionBatches } from '../components/ExtractionBatches'
import { MelangeRuns } from '../components/MelangeRuns'
import { useApp } from '../context/AppContext'

/** The pipeline flag's Extraction stage form — its own chunk, so Classic never loads it. */
const ExtractionTab = lazy(() => import('./ExtractionTab').then((m) => ({ default: m.ExtractionTab })))

type Stage = 'extraction' | 'melange' | 'run'

export function Production() {
  const { flags } = useApp()
  // /production?stage=melange is where the old /melanges link lands; ?stage=run
  // (pipeline flag) is where the Extraction tile's open runs link to be closed.
  const [params] = useSearchParams()
  const [stage, setStage] = useState<Stage>(
    params.get('stage') === 'melange' ? 'melange' : params.get('stage') === 'run' ? 'run' : 'extraction',
  )
  // A link to a run lands here with ?stage=… while the page may already be open
  // on another stage, so the tab follows the address as well as the click.
  const linkedStage = params.get('stage')
  useEffect(() => {
    if (linkedStage === 'melange' || linkedStage === 'extraction') setStage(linkedStage)
    else if (linkedStage === 'run' && flags.pipeline) setStage('run')
  }, [linkedStage, flags.pipeline])

  const cards: { id: Stage; label: string; blurb: string }[] = [
    { id: 'extraction', label: 'Extraction', blurb: 'Press raw produce into bulk' },
    { id: 'melange', label: 'Blend', blurb: 'Blend that bulk to a recipe' },
    ...(flags.pipeline
      ? [{ id: 'run' as Stage, label: 'Run a pressing', blurb: 'Graded lots in, water and malai out, closed here' }]
      : []),
  ]

  return (
    <div className="production-page">
      <div className={`stage-picker stage-picker-${cards.length}`}>
        {cards.map((s) => (
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

      {stage === 'melange' ? (
        <MelangeRuns />
      ) : stage === 'run' ? (
        <Suspense fallback={<div className="note">Loading the pressing form…</div>}>
          <ExtractionTab />
        </Suspense>
      ) : (
        <ExtractionBatches />
      )}
    </div>
  )
}
