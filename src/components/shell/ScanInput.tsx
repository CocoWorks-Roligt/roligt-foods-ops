/**
 * Scan input (overhaul §6 ScanInput): the field a scanner gun types into.
 * A gun behaves like a keyboard that types very fast and presses Enter — so
 * the component is a text input that (a) selects its content on focus, so a
 * new scan replaces the old one without a manual clear, and (b) submits on
 * Enter, which is the gun's last keystroke. Camera scanning is deferred to
 * the SHIPMENT phase's PWA (DECISIONS) — this is the keyboard-wedge half.
 */
import { useEffect, useRef } from 'react'

export function ScanInput({
  onScan,
  label,
  placeholder = 'Scan a barcode or type a code',
  autoFocus = false,
}: {
  onScan: (code: string) => void
  label: string
  placeholder?: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)

  // Focus on mount when asked — the scan field is often a page's whole job.
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  return (
    <div className="scan-input">
      <label className="visually-hidden" htmlFor={`scan-${label.replace(/\s+/g, '-')}`}>
        {label}
      </label>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M3 5V3h2M19 3h2v2M21 19v2h-2M5 21H3v-2M7 8v8M11 5v14M15 8v8" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        id={`scan-${label.replace(/\s+/g, '-')}`}
        type="text"
        inputMode="text"
        autoComplete="off"
        placeholder={placeholder}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const code = e.currentTarget.value.trim()
            if (code) {
              e.preventDefault()
              onScan(code)
              // A second scan starts clean: the gun's next burst types over
              // a selected field, so select rather than clear — the operator
              // can still see what the last scan read.
              e.currentTarget.select()
            }
          }
        }}
      />
    </div>
  )
}
