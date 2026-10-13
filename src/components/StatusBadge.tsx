import type { ComponentType } from 'react'
import { readStatus } from '../lib/statusPalette.ts'
import { statusClass, statusLabel } from '../lib/utils'
import {
  Check,
  CheckCircle,
  Clock,
  HomeCheck,
  Pause,
  Play,
  Rotate,
  Slash,
  Truck,
  TruckOut,
  Undo,
  X,
} from './StatusIcons'

/** statusPalette icon name → its glyph component. */
const ICONS: Record<string, ComponentType> = {
  clock: Clock,
  play: Play,
  pause: Pause,
  check: Check,
  checkCircle: CheckCircle,
  x: X,
  rotate: Rotate,
  truckOut: TruckOut,
  truck: Truck,
  homeCheck: HomeCheck,
  undo: Undo,
  slash: Slash,
} as const

/**
 * Renders a stored status in the one word the app uses for it everywhere —
 * and, when the key belongs to the eleven-state palette (GLOSSARY), with its
 * glyph beside the word: status is never colour-only. Keys outside the
 * palette (stock's Available, master-data's Active) keep the legacy plain
 * reading; data never changes, only the reading of it.
 */
export function StatusBadge({ value }: { value: string }) {
  const reading = readStatus(value)
  if (!reading) {
    return <span className={`status ${statusClass(value)}`}>{statusLabel(value)}</span>
  }
  const Icon = reading.icon ? ICONS[reading.icon] : undefined
  return (
    <span className={`status ${reading.tone}`}>
      {Icon ? <Icon /> : null}
      {reading.label}
    </span>
  )
}
