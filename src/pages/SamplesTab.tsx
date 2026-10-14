/**
 * The Control Sample destruction shelf (WORKFLOW W12, behind the pipeline
 * flag) — the retention shelf as a queue. Samples are recorded on the packing
 * run that kept them back and are never stock; the only thing a kept sample
 * still owes is the day it was destroyed. This form asks for that day, with
 * whatever expired first at the top.
 *
 * The write is updateControlSample — the SAME Classic path the register's
 * Mark Destroyed button posts through. Its refusals are its own toasts (a
 * destruction before the day of production, a future day, clearing who
 * collected them); the date input bounds itself exactly as the register's
 * dialog does, and a null return leaves this form open.
 */
import { useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'
import { SectionedForm } from '../components/shell/SectionedForm'
import { ScanInput } from '../components/shell/ScanInput'
import { Select } from '../components/Select'
import { sampleStatus } from '../lib/controlSamples'
import { dueSamples } from '../lib/sampleStage'
import { fmtDate, toDateKey } from '../lib/utils'

export function SamplesTab() {
  const { state, updateControlSample } = useApp()
  const today = toDateKey()
  const [picked, setPicked] = useState('')
  const [scanNote, setScanNote] = useState('')
  const [collectedBy, setCollectedBy] = useState('')
  const [destroyedOn, setDestroyedOn] = useState('')
  const [remark, setRemark] = useState('')

  const queue = useMemo(() => dueSamples(state, today), [state, today])
  // Still only a kept sample: the save itself stamps destroyedOn, so a sample
  // destroyed a moment ago folds out of the shelf on the spot.
  const row = queue.find((r) => r.key === picked)

  const pick = (key: string) => {
    const found = queue.find((r) => r.key === key)
    setPicked(key)
    setScanNote('')
    setCollectedBy(found?.sample.collectedBy || '')
    // The day is today unless the register already says another — recording a
    // destruction is the shelf's one job, so it starts filled.
    setDestroyedOn(found ? today : '')
    setRemark(found?.sample.remark || '')
  }

  const scanSample = (code: string) => {
    setScanNote('')
    const wanted = code.trim().toLowerCase()
    const found = queue.find(
      (r) => r.run.id.toLowerCase() === wanted || r.run.batchId.toLowerCase() === wanted,
    )
    if (!found) {
      setScanNote(
        queue.length
          ? `No sample on the shelf reads ${code}.`
          : `Nothing is on the shelf — ${code} included.`,
      )
      return
    }
    pick(found.key)
  }

  const submit = () => {
    if (!row) return
    // updateControlSample stamps the destruction and toasts; on a refusal it
    // returns null and the form stays put with its words already on screen.
    const saved = updateControlSample(row.run.id, row.index, {
      collectedBy,
      destroyedOn,
      remark,
    })
    if (!saved) return
    // The shelf re-folds without the destroyed sample — offer the next one.
    const next = queue.find((r) => r.key !== row.key)
    pick(next ? next.key : '')
  }

  const expired = row ? sampleStatus(row.sample, today) === 'Expired' : false

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <h2>Destruction shelf</h2>
          <span className="cell-sub">
            Samples still kept, in their last week or past expiry — each owes the day it was
            destroyed
          </span>
        </div>
      </div>

      <SectionedForm
        sections={[
          {
            id: 'shelf',
            title: 'On the shelf',
            hint: queue.length ? `${queue.length} sample${queue.length === 1 ? '' : 's'} still kept` : undefined,
            children: (
              <div>
                {queue.length ? (
                  <>
                    <div className="form-grid">
                      <label className="span-2">
                        Sample
                        <Select value={picked} onChange={(e) => pick(e.target.value)}>
                          <option value="">Select a sample</option>
                          {queue.map((r) => (
                            <option key={r.key} value={r.key}>
                              {r.product} · {r.run.batchId} · {r.sample.count} bottle
                              {r.sample.count === 1 ? '' : 's'} · expires {fmtDate(r.sample.expiresOn || '')}
                              {sampleStatus(r.sample, today) === 'Expired' ? ' · PAST EXPIRY' : ''}
                            </option>
                          ))}
                        </Select>
                      </label>
                    </div>
                    <div style={{ marginTop: 8, maxWidth: 360 }}>
                      <ScanInput
                        label="Run or batch"
                        onScan={scanSample}
                        placeholder="Scan or type a run or batch id"
                      />
                    </div>
                  </>
                ) : (
                  <p className="cell-sub">
                    Nothing is due. A sample reaches this shelf in its last week before expiry
                    (and stays here past it until destroyed); samples are recorded on the packing
                    run that kept them back.
                  </p>
                )}
                {scanNote ? <p className="cell-sub">{scanNote}</p> : null}
              </div>
            ),
          },
          ...(row
            ? [
                {
                  id: 'destroy',
                  title: `${row.product} · ${row.run.batchId}`,
                  hint: `${row.sample.count} bottle${row.sample.count === 1 ? '' : 's'} produced ${fmtDate(row.producedOn)} · expires ${fmtDate(row.sample.expiresOn || '')}`,
                  children: (
                    <div>
                      <div className="form-grid">
                        <label>
                          Collected by
                          <input value={collectedBy} onChange={(e) => setCollectedBy(e.target.value)} />
                        </label>
                        <label>
                          Destroyed on
                          <input
                            type="date"
                            min={row.producedOn}
                            max={today}
                            value={destroyedOn}
                            onChange={(e) => setDestroyedOn(e.target.value)}
                          />
                        </label>
                        <label className="span-2">
                          Remark
                          <textarea value={remark} onChange={(e) => setRemark(e.target.value)} />
                        </label>
                      </div>
                      <div className={`note${expired ? ' warning-note' : ''}`}>
                        {expired
                          ? `Past expiry since ${fmtDate(row.sample.expiresOn || '')} — the shelf owes its destruction record.`
                          : 'Still inside its retention — destroying it now is fine; the record is the point.'}{' '}
                        Leave the date destroyed empty while the bottles are still kept.
                      </div>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
        footer={
          row ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn-primary" onClick={submit}>
                {destroyedOn ? `Record destroyed ${fmtDate(destroyedOn)}` : 'Save'}
              </button>
            </div>
          ) : undefined
        }
      />
    </div>
  )
}
