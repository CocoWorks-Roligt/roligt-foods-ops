import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

/**
 * The dropdown that replaced every native `<select>` in the app.
 *
 * Replacing the native control meant inheriting everything it did for free, and this
 * did not: the options were plain `<div onClick>`, so there were no arrow keys, no
 * Enter or Space to open, no type-ahead and nothing for a screen reader to follow.
 * A plant floor runs on keyboards and scanners with gloved hands, so going
 * mouse-only was a real regression from the control it replaced. It behaves like a
 * listbox now — roving `aria-activedescendant`, Home/End, and type-ahead that jumps
 * to the option you started spelling.
 */

interface OptionInfo {
  value: string
  label: ReactNode
  disabled?: boolean
}

interface SelectProps {
  value: string
  onChange: (e: { target: { value: string } }) => void
  children: ReactNode
  disabled?: boolean
  className?: string
  id?: string
}

/** Plain text of an option, for type-ahead. */
function optionText(label: ReactNode): string {
  if (label === null || label === undefined || typeof label === 'boolean') return ''
  if (typeof label === 'string' || typeof label === 'number') return String(label)
  if (Array.isArray(label)) return label.map(optionText).join('')
  if (isValidElement(label)) return optionText((label.props as { children?: ReactNode }).children)
  return ''
}

function optionsFromChildren(children: ReactNode): OptionInfo[] {
  return Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const props = child.props as { value?: string; children?: ReactNode; disabled?: boolean }
      const value = props.value !== undefined ? String(props.value) : String(props.children ?? '')
      return { value, label: props.children, disabled: props.disabled }
    })
}

export function Select({ value, onChange, children, disabled, className, id }: SelectProps) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const btnRef = useRef<HTMLButtonElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  const listId = useRef(`ui-select-${Math.random().toString(36).slice(2, 9)}`)

  const options = optionsFromChildren(children)
  const selected = options.find((o) => o.value === value)
  const selectedIndex = options.findIndex((o) => o.value === value)
  const texts = useMemo(() => options.map((o) => optionText(o.label).toLowerCase()), [options])

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width })
  }

  const openList = (startAt = selectedIndex) => {
    if (disabled) return
    place()
    setActiveIndex(startAt >= 0 ? startAt : firstEnabled(0, 1))
    setOpen(true)
  }

  const close = (refocus = true) => {
    setOpen(false)
    setActiveIndex(-1)
    if (refocus) btnRef.current?.focus()
  }

  /** The next option in `step` direction that can actually be chosen. */
  function firstEnabled(from: number, step: number) {
    for (let i = from; i >= 0 && i < options.length; i += step) {
      if (!options[i].disabled) return i
    }
    return -1
  }

  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange({ target: { value: option.value } })
    close()
  }

  /** Jump to whatever the operator has started spelling, the way a native select does. */
  const typeAhead = (key: string) => {
    const now = Date.now()
    const text = now - typed.current.at > 700 ? key : typed.current.text + key
    typed.current = { text, at: now }
    const from = activeIndex >= 0 ? activeIndex : selectedIndex
    const order = [
      ...options.slice(from + 1).map((_, i) => from + 1 + i),
      ...options.slice(0, from + 1).map((_, i) => i),
    ]
    const hit = order.find((i) => !options[i].disabled && texts[i].startsWith(text.toLowerCase()))
    if (hit === undefined) return
    if (open) setActiveIndex(hit)
    else choose(hit)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        close()
      }
      return
    }
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault()
        openList()
        return
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        typeAhead(e.key)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => {
          const next = firstEnabled(i + 1, 1)
          return next >= 0 ? next : i
        })
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => {
          const next = firstEnabled(i - 1, -1)
          return next >= 0 ? next : i
        })
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(firstEnabled(0, 1))
        break
      case 'End':
        e.preventDefault()
        setActiveIndex(firstEnabled(options.length - 1, -1))
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        choose(activeIndex)
        break
      case 'Tab':
        // Tabbing away commits nothing and closes, as a native select does.
        close(false)
        break
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          typeAhead(e.key)
        }
    }
  }

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || listRef.current?.contains(target)) return
      close(false)
    }
    const onReflow = () => place()
    document.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Keep the highlighted option in view when the list is walked with the keyboard.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const activeId = open && activeIndex >= 0 ? `${listId.current}-${activeIndex}` : undefined

  return (
    <div className={`ui-select ${className || ''}`} ref={wrapRef}>
      <button
        type="button"
        id={id}
        ref={btnRef}
        className="ui-select-trigger"
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId.current : undefined}
        aria-activedescendant={activeId}
        onKeyDown={onKeyDown}
        onClick={() => (open ? close() : openList())}
      >
        <span className={selected ? 'ui-select-value' : 'ui-select-value ui-select-placeholder'}>
          {selected ? selected.label : options[0]?.label}
        </span>
        <span className={`ui-select-chevron ${open ? 'open' : ''}`}>⌄</span>
      </button>
      {open && rect
        ? createPortal(
            <div
              ref={listRef}
              id={listId.current}
              className="ui-select-list"
              role="listbox"
              style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width }}
            >
              {options.map((o, i) => (
                <div
                  key={o.value}
                  id={`${listId.current}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  className={`ui-select-option ${o.value === value ? 'active' : ''} ${
                    i === activeIndex ? 'focused' : ''
                  } ${o.disabled ? 'disabled' : ''}`}
                  // Mouse down on an option must not blur the trigger before the click
                  // lands, or the list closes out from under the choice.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => !o.disabled && setActiveIndex(i)}
                  onClick={() => choose(i)}
                >
                  {o.label}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
