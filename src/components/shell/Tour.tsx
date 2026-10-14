/**
 * The first-run tour (WORKFLOW W16, behind the `pipeline` flag): a spotlight
 * stepper over the shell's own chrome. Steps and words come from
 * lib/onboarding.ts; anchors are the `data-tour` attributes Layout and the
 * Pipeline board stamp. A step whose anchor is missing or hidden (a phone's
 * collapsed drawer, an off flag) renders as a plain centered card — the tour
 * never depends on the viewport, it just loses the ring.
 *
 * Keyboard: → / ← move, Esc ends. Buttons meet the 44px rule; focus lands on
 * Next at every step, so Enter carries the tour to the end on its own.
 */
import { useEffect, useRef, useState } from 'react'
import type { TourStep } from '../../lib/onboarding.ts'

interface TourProps {
  steps: TourStep[]
  open: boolean
  /** finished=true when the last step's Done was pressed; false = skipped. */
  onDone: (finished: boolean) => void
}

/** The anchor's on-screen box, or null when it cannot be spotlighted. */
function anchorRect(selector: string | undefined): DOMRect | null {
  if (!selector) return null
  const el = document.querySelector(selector)
  const rect = el?.getBoundingClientRect()
  // display:none (the phone's collapsed sidebar) measures all-zero — no ring.
  return rect && rect.width > 0 && rect.height > 0 ? rect : null
}

export function Tour({ steps, open, onDone }: TourProps) {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const step = steps[index]
  const last = index >= steps.length - 1

  // Every open restarts from the welcome card.
  useEffect(() => {
    if (open) setIndex(0)
  }, [open])

  // Focus the forward button each step — Enter then walks the whole tour.
  useEffect(() => {
    if (open) nextRef.current?.focus()
  }, [open, index])

  // Measure the anchor now, and again whenever the page moves under it.
  useEffect(() => {
    if (!open || !step) return
    const selector = step.anchor
    const measure = () => setRect(anchorRect(selector))
    measure()
    window.addEventListener('resize', measure)
    // capture: the app scrolls in inner panes, not always the window
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, step])

  if (!open || !step) return null

  const go = (delta: number) => setIndex((i) => Math.min(Math.max(i + delta, 0), steps.length - 1))

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onDone(false)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      go(1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      go(-1)
    }
  }

  // Card placement: beside the ring when there is one, centered when not.
  // The estimates keep the card on screen without a second measure pass.
  const vw = window.innerWidth
  const vh = window.innerHeight
  const cardW = Math.min(380, vw - 32)
  const cardStyle: React.CSSProperties = rect
    ? {
        left: Math.max(16, Math.min(rect.left, vw - cardW - 16)),
        top:
          rect.bottom + 12 + 230 < vh
            ? rect.bottom + 12
            : Math.max(16, rect.top - 12 - 230),
      }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }

  return (
    <div onKeyDown={onKeyDown}>
      {/* Swallows clicks so the tour cannot fall through into the page under
          it; ending the tour is a decision (Esc, Skip, Done), not a stray tap. */}
      <div className="tour-catcher" aria-hidden="true" />
      {rect ? (
        <div
          className="tour-ring"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
          aria-hidden="true"
        />
      ) : null}
      <div
        className="tour-card"
        style={{ ...cardStyle, width: rect ? cardW : Math.min(420, vw - 40) }}
        role="dialog"
        aria-modal="true"
        aria-label={`Tour: ${step.title}`}
      >
        <p className="tour-step">
          Step {index + 1} of {steps.length}
          {rect ? '' : ' — this one is not on screen here'}
        </p>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-dots" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.id} className={i === index ? 'on' : ''} />
          ))}
        </div>
        <div className="tour-actions">
          <button type="button" className="btn btn-light" onClick={() => onDone(false)}>
            Skip
          </button>
          {index > 0 ? (
            <button type="button" className="btn btn-light" onClick={() => go(-1)}>
              Back
            </button>
          ) : null}
          <button
            ref={nextRef}
            type="button"
            className="btn btn-primary"
            onClick={() => (last ? onDone(true) : go(1))}
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
