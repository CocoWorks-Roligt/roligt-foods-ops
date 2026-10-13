/**
 * A long form cut into named sections — the shape every overhaul workflow
 * form takes (GRN, close run, dispatch): one screen, numbered parts, each
 * collapsible so an operator checking a late field does not scroll past the
 * parts they already answered. Presentational on purpose; the draft autosave
 * (useDraft), validation and submit stay with the page that owns the data.
 */
import { useState, type ReactNode } from 'react'

export interface FormSection {
  id: string
  title: string
  /** One line under the title naming what belongs here. */
  hint?: string
  children: ReactNode
}

export function SectionedForm({ sections, footer }: { sections: FormSection[]; footer?: ReactNode }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="sectioned-form">
      {sections.map((section, i) => {
        const open = !collapsed.has(section.id)
        return (
          <section key={section.id} className="form-section">
            <button
              type="button"
              className="form-section-head"
              aria-expanded={open}
              aria-controls={`form-section-${section.id}`}
              onClick={() => toggle(section.id)}
            >
              <span className="form-section-no" aria-hidden="true">
                {i + 1}
              </span>
              <span className="form-section-title">
                {section.title}
                {section.hint ? <small>{section.hint}</small> : null}
              </span>
              <span className="form-section-caret" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
            </button>
            {open ? (
              <div className="form-section-body" id={`form-section-${section.id}`}>
                {section.children}
              </div>
            ) : null}
          </section>
        )
      })}
      {footer ? <div className="form-footer">{footer}</div> : null}
    </div>
  )
}

/**
 * Where a workflow is a sequence of committed steps rather than one screen —
 * close run's stage gates, the shipment chain. Presentational: the page owns
 * which step is current and whether a completed one may be reopened.
 */
export interface Step {
  id: string
  label: string
}

export function Stepper({
  steps,
  current,
  onStep,
}: {
  steps: Step[]
  /** Index of the step in progress; earlier steps read as done. */
  current: number
  /** Called when a done step's label is tapped — absent makes them inert. */
  onStep?: (index: number) => void
}) {
  return (
    <ol className="stepper">
      {steps.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo'
        const clickable = onStep && i < current
        return (
          <li key={step.id} className={`step ${state}`}>
            {clickable ? (
              <button type="button" onClick={() => onStep?.(i)}>
                <span className="step-dot" aria-hidden="true">
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span className="step-label">{step.label}</span>
              </button>
            ) : (
              <span aria-current={state === 'current' ? 'step' : undefined}>
                <span className="step-dot" aria-hidden="true">
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span className="step-label">{step.label}</span>
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
