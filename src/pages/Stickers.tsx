import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { useApp } from '../context/AppContext'
import {
  DEFAULT_STICKER_HEIGHT_MM,
  DEFAULT_STICKER_WIDTH_MM,
  STICKER_STAGES,
  candidatesFor,
  stageLabel,
  stickerLines,
  templateFor,
  type StickerCandidate,
  stickerReferenceLabel,
} from '../lib/stickers'
import { fmtDate } from '../lib/utils'
import type { StickerStage, StickerTemplate } from '../types'

/** Common label stock, so the size is a pick rather than a measurement. */
const SIZE_PRESETS = [
  { label: '100 × 50 mm', w: 100, h: 50 },
  { label: '100 × 75 mm', w: 100, h: 75 },
  { label: '75 × 50 mm', w: 75, h: 50 },
  { label: '60 × 40 mm', w: 60, h: 40 },
  { label: '50 × 25 mm', w: 50, h: 25 },
]

const isStage = (v: string | null): v is StickerStage =>
  !!v && STICKER_STAGES.some((s) => s.stage === v)

export function Stickers() {
  const { state, printStickers, saveStickerTemplate, saveStickerSize } = useApp()
  // Procurement and Packing link straight here with the record they just posted.
  const [params, setParams] = useSearchParams()
  const [stage, setStage] = useState<StickerStage>(() =>
    isStage(params.get('stage')) ? (params.get('stage') as StickerStage) : 'pack',
  )
  const [search, setSearch] = useState(() => params.get('q') || '')
  const [picked, setPicked] = useState(() => params.get('ref') || '')
  const [copies, setCopies] = useState(1)
  const [setupOpen, setSetupOpen] = useState(false)
  const [draft, setDraft] = useState<StickerTemplate>(() => templateFor(state, stage))
  /** Set by any edit to the layout, so a background state load cannot discard it. */
  const edited = useRef(false)

  const width = state.config.stickerWidthMm || DEFAULT_STICKER_WIDTH_MM
  const height = state.config.stickerHeightMm || DEFAULT_STICKER_HEIGHT_MM

  const candidates = useMemo(() => candidatesFor(state, stage), [state, stage])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return candidates
    // The reference is the id an operator reads off a screen — DSP-2026-0001,
    // PKG-2026-0001 — and it was the one thing the search did not look at, so a
    // deep link from a dispatch row landed on "nothing matches".
    return candidates.filter((c) =>
      [c.reference, c.heading, c.sub, ...Object.values(c.values)]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [candidates, search])

  const selected = candidates.find((c) => c.reference === picked)

  // The saved templates arrive from the database a moment after the first paint, so
  // the form has to pick them up — but never over the top of an unsaved edit.
  useEffect(() => {
    if (edited.current) return
    setDraft(templateFor(state, stage))
  }, [stage, state])

  // A deep link names one record; consume it once so moving around the page after
  // that behaves like an ordinary visit.
  useEffect(() => {
    if (!params.get('ref') && !params.get('stage') && !params.get('q')) return
    const ref = params.get('ref')
    const match = candidates.find((c) => c.reference === ref)
    if (match) setCopies(match.suggestedCopies)
    setParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates])

  /** Switching stage swaps the record list and the layout, so nothing carries over. */
  const pickStage = (next: StickerStage) => {
    edited.current = false
    setStage(next)
    setDraft(templateFor(state, next))
    setPicked('')
    setSearch('')
  }

  const editDraft = (fn: (t: StickerTemplate) => StickerTemplate) => {
    edited.current = true
    setDraft(fn)
  }

  const choose = (c: StickerCandidate) => {
    setPicked(c.reference)
    setCopies(c.suggestedCopies)
  }

  const lines = selected ? stickerLines(draft, selected.values) : []

  const print = () => {
    if (!selected) return
    printStickers([
      {
        stage,
        reference: selected.reference,
        title: draft.title,
        lines,
        copies: Math.max(1, Math.round(copies) || 1),
      },
    ])
  }

  const toggleField = (key: string) =>
    editDraft((t) => ({
      ...t,
      fields: t.fields.map((f) => (f.key === key ? { ...f, show: !f.show } : f)),
    }))

  const renameField = (key: string, label: string) =>
    editDraft((t) => ({
      ...t,
      fields: t.fields.map((f) => (f.key === key ? { ...f, label } : f)),
    }))

  const move = (key: string, by: number) =>
    editDraft((t) => {
      const idx = t.fields.findIndex((f) => f.key === key)
      const to = idx + by
      if (idx < 0 || to < 0 || to >= t.fields.length) return t
      const fields = [...t.fields]
      const [row] = fields.splice(idx, 1)
      fields.splice(to, 0, row)
      return { ...t, fields }
    })

  const recent = (state.stickerPrints || []).slice(0, 12)

  return (
    <div className="stickers-page">
      <div className="card">
        <div className="section-head">
          <div>
            <h3>What are you labelling?</h3>
            <span>Every stage prints its own sticker, with its own details.</span>
          </div>
        </div>
        <div className="stage-picker">
          {STICKER_STAGES.map((s) => (
            <button
              key={s.stage}
              type="button"
              className={`stage-card${stage === s.stage ? ' active' : ''}`}
              onClick={() => pickStage(s.stage)}
            >
              <b>{s.label}</b>
              <span>{s.blurb}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sticker-columns">
        <div className="card">
          <div className="section-head">
            <div>
              <h3>Pick the {stageLabel(stage).toLowerCase().replace(/s$/, '')}</h3>
              <span>{shown.length} available</span>
            </div>
          </div>
          <div className="toolbar">
            <input
              placeholder="Search lot, batch, product or supplier"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!shown.length ? (
            <div className="empty">
              <EmptyState
                filtered={!!search}
                empty={`Nothing to label yet — ${stageLabel(stage).toLowerCase()} appear here once they are recorded.`}
                onClear={() => setSearch('')}
              />
            </div>
          ) : (
            <div className="pick-list">
              {shown.slice(0, 60).map((c) => (
                <button
                  key={c.reference}
                  type="button"
                  className={`pick-row${picked === c.reference ? ' active' : ''}`}
                  onClick={() => choose(c)}
                >
                  <b>{c.heading}</b>
                  <span className="small">{c.sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="section-head">
            <div>
              <h3>Sticker</h3>
              <span>
                {width} × {height} mm · exactly what prints
              </span>
            </div>
          </div>

          {!selected ? (
            <div className="empty">Pick something on the left to see its sticker.</div>
          ) : (
            <>
              <div className="sticker-stage">
                <div
                  className="sticker-preview"
                  style={{ aspectRatio: `${width} / ${height}` }}
                >
                  <div className="sticker-preview-title">{draft.title}</div>
                  <table>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.label}>
                          <th>{l.label}</th>
                          <td>{l.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!lines.length ? (
                    <div className="small">
                      No fields switched on — open Sticker setup below.
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="print-bar">
                <div className="field">
                  <label>How many stickers?</label>
                  <input
                    type="number"
                    min="1"
                    value={copies}
                    onChange={(e) => setCopies(Number(e.target.value))}
                  />
                </div>
                <button className="btn btn-primary" type="button" onClick={print}>
                  Print {Math.max(1, Math.round(copies) || 1)} sticker
                  {Math.max(1, Math.round(copies) || 1) === 1 ? '' : 's'}
                </button>
              </div>
              {stage === 'pack' && selected.suggestedCopies > 1 ? (
                <div className="note">
                  Set to {selected.suggestedCopies} — one for every pack the run filled.
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h3>Sticker setup</h3>
            <span>What prints on a {stageLabel(stage).toLowerCase()} sticker, and the label size.</span>
          </div>
          <div className="section-head-actions">
            <button
              className="btn btn-light"
              type="button"
              onClick={() => setSetupOpen((v) => !v)}
            >
              {setupOpen ? 'Hide' : 'Change what prints'}
            </button>
          </div>
        </div>

        {setupOpen ? (
          <>
            <div className="form-grid">
              <div className="field span-2">
                <label>Heading across the top</label>
                <input
                  value={draft.title}
                  onChange={(e) => editDraft((t) => ({ ...t, title: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Label size</label>
                <div className="size-presets">
                  {SIZE_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className={`btn btn-light${width === p.w && height === p.h ? ' active' : ''}`}
                      onClick={() => saveStickerSize(p.w, p.h)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="field-table">
              {draft.fields.map((f, i) => (
                <div className={`field-row${f.show ? ' on' : ''}`} key={f.key}>
                  <label className="check-row">
                    <input type="checkbox" checked={f.show} onChange={() => toggleField(f.key)} />
                    <span className="small">{f.show ? 'Prints' : 'Hidden'}</span>
                  </label>
                  <input
                    value={f.label}
                    onChange={(e) => renameField(f.key, e.target.value)}
                    disabled={!f.show}
                  />
                  <div className="row-actions">
                    <button
                      className="btn btn-light"
                      type="button"
                      disabled={i === 0}
                      onClick={() => move(f.key, -1)}
                      aria-label={`Move ${f.label} up`}
                    >
                      ↑
                    </button>
                    <button
                      className="btn btn-light"
                      type="button"
                      disabled={i === draft.fields.length - 1}
                      onClick={() => move(f.key, 1)}
                      aria-label={`Move ${f.label} down`}
                    >
                      ↓
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="row-actions" style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => {
                  edited.current = false
                  saveStickerTemplate(draft)
                }}
              >
                Save layout
              </button>
              <button
                className="btn btn-light"
                type="button"
                onClick={() => {
                  edited.current = false
                  setDraft(templateFor(state, stage))
                }}
              >
                Undo changes
              </button>
            </div>
            <div className="note">
              The size is shared by every sticker. What prints is saved per stage, so a raw
              lot and a finished pack can each say something different.
            </div>
          </>
        ) : null}
      </div>

      <div className="card">
        <div className="section-head">
          <div>
            <h3>Recently printed</h3>
            <span>Every sticker is kept exactly as it printed, so a reprint matches the one on the box.</span>
          </div>
        </div>
        {!recent.length ? (
          <div className="empty">Nothing printed yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Printed</th>
                  <th>Stage</th>
                  <th>For</th>
                  <th>Copies</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Printed">{fmtDate(p.printedAt)}</td>
                    <td data-label="Stage" className="cell-tight">
                      {stageLabel(p.stage)}
                    </td>
                    <td data-label="For">
                      <b>{stickerReferenceLabel(state, p.stage, p.reference)}</b>
                    </td>
                    <td data-label="Copies" className="cell-tight">
                      {p.copies}
                    </td>
                    <td data-label="Size" className="cell-tight">
                      {p.widthMm} × {p.heightMm} mm
                    </td>
                    <td className="cell-tight">
                      <button
                        className="btn btn-light"
                        type="button"
                        onClick={() =>
                          printStickers([
                            {
                              stage: p.stage,
                              reference: p.reference,
                              title: p.title,
                              lines: p.lines,
                              copies: p.copies,
                            },
                          ])
                        }
                      >
                        Reprint
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
