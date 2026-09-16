import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Free text that offers the plant's batch codes as you type. A lab report can name a
 * batch, a trial, or a day of the product the app never recorded, so the field never
 * insists on a code — it only saves typing one.
 */
export function BatchLotField({
  value,
  onChange,
  batchIds,
  placeholder = 'e.g. B.No: RF28042026 (Day 2 of the product)',
}: {
  value: string
  onChange: (v: string) => void
  batchIds: string[]
  placeholder?: string
}) {
  const [showList, setShowList] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const options = batchIds.filter((id) => id.toLowerCase().includes(value.toLowerCase()))

  const openList = () => {
    const r = inputRef.current?.getBoundingClientRect()
    if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width })
    setShowList(true)
  }

  return (
    <div className="autocomplete">
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          openList()
        }}
        onFocus={openList}
        onBlur={() => setTimeout(() => setShowList(false), 150)}
      />
      {showList && options.length && rect
        ? createPortal(
            <div
              className="autocomplete-list"
              style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width }}
            >
              {options.map((id) => (
                <div
                  key={id}
                  className="autocomplete-option"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onChange(id)
                    setShowList(false)
                  }}
                >
                  {id}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
