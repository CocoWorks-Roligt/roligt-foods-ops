/**
 * Help (WORKFLOW W16, behind the `pipeline` flag): the "?" beside the search
 * button — replay the tour, open the cheat sheet, send feedback.
 *
 * The cheat sheet IS the caller's pages: roles here are data (pages.ts), so
 * "your role's cheat sheet" is honestly "one line for every screen you hold",
 * in the same order the sidebar lists them. The printable per-role pages for
 * onboarding live in docs/overhaul/cheatsheets/.
 *
 * Feedback writes NOTHING to the server (STATE's W16 law: no new endpoints).
 * It collects the words, copies them to the clipboard ready to paste to an
 * admin, and keeps an outbox on this device so nothing typed is lost — a
 * server endpoint is a later decision if the plant wants centralized
 * feedback (DECISIONS W16).
 */
import { useEffect, useRef, useState } from 'react'
import { Modal } from '../Modal'
import { useToast } from '../../context/ToastContext'
import { cheatSheetRows } from '../../lib/onboarding.ts'
import type { PageRow } from '../../lib/pages.ts'

const OUTBOX_KEY = 'roligt_feedback_outbox'
const OUTBOX_MAX = 20

/** A kept copy of what was copied out — the operator's own record of sent words. */
interface OutboxEntry {
  at: string
  from: string
  screen: string
  text: string
}

function keepOutboxCopy(entry: OutboxEntry) {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY)
    const list = raw ? (JSON.parse(raw) as OutboxEntry[]) : []
    list.push(entry)
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-OUTBOX_MAX)))
  } catch {
    // private window / quota — the clipboard copy is the real deliverable
  }
}

const TIER_HEADS: { tiers: string[]; head: string }[] = [
  { tiers: ['open'], head: 'Your screens' },
  { tiers: ['masters'], head: 'Masters' },
  { tiers: ['settings', 'admin'], head: 'Settings & administration' },
]

interface HelpMenuProps {
  /** The caller's pages — the cheat sheet is one line for each. */
  allowed: readonly PageRow[]
  /** Current screen title, so feedback says where it was written. */
  screen: string
  from: string
  onTour: () => void
}

export function HelpMenu({ allowed, screen, from, onTour }: HelpMenuProps) {
  const toast = useToast()
  const [menuOpen, setMenuOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [copyNote, setCopyNote] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Click-outside and Esc close the popover; the dialogs close themselves.
  useEffect(() => {
    if (!menuOpen) return
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const act = (fn: () => void) => () => {
    setMenuOpen(false)
    fn()
  }

  const rows = cheatSheetRows(allowed)

  const copyFeedback = async () => {
    const text = feedback.trim()
    if (!text) return
    const words = `Roligt Ops feedback (${screen} screen, ${new Date().toLocaleString()}):\n${text}`
    try {
      await navigator.clipboard.writeText(words)
      keepOutboxCopy({ at: new Date().toISOString(), from, screen, text })
      setFeedback('')
      setCopyNote(null)
      setFeedbackOpen(false)
      toast('Feedback copied — paste it to your admin (WhatsApp or email).')
    } catch {
      // Clipboard refused (permission, http): the words are not lost — select
      // and copy by hand, the textarea keeps them.
      setCopyNote('Copy was blocked by the browser — select the text and copy it yourself.')
    }
  }

  return (
    <div className="help-root" ref={rootRef}>
      <button
        type="button"
        className="icon-btn"
        data-tour="help"
        aria-label="Help — tour, cheat sheet, feedback"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        ?
      </button>

      {menuOpen ? (
        <div className="help-menu" role="menu">
          <button type="button" role="menuitem" onClick={act(onTour)}>
            Take the tour
            <small>Two minutes — the shell, the board, the forms</small>
          </button>
          <button type="button" role="menuitem" onClick={act(() => setSheetOpen(true))}>
            My cheat sheet
            <small>One line for every screen you hold</small>
          </button>
          <button type="button" role="menuitem" onClick={act(() => setFeedbackOpen(true))}>
            Send feedback
            <small>Copies to your clipboard, ready for your admin</small>
          </button>
        </div>
      ) : null}

      <Modal
        title="My cheat sheet"
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSave={() => setSheetOpen(false)}
        readOnly
      >
        <p className="muted">
          Your screens in the order the work happens — this page IS your role's cheat sheet,
          because what you see is what your role holds.
        </p>
        {TIER_HEADS.map(({ tiers, head }) => {
          const tierRows = rows.filter((r) =>
            tiers.includes(allowed.find((p) => p.id === r.id)?.tier ?? ''),
          )
          if (!tierRows.length) return null
          return (
            <div key={head} className="cheat-section">
              <h4>{head}</h4>
              <ul>
                {tierRows.map((r) => (
                  <li key={r.id}>
                    <strong>{r.label}</strong>
                    <span>{r.line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
        <div className="cheat-notes">
          <h4>Worth knowing</h4>
          <ul>
            <li>Ctrl or ⌘ + K searches everything — lots, runs, orders, customers, suppliers.</li>
            <li>Numbers are live: they move with the feed, and every screen says how fresh it is.</li>
            <li>A half-filled form survives a closed tab; offline entries sync when the signal returns.</li>
          </ul>
        </div>
      </Modal>

      <Modal
        title="Send feedback"
        open={feedbackOpen}
        onClose={() => {
          setFeedbackOpen(false)
          setCopyNote(null)
        }}
        onSave={() => void copyFeedback()}
        saveLabel="Copy feedback"
        saveDisabled={!feedback.trim()}
      >
        <p className="muted">
          What is wrong, confusing, or missing on the <strong>{screen}</strong> screen? Nothing is
          sent anywhere — your words are copied to the clipboard, ready to paste to your admin, and
          a copy stays on this device.
        </p>
        <textarea
          className="feedback-text"
          rows={6}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Tell it plainly — what you were doing, what got in the way."
          aria-label="Feedback"
        />
        {copyNote ? <p className="warning-note">{copyNote}</p> : null}
      </Modal>
    </div>
  )
}
