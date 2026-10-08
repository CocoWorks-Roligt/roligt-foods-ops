import { useEffect, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { Modal } from '../components/Modal'
import { Select } from '../components/Select'
import { useApp } from '../context/AppContext'
import { useToast } from '../context/ToastContext'
import {
  complianceRemove,
  complianceSave,
  fetchComplianceDocs,
  uploadComplianceFile,
  type ComplianceRow,
} from '../lib/complianceApi'
import {
  COMPLIANCE_CONTENT_TYPES,
  COMPLIANCE_DOC_TYPES,
  COMPLIANCE_FILE_MAX_BYTES,
  DEFAULT_COMPLIANCE_LEAD_DAYS,
  daysBetween,
  parseEmails,
  validateComplianceDoc,
  type ComplianceDoc,
  type ComplianceFile,
} from '../lib/complianceRules'
import { fmtDate, toDateKey, uid } from '../lib/utils'

/**
 * The licences/permits/certificates register.
 *
 * Unlike every day's-work page this one is deliberately ONLINE: its rows are
 * not part of the offline state (they live in their own table, read through
 * /api/compliance on demand), because the file upload needs the network anyway
 * and a 27th swept table would break the snapshot sweep's read arithmetic. The
 * only thing borrowed from the app context is the configured lead window, for
 * the badges — a read, never a write.
 */

const TYPE_LABELS: Record<string, string> = {
  license: 'Licence',
  permit: 'Permit',
  certificate: 'Certificate',
  registration: 'Registration',
  insurance: 'Insurance',
  other: 'Other',
}

interface Form {
  id: string | null
  title: string
  docType: string
  authority: string
  identifier: string
  issuedOn: string
  expiresOn: string
  remindEmails: string
  notes: string
  file: ComplianceFile | null
}

const blankForm = (): Form => ({
  id: null,
  title: '',
  docType: 'license',
  authority: '',
  identifier: '',
  issuedOn: '',
  expiresOn: '',
  remindEmails: '',
  notes: '',
  file: null,
})

/** The form as the doc the server will see — the placeholder id only exists so
 *  validation has something to chew on before the real one is minted on save. */
function buildDoc(form: Form): ComplianceDoc {
  return {
    id: form.id ?? 'CMP-DRAFT',
    title: form.title.trim(),
    docType: form.docType,
    authority: form.authority.trim() || undefined,
    identifier: form.identifier.trim() || undefined,
    issuedOn: form.issuedOn || undefined,
    expiresOn: form.expiresOn || undefined,
    notes: form.notes.trim() || undefined,
    remindEmails: parseEmails(form.remindEmails),
    file: form.file ?? undefined,
  }
}

function formOf(doc: ComplianceDoc): Form {
  return {
    id: doc.id,
    title: doc.title,
    docType: doc.docType,
    authority: doc.authority ?? '',
    identifier: doc.identifier ?? '',
    issuedOn: doc.issuedOn ?? '',
    expiresOn: doc.expiresOn ?? '',
    remindEmails: doc.remindEmails.join(', '),
    notes: doc.notes ?? '',
    file: doc.file ?? null,
  }
}

export function Compliance() {
  const showToast = useToast()
  const { state } = useApp()
  const leadDays = state.config.complianceLeadDays ?? DEFAULT_COMPLIANCE_LEAD_DAYS

  const [rows, setRows] = useState<ComplianceRow[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Form>(blankForm())
  /** The Version token of the row being edited — undefined when adding. */
  const [baseVersion, setBaseVersion] = useState<string | undefined>(undefined)

  const reload = async () => {
    try {
      setRows(await fetchComplianceDocs())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load compliance documents.')
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const draft = buildDoc(form)
  const problem = validateComplianceDoc(draft)
  const parsedEmails = parseEmails(form.remindEmails)

  const openAdd = () => {
    setForm(blankForm())
    setBaseVersion(undefined)
    setOpen(true)
  }

  const openEdit = (row: ComplianceRow) => {
    setForm(formOf(row.doc))
    setBaseVersion(row.version)
    setOpen(true)
  }

  const onUpload = async (file: File) => {
    if (!COMPLIANCE_CONTENT_TYPES.includes(file.type as (typeof COMPLIANCE_CONTENT_TYPES)[number]) && !file.name.toLowerCase().endsWith('.pdf')) {
      showToast('Only PDF or image files are allowed.')
      return
    }
    if (file.size > COMPLIANCE_FILE_MAX_BYTES) {
      showToast('File must be under 12 MB.')
      return
    }
    setUploading(true)
    try {
      const path = await uploadComplianceFile(file)
      setForm((f) => ({ ...f, file: { fileName: file.name, path, uploadedAt: new Date().toISOString() } }))
      showToast('File attached — save the document to keep it.')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'The upload failed.')
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    if (problem) {
      showToast(problem)
      return
    }
    setBusy(true)
    const result = await complianceSave({ ...draft, id: form.id ?? uid('CMP') }, baseVersion)
    setBusy(false)
    if (result.ok) {
      showToast('Compliance document saved.')
      setOpen(false)
      await reload()
      return
    }
    showToast(result.error)
    if (result.conflict) {
      // the list now holds the newer row — close the stale form onto it
      setOpen(false)
      await reload()
    }
  }

  const remove = async (row: ComplianceRow) => {
    if (!window.confirm(`Remove “${row.doc.title}” from the register?`)) return
    setBusy(true)
    const result = await complianceRemove(row.doc.id, row.version)
    setBusy(false)
    if (result.ok) {
      showToast('Compliance document removed.')
      await reload()
      return
    }
    showToast(result.error)
    if (result.conflict) await reload()
  }

  const today = toDateKey()
  const docs = rows?.map((r) => r.doc) ?? []
  const expiring = docs.filter((d) => d.expiresOn && daysBetween(today, d.expiresOn) >= 0 && daysBetween(today, d.expiresOn) <= leadDays).length
  const expired = docs.filter((d) => d.expiresOn && daysBetween(today, d.expiresOn) < 0).length

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h3>Documents</h3>
          <span>
            {expiring > 0 || expired > 0
              ? `${expiring} expiring within ${leadDays} days${expired ? `, ${expired} already expired` : ''} — each gets one reminder email`
              : `Nothing expires within the ${leadDays}-day reminder window`}
          </span>
        </div>
        <div className="section-head-actions">
          <button className="btn btn-primary" type="button" onClick={openAdd}>
            Add document
          </button>
        </div>
      </div>

      {error ? (
        <div className="note form-error">
          {error}{' '}
          <button type="button" className="link-btn" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      ) : null}

      {rows === null ? (
        error ? null : (
          <div className="empty">Loading…</div>
        )
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Authority</th>
                <th>Expires</th>
                <th>Reminder</th>
                <th>File</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState filtered={false} empty="No licences, permits or certificates recorded yet." onClear={() => undefined} />
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const doc = row.doc
                  const left = doc.expiresOn ? daysBetween(today, doc.expiresOn) : null
                  const badge =
                    left === null ? (
                      <span className="status">No expiry</span>
                    ) : left < 0 ? (
                      <span className="status danger">Expired {fmtDate(doc.expiresOn)}</span>
                    ) : left <= leadDays ? (
                      <span className="status warning">{left === 0 ? 'Today' : `${left} day${left === 1 ? '' : 's'} — ${fmtDate(doc.expiresOn)}`}</span>
                    ) : (
                      <span className="status">{fmtDate(doc.expiresOn)}</span>
                    )
                  const sent = doc.reminderSentFor === doc.expiresOn && doc.reminderSentAt
                  return (
                    <tr key={doc.id}>
                      <td data-label="Document">
                        <strong>{doc.title}</strong>
                        {doc.identifier ? <div className="small">{doc.identifier}</div> : null}
                      </td>
                      <td data-label="Type">{TYPE_LABELS[doc.docType] ?? doc.docType}</td>
                      <td data-label="Authority">{doc.authority || '—'}</td>
                      <td data-label="Expires">{badge}</td>
                      <td data-label="Reminder">
                        {sent ? (
                          <span className="small">Sent {fmtDate(doc.reminderSentAt)} → {doc.remindEmails.join(', ')}</span>
                        ) : doc.expiresOn ? (
                          <span className="small">{doc.remindEmails.join(', ') || '— no address given'}</span>
                        ) : (
                          <span className="small">—</span>
                        )}
                      </td>
                      <td data-label="File">
                        {doc.file ? (
                          <a href={`/api/compliance/file?path=${encodeURIComponent(doc.file.path)}`}>{doc.file.fileName}</a>
                        ) : (
                          <span className="small">—</span>
                        )}
                      </td>
                      <td data-label="Action">
                        <button type="button" className="link-btn" disabled={busy} onClick={() => openEdit(row)}>
                          Edit
                        </button>{' '}
                        <button type="button" className="link-btn" disabled={busy} onClick={() => void remove(row)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        title={form.id ? 'Edit document' : 'Add document'}
        open={open}
        onClose={() => setOpen(false)}
        onSave={() => void save()}
        saveDisabled={busy || uploading || !!problem}
        saveLabel={busy ? 'Saving…' : 'Save'}
      >
        <div className="form-grid">
          <div className="field">
            <label>Title</label>
            <input value={form.title} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. FSSAI licence — Rajamundry unit" />
          </div>
          <div className="field">
            <label>Type</label>
            <Select value={form.docType} onChange={(e) => setForm((f) => ({ ...f, docType: e.target.value }))}>
              {COMPLIANCE_DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Issuing authority</label>
            <input value={form.authority} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, authority: e.target.value }))} placeholder="e.g. FSSAI" />
          </div>
          <div className="field">
            <label>Document number</label>
            <input value={form.identifier} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, identifier: e.target.value }))} />
          </div>
          <div className="field">
            <label>Issued on</label>
            <input type="date" value={form.issuedOn} onChange={(e) => setForm((f) => ({ ...f, issuedOn: e.target.value }))} />
          </div>
          <div className="field">
            <label>Expiry date</label>
            <input type="date" value={form.expiresOn} onChange={(e) => setForm((f) => ({ ...f, expiresOn: e.target.value }))} />
            <div className="small">Leave blank for a document that does not expire.</div>
          </div>
          <div className="field span-2">
            <label>Reminder email {form.expiresOn ? '(required — this is who the expiry warning goes to)' : '(used if an expiry date is set later)'}</label>
            <textarea
              rows={2}
              value={form.remindEmails}
              onChange={(e) => setForm((f) => ({ ...f, remindEmails: e.target.value }))}
              placeholder="owner@plant.in, qa@plant.in"
            />
            <div className="small">
              {parsedEmails.length > 0
                ? `${parsedEmails.length} address${parsedEmails.length === 1 ? '' : 'es'}: ${parsedEmails.join(', ')}`
                : form.remindEmails.trim()
                  ? 'Nothing recognised as an email address yet.'
                  : ''}
            </div>
          </div>
          <div className="field span-2">
            <label>{form.file ? 'Replace file' : 'File (PDF or image, up to 12 MB)'}</label>
            <input
              type="file"
              accept=".pdf,application/pdf,image/*"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = '' // the same file must be re-selectable after a failed attach
                if (file) void onUpload(file)
              }}
            />
            {uploading ? <div className="small">Uploading…</div> : null}
            {form.file ? <div className="small">Attached: {form.file.fileName}</div> : null}
          </div>
          <div className="field span-2">
            <label>Notes</label>
            <textarea rows={2} maxLength={2000} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
      </Modal>
    </div>
  )
}
