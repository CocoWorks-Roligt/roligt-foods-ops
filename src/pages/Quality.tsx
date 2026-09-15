import { Fragment, useMemo, useRef, useState } from 'react'
import { AttachmentLink } from '../components/Attachments'
import { DetailView, type DetailSection } from '../components/DetailView'
import { DocLink } from '../components/DocLink'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { StatusBadge } from '../components/StatusBadge'
import { useApp } from '../context/AppContext'
import { batchLabel, batchOutputs, runBulkItem } from '../lib/batches'
import { useLinkedView } from '../lib/linkedView'
import { itemName } from '../lib/stock'
import { categoryTitle } from '../lib/qcCategories'
import { uploadAttachment } from '../lib/uploads'
import { fmtDate, statusLabel } from '../lib/utils'
import type { Batch, QcAttachment, QcRecord } from '../types'

const OPTS = ['Pending', 'Pass', 'Fail', 'Retest'] as const

type CatKey = 'micro' | 'pesticides' | 'heavyMetals' | 'physico'

const CATEGORIES: {
  key: CatKey
  noteKey: `${CatKey}Note`
  reportKey: `${CatKey}Report`
  title: string
  hint: string
}[] = [
  {
    key: 'micro',
    noteKey: 'microNote',
    reportKey: 'microReport',
    title: categoryTitle('micro'),
    hint: 'Method, lab, report number',
  },
  {
    key: 'pesticides',
    noteKey: 'pesticidesNote',
    reportKey: 'pesticidesReport',
    title: categoryTitle('pesticides'),
    hint: 'NABL report / panel details',
  },
  {
    key: 'heavyMetals',
    noteKey: 'heavyMetalsNote',
    reportKey: 'heavyMetalsReport',
    title: categoryTitle('heavyMetals'),
    hint: 'Lead, arsenic, cadmium, mercury',
  },
  {
    key: 'physico',
    noteKey: 'physicoNote',
    reportKey: 'physicoReport',
    title: categoryTitle('physico'),
    hint: 'pH, Brix, appearance, sensory',
  },
]

type FormState = {
  micro: string
  pesticides: string
  heavyMetals: string
  physico: string
  microNote: string
  pesticidesNote: string
  heavyMetalsNote: string
  physicoNote: string
  microReport: QcAttachment | null
  pesticidesReport: QcAttachment | null
  heavyMetalsReport: QcAttachment | null
  physicoReport: QcAttachment | null
}

function fromRecord(q: QcRecord): FormState {
  return {
    micro: q.micro,
    pesticides: q.pesticides,
    heavyMetals: q.heavyMetals,
    physico: q.physico,
    microNote: q.microNote || '',
    pesticidesNote: q.pesticidesNote || '',
    heavyMetalsNote: q.heavyMetalsNote || '',
    physicoNote: q.physicoNote || '',
    microReport: q.microReport || null,
    pesticidesReport: q.pesticidesReport || null,
    heavyMetalsReport: q.heavyMetalsReport || null,
    physicoReport: q.physicoReport || null,
  }
}

export function Quality() {
  const { state, saveQc, startQc, showToast } = useApp()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState<QcRecord | null>(null)
  const [viewId, setViewId, closeView] = useLinkedView((id) => state.qcs.some((q) => q.id === id))
  const [form, setForm] = useState<FormState | null>(null)
  const [uploading, setUploading] = useState<CatKey | null>(null)
  const fileRefs = useRef<Record<CatKey, HTMLInputElement | null>>({
    micro: null,
    pesticides: null,
    heavyMetals: null,
    physico: null,
  })

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
    setForm(fromRecord(q))
  }

  const viewing = viewId ? state.qcs.find((q) => q.id === viewId) : undefined
  const viewBatch = viewing ? state.batches.find((b) => b.id === viewing.batchId) : undefined
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
        ...CATEGORIES.map((cat) => ({
          title: cat.title,
          fields: [
            { label: 'Result', value: viewing[cat.key] },
            { label: 'Report', value: attachment(viewing[cat.reportKey] as QcAttachment | null) },
            { label: 'Note', value: viewing[cat.noteKey] as string, wide: true },
          ],
        })),
      ]
    : []

  const onUpload = async (key: CatKey, file?: File | null) => {
    if (!file || !form) return
    setUploading(key)
    try {
      const uploaded = await uploadAttachment(file, `qc-${active?.id || 'report'}-${key}`)
      const reportKey = CATEGORIES.find((c) => c.key === key)!.reportKey
      setForm((f) => (f ? { ...f, [reportKey]: uploaded } : f))
      showToast(`${file.name} uploaded.`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(null)
    }
  }

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
          All four tests must <b>Pass</b> to release it; one <b>Fail</b> rejects it, a{' '}
          <b>Retest</b> holds it.
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
        ) : (
          <div className="vendor-grid">
            {subjects.map((subject) => {
              const q = subject.record
              const reportCount = q
                ? [q.microReport, q.pesticidesReport, q.heavyMetalsReport, q.physicoReport].filter(
                    Boolean,
                  ).length
                : 0
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
                    {(
                      [
                        [categoryTitle('micro'), q?.micro],
                        [categoryTitle('pesticides'), q?.pesticides],
                        [categoryTitle('heavyMetals'), q?.heavyMetals],
                        [categoryTitle('physico'), q?.physico],
                      ] as const
                    ).map(([label, status]) => (
                      <div className="qc-mini" key={label}>
                        <span className="meta-label">{label}</span>
                        <StatusBadge value={status || 'Pending'} />
                      </div>
                    ))}
                  </div>
                  <div className="small">
                    {reportCount
                      ? `${reportCount} report file(s) attached`
                      : 'No reports uploaded yet'}
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
          const ok = saveQc(active.id, form)
          if (ok) {
            setActive(null)
            setForm(null)
          }
        }}
      >
        {form ? (
          <>
            <div className="qc-review-grid">
              {CATEGORIES.map((cat) => {
                const report = form[cat.reportKey] as QcAttachment | null
                const note = String(form[cat.noteKey] || '')
                return (
                  <article className="qc-review-card" key={cat.key}>
                    <div className="qc-review-head">
                      <h4>{cat.title}</h4>
                      <StatusBadge value={form[cat.key]} />
                    </div>
                    <label>Status</label>
                    <Select
                      value={form[cat.key]}
                      onChange={(e) =>
                        setForm((f) => (f ? { ...f, [cat.key]: e.target.value } : f))
                      }
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
                      value={note}
                      onChange={(e) =>
                        setForm((f) => (f ? { ...f, [cat.noteKey]: e.target.value } : f))
                      }
                    />
                    <div className="qc-upload-block">
                      <label>Lab report (PDF / image)</label>
                      {report ? (
                        <div className="qc-file-row">
                          <AttachmentLink file={report} />
                          <button
                            type="button"
                            className="btn btn-light"
                            onClick={() =>
                              setForm((f) => (f ? { ...f, [cat.reportKey]: null } : f))
                            }
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
                          {(() => {
                            const catReports = state.labReports
                              .filter((r) => r.category === cat.key)
                              .slice()
                              .reverse()
                            if (!catReports.length) return null
                            return (
                              <Select
                                value=""
                                onChange={(e) => {
                                  const r = catReports.find((x) => x.id === e.target.value)
                                  if (!r) return
                                  setForm((f) =>
                                    f
                                      ? {
                                          ...f,
                                          [cat.reportKey]: {
                                            fileName: r.id,
                                            url: `/reports/${r.id}`,
                                            uploadedAt: r.issueDate,
                                          },
                                        }
                                      : f,
                                  )
                                }}
                              >
                                <option value="">Attach generated report…</option>
                                {catReports.map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.id} · {r.customerName} · {r.issueDate}
                                  </option>
                                ))}
                              </Select>
                            )
                          })()}
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
            <div className="note">
              <b>Review &amp; Apply</b> releases <b>{active ? productOf(active) : 'this product'}</b>{' '}
              only when all four categories read Pass — one Fail rejects it, one Retest puts it on
              hold. It decides nothing about anything else the batch made.{' '}
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
