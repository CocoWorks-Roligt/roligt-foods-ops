import { useState } from 'react'
import { Select } from '../../components/Select'
import { useApp } from '../../context/AppContext'
import { OTHER } from './constants'

/**
 * Pieces the four master forms on the Products & Materials page share.
 *
 * The page was one component of eleven hundred lines holding five masters, four
 * dialogs and a dozen pieces of state, which is a lot to hold in your head to change
 * one label on one card. It is a folder now; this file is what genuinely belongs to
 * more than one of them.
 */

/**
 * A short fixed list with a way out. Left as free text, "Kg", "kg" and "kgs" became
 * three different units and one produce turned into three rows nothing could pool;
 * a plain dropdown would have blocked the plant's next format instead. Picking
 * "Something else…" hands back the text box for that one entry.
 */
export function ChoiceOrOther({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string
  options: string[]
  placeholder: string
  onChange: (next: string) => void
}) {
  const [freeText, setFreeText] = useState(false)
  const [fallback, setFallback] = useState(value)
  const known = options.includes(value)
  if (freeText || (value && !known)) {
    return (
      <input
        value={value}
        placeholder={placeholder}
        autoFocus={freeText}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          // Clicking away from an empty box would otherwise leave the field with
          // nothing selected and no way back to the list.
          if (!value.trim()) onChange(fallback)
          setFreeText(false)
        }}
      />
    )
  }
  return (
    <Select
      value={value}
      onChange={(e) => {
        if (e.target.value === OTHER) {
          setFallback(value)
          setFreeText(true)
          onChange('')
          return
        }
        onChange(e.target.value)
      }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      <option value={OTHER}>Something else…</option>
    </Select>
  )
}

/**
 * Who a product is bought from, farmers and vendors kept apart.
 *
 * One picker, used by the form that creates a product and the one that only changes
 * its suppliers. They were two copies of the same markup, and the copy on the second
 * dialog had quietly stopped showing which type each supplier was.
 */
export function SupplierPicker({
  selected,
  onToggle,
  showType = false,
}: {
  selected: string[]
  onToggle: (id: string) => void
  /** Prints "· Farmer" beside each name, for the form where the distinction matters. */
  showType?: boolean
}) {
  const { state, vendorTypeName } = useApp()
  const groups = [
    { label: 'Farmers', empty: 'No farmers yet', typeId: 'VT-FARMER' },
    { label: 'Vendors', empty: 'No vendors yet', typeId: 'VT-VENDOR' },
  ]
  return (
    <div className="supplier-picker">
      {groups.map((group) => {
        const list = state.vendors.filter((v) => v.vendorTypeId === group.typeId)
        return (
          <div className="supplier-group" key={group.typeId}>
            <div className="small" style={{ fontWeight: 800, marginBottom: 8 }}>
              {group.label}
            </div>
            {list.length ? (
              list.map((v) => (
                <label key={v.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(v.id)}
                    onChange={() => onToggle(v.id)}
                  />
                  <span>
                    {v.name}
                    {showType ? (
                      <span className="small"> · {vendorTypeName(v.vendorTypeId)}</span>
                    ) : null}
                  </span>
                </label>
              ))
            ) : (
              <div className="small">{group.empty}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
