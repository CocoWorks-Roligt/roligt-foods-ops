import type { KeyboardEvent, MouseEvent } from 'react'

/**
 * The props that make a table row open a record's detail view.
 *
 * The row is the whole target: pointer users click anywhere on it, keyboard users
 * tab to it and press Enter. Buttons and links inside the row — actions, document
 * links — keep their own destinations, on both the click and the key path.
 */
export function detailRowProps(open: () => void) {
  return {
    className: 'row-open',
    onClick: (e: MouseEvent<HTMLTableRowElement>) => {
      if ((e.target as HTMLElement).closest('button, a')) return
      open()
    },
    onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if ((e.target as HTMLElement).closest('button, a')) return
      e.preventDefault()
      open()
    },
    tabIndex: 0,
  }
}
