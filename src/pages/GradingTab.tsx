/**
 * The Coconut Grading stage form (WORKFLOW W7, behind the pipeline flag) —
 * where a lot the gate received unsorted (the Receipt form's "Grade later")
 * gets its grades. One queue of staged lots, one set of grade fields, and the
 * same questions the write path asks answered before they are asked: the
 * grades must sort exactly the load the gate counted, priced by the same
 * priceGrn the receipt itself ran.
 *
 * The write is POST /api/grading — the SERVER re-derives the costs, stamps
 * gradedOn, and books the ledger's paired Grading lines that move the load out
 * of quarantine. None of that is re-derived here: after a 200 the lot simply
 * leaves the queue when the next snapshot lands, and the ledger lines are never
 * the client's to compute.
 */
import { useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import { SectionedForm } from '../components/shell/SectionedForm'
import { ScanInput } from '../components/shell/ScanInput'
import { Select } from '../components/Select'
import { priceGrn } from '../lib/grn'
import { PoApiError, postStagedGrading } from '../lib/gradingApi'
import { gradingInput, pendingGrading, remainingToSort } from '../lib/gradingStage'
import { fmtDate, fmtQty, inr } from '../lib/utils'

type NumValue = number | ''
const num = (v: NumValue) => Number(v) || 0

/** Grades are per-lot — they start empty every time a lot is picked. */
const blankGrades = { a: '' as NumValue, b: '' as NumValue, c: '' as NumValue, reject: '' as NumValue, free: '' as NumValue }

export function GradingTab() {
  const { state } = useApp()
  const toast = useToast()
  const [picked, setPicked] = useState('')
  const [grades, setGrades] = useState(blankGrades)
  const [scanNote, setScanNote] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  /** Lots this form has graded (or heard were graded elsewhere) — the server
   *  already moved them; the snapshot drops them from the queue within one
   *  poll/SSE tick, and until it does the queue does not re-offer them. */
  const [done, setDone] = useState<Record<string, number | 'graded elsewhere'>>({})

  const queue = useMemo(() => pendingGrading(state.grns).filter((g) => !done[g.id]), [state.grns, done])
  // still only a gradable lot: once the snapshot carries gradedOn, the form
  // section folds away rather than grading a lot the server has already sorted
  const grn = queue.find((g) => g.id === picked)

  const typed = useMemo(
    () =>
      grn
        ? {
            a: num(grades.a),
            b: num(grades.b),
            c: num(grades.c),
            reject: num(grades.reject),
            ...(grades.free === '' ? {} : { free: num(grades.free) }),
          }
        : undefined,
    [grn, grades],
  )

  /** The whole client-side check: the staged lot re-priced as a gate-graded
   *  receipt, through the same priceGrn (same words, same tolerance). */
  const math = grn && typed ? priceGrn(gradingInput(grn, typed)) : undefined
  const remaining = grn && typed ? remainingToSort(grn, typed) : 0
  const unit = (grn?.uom || 'piece').toLowerCase()
  /** The priced half of the live note — only an ok math has numbers to show. */
  const costNote = math?.ok
    ? ` Accepted ${fmtQty(math.accepted)} ${unit} · landed ${inr(math.landed)} · ${inr(math.usableCost)} per usable ${unit.replace(/s$/, '')}.`
    : ''

  const setGrade = (key: keyof typeof blankGrades, value: string) =>
    setGrades((g) => ({ ...g, [key]: value === '' ? '' : Number(value) }))

  const pick = (id: string) => {
    setPicked(id)
    setGrades(blankGrades)
    setFormError('')
    setScanNote('')
  }

  const scanLot = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const found = queue.find(
      (g) => g.lot.toLowerCase() === wanted || g.id.toLowerCase() === wanted,
    )
    if (!found) {
      setScanNote(
        queue.length
          ? `No waiting lot reads ${code}.`
          : `Nothing is waiting for grading — ${code} included.`,
      )
      return
    }
    pick(found.id)
  }

  const submit = () => {
    if (!grn || !typed) return
    setFormError('')
    // The snapshot rides the documents row's version (contracts v1.6) — the
    // CAS token the endpoint checks. A copy without one is too old to grade
    // from; the next refresh brings it.
    if (grn.version === undefined) {
      setFormError('This device’s copy of the receipt is still loading its version — try again in a moment.')
      return
    }
    if (!math?.ok) {
      setFormError(math && !math.ok ? math.error : 'Enter the grades before posting.')
      return
    }
    const expectedVersion = grn.version
    setBusy(true)
    void (async () => {
      try {
        const out = await postStagedGrading({
          grnId: grn.id,
          expectedVersion,
          a: typed.a,
          b: typed.b,
          c: typed.c,
          reject: typed.reject,
          ...(typed.free !== undefined ? { free: typed.free } : {}),
        })
        setDone((d) => ({ ...d, [grn.id]: out.accepted }))
        pick('')
        toast(`${out.lot} graded — ${fmtQty(out.accepted)} ${unit} accepted and released into stock.`)
      } catch (e) {
        if (e instanceof PoApiError && e.code === 'cas_version') {
          setFormError('This receipt changed after you read it — the fresh copy is arriving; grade it again.')
        } else if (e instanceof PoApiError && e.code === 'already_graded') {
          setDone((d) => ({ ...d, [grn.id]: 'graded elsewhere' }))
          setFormError(`${grn.id} was already graded — it is out of the queue.`)
        } else {
          setFormError(e instanceof Error ? e.message : 'The grading could not be posted.')
        }
      } finally {
        setBusy(false)
      }
    })()
  }

  const gradeFields: [keyof typeof blankGrades, string][] = [
    ['a', 'Grade A'],
    ['b', 'Grade B'],
    ['c', 'Grade C'],
    ['reject', 'Rejected'],
  ]

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Grade coconuts</h2>
          <span className="cell-sub">
            Lots the gate held unsorted, sorted now — accepted moves into stock, rejected out
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'queue',
            title: 'Waiting to be graded',
            hint: queue.length ? `${queue.length} lot${queue.length === 1 ? '' : 's'} held from the gate` : undefined,
            children: (
              <div>
                {queue.length ? (
                  <>
                    <div className="form-grid">
                      <label className="span-2">
                        Lot
                        <Select value={picked} onChange={(e) => pick(e.target.value)}>
                          <option value="">Select a lot to grade</option>
                          {queue.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.lot} · {g.productName || 'Raw material'} ·{' '}
                              {g.farmerName || g.farmer || 'direct'} · {fmtQty(g.total)} {g.uom?.toLowerCase()} ·{' '}
                              received {fmtDate(g.date)}
                            </option>
                          ))}
                        </Select>
                      </label>
                    </div>
                    <div style={{ marginTop: 8, maxWidth: 360 }}>
                      <ScanInput label="Lot number" onScan={scanLot} placeholder="Scan or type a lot number" />
                    </div>
                  </>
                ) : (
                  <p className="cell-sub">
                    No lots are waiting. A lot lands here when the Receipt form takes it with “Grade
                    later” — the whole load sits in quarantine until it is sorted here.
                  </p>
                )}
                {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
                {Object.entries(done).length ? (
                  <p className="cell-sub" style={{ marginTop: 8 }}>
                    {Object.entries(done)
                      .map(([id, accepted]) =>
                        accepted === 'graded elsewhere'
                          ? `${id} graded elsewhere`
                          : `${id} graded — ${accepted} accepted`,
                      )
                      .join(' · ')}
                  </p>
                ) : null}
              </div>
            ),
          },
          ...(grn
            ? [
                {
                  id: 'grades',
                  title: `Sort ${grn.lot}`,
                  hint: `${fmtQty(grn.total)} ${unit} received${grn.free ? ` — ${fmtQty(grn.free)} free at the gate` : ''}`,
                  children: (
                    <div>
                      <div className="form-grid">
                        {gradeFields.map(([key, label]) => (
                          <label key={key}>
                            {label}
                            <input
                              type="number"
                              min="0"
                              step="1"
                              placeholder="0"
                              value={grades[key]}
                              onChange={(e) => setGrade(key, e.target.value)}
                            />
                          </label>
                        ))}
                        <label>
                          Free {unit} (overrides the gate’s {fmtQty(grn.free ?? 0)})
                          <input
                            type="number"
                            min="0"
                            step="1"
                            placeholder={String(grn.free ?? 0)}
                            value={grades.free}
                            onChange={(e) => setGrade('free', e.target.value)}
                          />
                        </label>
                      </div>
                      {remaining > 0 || grades.a !== '' || grades.b !== '' || grades.c !== '' || grades.reject !== '' ? (
                        <div className="note">
                          {remaining > 0
                            ? `${fmtQty(remaining)} ${unit} still to sort — the grades must account for the whole ${fmtQty(grn.total)} received.`
                            : `The grades account for the whole load.`}
                          {costNote}
                        </div>
                      ) : null}
                      <p className="cell-sub" style={{ marginTop: 8 }}>
                        {grn.farmerName || grn.farmer || 'Direct purchase'}
                        {grn.area ? ` · ${grn.area}` : ''} · rate {inr(grn.rate)}/{unit.replace(/s$/, '')}
                        {grn.transport ? ` · transport ${inr(grn.transport)}` : ''} · held in quarantine since{' '}
                        {fmtDate(grn.date)}
                      </p>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
        footer={
          grn ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
                {busy ? 'Posting…' : `Post grades for ${grn.lot}`}
              </button>
              {formError ? <span className="form-error">{formError}</span> : null}
            </div>
          ) : formError ? (
            <span className="form-error">{formError}</span>
          ) : undefined
        }
      />
    </div>
  )
}
