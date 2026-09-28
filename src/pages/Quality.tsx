import { Fragment, useMemo, useRef, useState } from 'react'
import { AttachmentLink } from '../components/Attachments'
import { DetailView, type DetailSection } from '../components/DetailView'
import { detailRowProps } from '../components/detailRow'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import {
  SortHeader,
  SortSelect,
  sortRows,
  useTableSort,
  type SortAccessors,
} from '../components/tableSort'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { batchLabel, batchOutputs, runBulkItem } from '../lib/batches'
import { useLinkedView } from '../lib/linkedView'
import { itemName } from '../lib/stock'
import {
  categoryTitle,
  hasTestData,
  qcAttachments,
  qcDecision,
  qcTest,
  requiredCategoryKeys,
  requiredTestsFor,
  testsShownFor,
} from '../lib/qcCategories'
import { decisionStatus, scoreSensory } from '../lib/sensory'
import { uploadAttachment } from '../lib/uploads'
import { fmtDate, fmtQty, statusLabel } from '../lib/utils'
import type { Batch, LabReport, QcAttachment, QcRecord, QcTestResult } from '../types'

const OPTS = ['Pending', 'Pass', 'Fail', 'Retest'] as const

/** Each shown test's result, by report type. */
type FormState = Record<string, QcTestResult>

/** How a generated report reads in the attach list: an evaluation by its batch and decision. */
function reportOption(r: LabReport) {
  if (r.scores) {
    const summary = scoreSensory(r.scores, r)
    const score = summary.score == null ? 'not scored' : `${fmtQty(summary.score)}/100`
    return `${r.id} · ${r.batchLotDetails || r.sampleName} · ${score} · ${summary.decision}`
  }
  return `${r.id} · ${r.customerName} · ${r.issueDate}`
}

export function Quality() {
  const { state, saveQc, startQc, showToast } = useApp()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  /** The table scans faster once records pile up; the cards stay one tap away. */
  const [view, setView] = useState<'table' | 'cards'>('table')
  const [active, setActive] = useState<QcRecord | null>(null)
  const [viewId, setViewId, closeView] = useLinkedView((id) => state.qcs.some((q) => q.id === id))
  const [form, setForm] = useState<FormState | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({})

  /**
   * One line of work per product, not per batch.
   *
   * A pressing gives coconut water and malai; a QC record covers one of them. So what
   * the screen lists is every bulk every batch produced, each with its own record.
   * A batch posted before this existed carries one record for its main output, and its
   * by-product turns up here with nothing against it and an offer to raise one.
   */
  const subjects = useMemo(() => {
    const q = search.toLowerCase()
    return [...state.batches]
      .reverse()
      .flatMap((batch) =>
        batchOutputs(batch).map((output) => {
          const record = state.qcs.find((x) => x.batchId === batch.id && x.item === output.item)
          return {
            key: `${batch.id}\u0000${output.item}`,
            batch,
            item: output.item,
            product: itemName(state, output.item),
            record,
            disposition: record?.disposition || 'Not raised',
          }
        }),
      )
      .filter(
        (r) =>
          (!filter || r.disposition === filter) &&
          [r.record?.id || '', r.batch.id, r.product, r.disposition]
            .join(' ')
            .toLowerCase()
            .includes(q),
      )
  }, [filter, search, state])

  const { sort, toggle, setSort } = useTableSort()
  type Subject = (typeof subjects)[number]
  const sortBy: SortAccessors<Subject> = {
    product: (s) => s.product,
    batch: (s) => s.batch.id,
    date: (s) => s.batch.date,
    record: (s) => s.record?.id,
    tests: (s) => (s.record ? testsShownFor(state, s.record).filter((c) => qcTest(s.record!, c.key).status === 'Pass').length : null),
    status: (s) => s.disposition,
  }
  const sorted = sortRows(subjects, sort, sortBy)

  /** Whose reports dialog is open — a subject key, not a record id, so a product with
   *  no QC record raised can still show the reports linked to its batch. */
  const [reportsOf, setReportsOf] = useState<string | null>(null)

  /**
   * A product's reports, both ways it has them: attached to the QC record itself, and
   * linked to the batch it came from. A generated report that is both shows once, under
   * the record it is attached to.
   */
  const reportsFor = (subject: (typeof subjects)[number]) => {
    const attached = subject.record ? qcAttachments(subject.record) : []
    const attachedIds = new Set(
      attached
        .filter((a) => a.file.url?.startsWith('/reports/'))
        .map((a) => a.file.url!.slice('/reports/'.length)),
    )
    const batchReports = state.labReports.filter(
      (r) => r.batchId === subject.batch.id && !attachedIds.has(r.id),
    )
    return { attached, batchReports }
  }

  /**
   * Whether the bulk under review has actually been packed yet. Most has not — it is
   * 200 litres of juice standing in a cold room — and the note in the review dialog
   * should not describe packs that do not exist.
   */
  const activeHasPacks = useMemo(
    () =>
      active
        ? state.packingRuns.some(
            (r) => r.batchId === active.batchId && runBulkItem(r) === active.item,
          )
        : false,
    [active, state.packingRuns],
  )

  /** The product a record is about, for every heading that names one. */
  const productOf = (q: QcRecord) => itemName(state, q.item || '')

  /** What a batch was made from: the receipts it pressed, or the batches it blended. */
  const madeFrom = (b: Batch) => [
    ...new Set([...b.sourceLines.map((s) => s.lot), ...(b.blendLines || []).map((l) => l.lot)]),
  ]

  const openReview = (q: QcRecord) => {
    setActive(q)
    setForm(Object.fromEntries(testsShownFor(state, q).map((c) => [c.key, qcTest(q, c.key)])))
  }

  const setTest = (key: string, patch: Partial<QcTestResult>) =>
    setForm((f) => (f ? { ...f, [key]: { ...(f[key] || { status: 'Pending' }), ...patch } } : f))

  const viewing = viewId ? state.qcs.find((q) => q.id === viewId) : undefined
  const viewBatch = viewing ? state.batches.find((b) => b.id === viewing.batchId) : undefined
  const viewRequired = viewing ? requiredTestsFor(state, viewing) : []
  const attachment = (a?: QcAttachment | null) =>
    a ? <AttachmentLink file={a} /> : 'None attached'
  const viewSections: DetailSection[] = viewing
    ? [
        {
          title: 'Record',
          fields: [
            { label: 'QC', value: viewing.id },
            { label: 'Batch', value: <DocLink doc={viewing.batchId} /> },
            { label: 'Product tested', value: itemName(state, viewing.item || '') },
            { label: 'Batch made', value: viewBatch ? batchLabel(state, viewBatch) : '' },
            { label: 'Disposition', value: viewing.disposition },
            { label: 'Batch status', value: viewBatch?.status },
            { label: 'Reviewed by', value: viewing.reviewedBy },
            { label: 'Reviewed at', value: viewing.reviewedAt ? fmtDate(viewing.reviewedAt) : '' },
          ],
        },
        ...testsShownFor(state, viewing).map((cat) => {
          const r = qcTest(viewing, cat.key)
          return {
            title: cat.title,
            fields: [
              { label: 'Result', value: r.status },
              { label: 'Needed to release', value: viewRequired.includes(cat.key) ? 'Yes' : 'No' },
              { label: 'Report', value: attachment(r.report) },
              { label: 'Note', value: r.note, wide: true },
            ],
          }
        }),
      ]
    : []

  const onUpload = async (key: string, file?: File | null) => {
    if (!file || !form) return
    setUploading(key)
    try {
      const uploaded = await uploadAttachment(file, `qc-${active?.id || 'report'}-${key}`)
      setTest(key, { report: uploaded })
      // Honest about what the interim store did: the file is on this device for
      // this session, not in a server-side bucket, and saying "uploaded" here
      // used to promise durability nothing behind it provided.
      showToast(`${file.name} attached — held on this device for this session.`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(null)
    }
  }

  /** What saving the review would decide, worked out by the same rule the save uses. */
  const decision = active && form ? qcDecision(state, active, form) : null
  const reopens =
    !!active &&
    !!decision &&
    (active.disposition === 'Released' || active.disposition === 'Rejected') &&
    (decision.disposition === 'Pending' || decision.disposition === 'Retest')

  return (
    <div className="products-page">
      <div className="card products-panel">
        <div className="section-head">
          <div>
            <h3>Quality Control</h3>
            <span>
              One line per product per batch — test, attach the lab reports, then release or
              hold each product on its own
            </span>
          </div>
        </div>

        <div className="note">
          A batch makes more than one thing, and each is tested on its own. A coconut pressing
          gives <b>coconut water</b> and <b>malai</b>, so it raises two QC records: the water can
          be released and sold while the malai is still on the bench, and failing one leaves the
          other untouched. A record covers its own bulk and every pack filled from that bulk.
          Every test <b>needed to release</b> must <b>Pass</b> to release it; a <b>Fail</b> on any
          test rejects it, a <b>Retest</b> holds it.
        </div>

        <div className="vendors-toolbar">
          <div className="type-tabs" role="tablist">
            {(
              [
                ['', 'All'],
                ['Pending', 'Awaiting QC'],
                ['Released', 'Released'],
                ['Rejected', 'Rejected'],
                ['Retest', 'Retest'],
                ['Not raised', 'Not raised'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id || 'all'}
                type="button"
                className={`type-tab ${filter === id ? 'active' : ''}`}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className="vendors-search"
            placeholder="Search QC, batch or product"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="type-tabs" role="tablist" aria-label="View">
            <button
              type="button"
              className={`type-tab ${view === 'table' ? 'active' : ''}`}
              onClick={() => setView('table')}
            >
              Table
            </button>
            <button
              type="button"
              className={`type-tab ${view === 'cards' ? 'active' : ''}`}
              onClick={() => setView('cards')}
            >
              Cards
            </button>
          </div>
        </div>

        {!subjects.length ? (
          <div className="empty vendors-empty">
            <EmptyState
              filtered={!!search || !!filter}
              empty="No QC records yet — they appear as soon as a batch is posted."
              onClear={() => {
                setSearch('')
                setFilter('')
              }}
            />
          </div>
        ) : view === 'table' ? (
          <>
            <SortSelect
              sort={sort}
              onPick={setSort}
              columns={[
                { k: 'product', label: 'Product' },
                { k: 'batch', label: 'Batch', kind: 'text' },
                { k: 'date', label: 'Batch date', kind: 'date' },
                { k: 'record', label: 'QC record', kind: 'text' },
                { k: 'tests', label: 'Tests passed', kind: 'num' },
                { k: 'status', label: 'Status' },
              ]}
            />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortHeader label="Product" k="product" sort={sort} onToggle={toggle} />
                    <SortHeader label="Batch" k="batch" sort={sort} onToggle={toggle} />
                    <SortHeader label="QC Record" k="record" sort={sort} onToggle={toggle} />
                    <SortHeader label="Tests" k="tests" first="desc" sort={sort} onToggle={toggle} />
                    <th>Reports</th>
                    <SortHeader label="Status" k="status" sort={sort} onToggle={toggle} />
                    <th className="cell-actions">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((subject) => {
                  const q = subject.record
                  const { attached, batchReports } = reportsFor(subject)
                  const totalReports = attached.length + batchReports.length
                  const required = q ? requiredTestsFor(state, q) : requiredCategoryKeys(state)
                  const testRows = q
                    ? testsShownFor(state, q).map((c) => ({
                        title: c.title,
                        status: qcTest(q, c.key).status,
                        needed: required.includes(c.key),
                      }))
                    : []
                  const passed = testRows.filter((t) => t.status === 'Pass').length
                  const waiting = testRows
                    .filter((t) => t.status !== 'Pass' && t.needed)
                    .map((t) => t.title)
                  return (
                    <tr key={subject.key} {...detailRowProps(() => q && setViewId(q.id))}>
                      <td data-label="Product">
                        <b>{subject.product}</b>
                        <div className="cell-sub">{batchLabel(state, subject.batch)}</div>
                      </td>
                      <td data-label="Batch" className="cell-id">
                        <DocLink doc={subject.batch.id} />
                        {madeFrom(subject.batch).length ? (
                          <div className="cell-sub">
                            from{' '}
                            {madeFrom(subject.batch).map((lot, i) => (
                              <Fragment key={lot}>
                                {i ? ', ' : ''}
                                <DocLink doc={lot} />
                              </Fragment>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td data-label="QC Record" className="cell-id">
                        {q ? q.id : <span className="small">—</span>}
                      </td>
                      <td data-label="Tests">
                        {q ? (
                          <>
                            {passed}/{testRows.length} Pass
                            {waiting.length ? (
                              <div className="small">Waiting: {waiting.join(', ')}</div>
                            ) : null}
                          </>
                        ) : (
                          <span className="small">Not raised</span>
                        )}
                      </td>
                      <td data-label="Reports">
                        {/* One link, one dialog: everything attached to the record and
                            every report linked to its batch, deduplicated. */}
                        {totalReports ? (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setReportsOf(subject.key)}
                          >
                            {totalReports} {totalReports === 1 ? 'report' : 'reports'}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td data-label="Status">
                        <StatusBadge value={subject.disposition} />
                      </td>
                      <td className="cell-actions">
                        <div className="row-actions">
                          {q ? (
                            <>
                              <button
                                className="btn btn-primary"
                                type="button"
                                onClick={() => openReview(q)}
                              >
                                Edit / Review
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn btn-primary"
                              type="button"
                              onClick={() => startQc(subject.batch.id, subject.item)}
                            >
                              Raise QC record
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="vendor-grid">
            {subjects.map((subject) => {
              const q = subject.record
              const { attached, batchReports } = reportsFor(subject)
              const totalReports = attached.length + batchReports.length
              const required = q ? requiredTestsFor(state, q) : requiredCategoryKeys(state)
              return (
                <article className="vendor-card product-card qc-card" key={subject.key}>
                  <div className="vendor-card-top">
                    <div className="vendor-card-title">
                      {/* The product leads, because that is what is being tested. The batch
                          is the second line: two cards can share it. */}
                      <h4>{subject.product}</h4>
                      <div className="small">
                        {/* The verdict's batch, and straight on to what it was made from. */}
                        <DocLink doc={subject.batch.id} /> · {batchLabel(state, subject.batch)}
                        {madeFrom(subject.batch).length ? (
                          <>
                            {' '}· from{' '}
                            {madeFrom(subject.batch).map((lot, i) => (
                              <Fragment key={lot}>
                                {i ? ', ' : ''}
                                <DocLink doc={lot} />
                              </Fragment>
                            ))}
                          </>
                        ) : null}
                      </div>
                      <div className="small">{q ? q.id : 'No QC record raised yet'}</div>
                    </div>
                    <StatusBadge value={subject.disposition} />
                  </div>
                  <div className="qc-mini-grid">
                    {testsShownFor(state, q).map((cat) => {
                      const result = q ? qcTest(q, cat.key) : undefined
                      // A test this record does not need and nobody has recorded is not
                      // something the product is waiting on.
                      const idle = !required.includes(cat.key) && !(result && hasTestData(result))
                      return (
                        <div className="qc-mini" key={cat.key}>
                          <span className="meta-label">{cat.title}</span>
                          <StatusBadge value={idle ? 'Not needed' : result?.status || 'Pending'} />
                        </div>
                      )
                    })}
                  </div>
                  <div className="small">
                    {totalReports ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setReportsOf(subject.key)}
                      >
                        {totalReports} {totalReports === 1 ? 'report' : 'reports'}
                      </button>
                    ) : (
                      'No reports yet'
                    )}
                  </div>
                  <div className="row-actions">
                    {q ? (
                      <>
                        <button
                          className="btn btn-light"
                          type="button"
                          onClick={() => setViewId(q.id)}
                        >
                          View
                        </button>
                        <button
                          className="btn btn-primary"
                          type="button"
                          onClick={() => openReview(q)}
                        >
                          Edit / Review
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => startQc(subject.batch.id, subject.item)}
                      >
                        Raise QC record
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <DetailView
        open={!!viewing}
        title={viewing ? `${productOf(viewing)} · ${viewing.batchId}` : 'QC record'}
        sections={viewSections}
        onClose={closeView}
        record={viewing?.id}
      />

      {(() => {
        const subject = subjects.find((s) => s.key === reportsOf)
        if (!subject) return null
        const { attached, batchReports } = reportsFor(subject)
        const labReports = [...batchReports].sort(
          (a, b) =>
            (b.scores ? b.sampleDate : b.issueDate).localeCompare(
              a.scores ? a.sampleDate : a.issueDate,
            ),
        )
        return (
          <Modal
            open
            readOnly
            title={`Reports · ${subject.product} · ${subject.batch.id}`}
            onClose={() => setReportsOf(null)}
            onSave={() => setReportsOf(null)}
          >
            {/* Formal lab reports first — they carry the verdict — then whatever
                paperwork is filed on the QC record itself. */}
            {labReports.length ? (
              <div className="detail-section">
                <h4>Lab reports</h4>
                <div className="report-list">
                  {labReports.map((r) => {
                    const summary = scoreSensory(r.scores || [], r)
                    const meta = [
                      summary.score != null ? `Scored ${fmtQty(summary.score)} / 100` : null,
                      r.customerName || null,
                    ].filter(Boolean)
                    return (
                      <article className="report-item" key={r.id}>
                        <div className="report-item-main">
                          <div className="report-item-title">
                            <DocLink doc={r.id} />
                            <span className="report-item-cat">
                              {categoryTitle(state, r.category)}
                            </span>
                          </div>
                          {meta.length ? <div className="small">{meta.join(' · ')}</div> : null}
                        </div>
                        <div className="report-item-side">
                          <StatusBadge value={summary.decision} />
                          <span className="report-item-date">
                            {fmtDate(r.scores ? r.sampleDate : r.issueDate)}
                          </span>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>
            ) : null}
            {attached.length ? (
              <div className="detail-section">
                <h4>Attached to {subject.record?.id || 'this QC record'}</h4>
                <div className="report-list">
                  {attached.map((a) => (
                    <article className="report-item" key={a.key}>
                      <div className="report-item-main">
                        <div className="report-item-title">
                          {a.file.url?.startsWith('/reports/') ? (
                            <DocLink doc={a.file.url.slice('/reports/'.length)} />
                          ) : (
                            <AttachmentLink file={a.file} />
                          )}
                          <span className="report-item-cat">{categoryTitle(state, a.key)}</span>
                        </div>
                        <div className="small">Uploaded {fmtDate(a.file.uploadedAt)}</div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
            {!labReports.length && !attached.length ? (
              <div className="empty">
                No reports yet. Lab reports saved for this batch, and files attached to its QC
                record, will appear here.
              </div>
            ) : null}
          </Modal>
        )
      })()}

      <Modal
        open={!!active && !!form}
        title={active ? `QC Review · ${productOf(active)} · ${active.batchId}` : 'QC Review'}
        saveLabel="Review & Apply"
        onClose={() => {
          setActive(null)
          setForm(null)
        }}
        onSave={() => {
          if (!active || !form) return
          const ok = saveQc(active.id, { tests: form })
          if (ok) {
            setActive(null)
            setForm(null)
          }
        }}
      >
        {form && active && decision ? (
          <>
            <div className="qc-review-grid">
              {testsShownFor(state, active).map((cat) => {
                const result = form[cat.key] || qcTest(active, cat.key)
                const needed = decision.required.includes(cat.key)
                // Reports naming this batch come first — they are nearly always the one wanted.
                const catReports = state.labReports
                  .filter((r) => r.category === cat.key)
                  .slice()
                  .reverse()
                  .sort(
                    (a, b) =>
                      Number(b.batchLotDetails.includes(active.batchId)) -
                      Number(a.batchLotDetails.includes(active.batchId)),
                  )
                return (
                  <article className="qc-review-card" key={cat.key}>
                    <div className="qc-review-head">
                      <h4>{cat.title}</h4>
                      <StatusBadge value={result.status} />
                    </div>
                    <div className="small">
                      {needed ? 'Needed to release this product' : 'Not needed to release this record'}
                    </div>
                    <label>Status</label>
                    <Select
                      value={result.status}
                      onChange={(e) => setTest(cat.key, { status: e.target.value })}
                    >
                      {OPTS.map((o) => (
                        <option key={o} value={o}>
                          {statusLabel(o)}
                        </option>
                      ))}
                    </Select>
                    <label style={{ marginTop: 10 }}>Report note</label>
                    <textarea
                      placeholder={cat.hint}
                      value={result.note || ''}
                      onChange={(e) => setTest(cat.key, { note: e.target.value })}
                    />
                    <div className="qc-upload-block">
                      <label>{cat.format === 'scored' ? 'Evaluation (generated or PDF / image)' : 'Lab report (PDF / image)'}</label>
                      {result.report ? (
                        <div className="qc-file-row">
                          <AttachmentLink file={result.report} />
                          <button
                            type="button"
                            className="btn btn-light"
                            onClick={() => setTest(cat.key, { report: null })}
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <div className="qc-file-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                          <div className="qc-file-row">
                            <input
                              ref={(el) => {
                                fileRefs.current[cat.key] = el
                              }}
                              type="file"
                              accept=".pdf,application/pdf,image/*"
                              hidden
                              onChange={(e) => {
                                const file = e.target.files?.[0]
                                void onUpload(cat.key, file)
                                e.target.value = ''
                              }}
                            />
                            <button
                              type="button"
                              className="btn btn-light"
                              disabled={uploading === cat.key}
                              onClick={() => fileRefs.current[cat.key]?.click()}
                            >
                              {uploading === cat.key ? 'Uploading…' : '+ Upload PDF'}
                            </button>
                          </div>
                          {catReports.length ? (
                            <Select
                              value=""
                              onChange={(e) => {
                                const r = catReports.find((x) => x.id === e.target.value)
                                if (!r) return
                                const patch: Partial<QcTestResult> = {
                                  report: { fileName: r.id, url: `/reports/${r.id}`, uploadedAt: r.issueDate },
                                }
                                // An evaluation carries its own decision, so attaching one sets
                                // the result it stands for. QA can still change it.
                                if (r.scores) {
                                  const status = decisionStatus(scoreSensory(r.scores, r).decision)
                                  if (status !== 'Pending') patch.status = status
                                }
                                setTest(cat.key, patch)
                              }}
                            >
                              <option value="">Attach generated report…</option>
                              {catReports.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {reportOption(r)}
                                </option>
                              ))}
                            </Select>
                          ) : null}
                        </div>
                      )}
                      {cat.format === 'scored' ? (
                        <div className="small">
                          Attaching an evaluation sets the status from its decision — a pass with minor
                          modification is a Pass, an R&amp;D review a Retest, a critical defect a Fail.
                        </div>
                      ) : null}
                    </div>
                  </article>
                )
              })}
            </div>
            <div className={`note${reopens ? ' warning-note' : ''}`}>
              <b>Review &amp; Apply</b> marks <b>{productOf(active)}</b>{' '}
              <b>{statusLabel(decision.disposition)}</b>.{' '}
              {reopens
                ? 'It was already decided, so the stock that verdict released or rejected goes back to awaiting QC until it is decided again. '
                : ''}
              It is released only when every test needed to release it reads Pass
              {decision.required.length
                ? ` (${decision.required.map((k) => categoryTitle(state, k)).join(', ')})`
                : ''}
              ; a Fail on any test rejects it, and a Retest puts it on hold. It decides nothing about
              anything else the batch made.{' '}
              {activeHasPacks
                ? 'Packs filled from this bulk are already in the cold room — releasing them clears them for dispatch where they stand, and rejecting them leaves them there flagged. '
                : 'None of this bulk has been packed yet, so releasing it clears it for blending and packing. '}
              Attach the lab reports as audit evidence.
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  )
}
