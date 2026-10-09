import { useCallback, useMemo, useState } from 'react'
import { useApp } from '../../context/AppContext'
import type { PackDef } from '../../lib/packs'
import { blankMaterial } from './constants'
import { MaterialForm } from './MaterialForm'
import { PackDefForm } from './PackDefForm'

/**
 * The pack form with its packing-material companion — the machinery that lets a BOM
 * row create the material it wants without losing the half-filled pack: the material
 * form opens over this one, and the new material's id finds its way back to the row
 * that asked for it on the render after it lands.
 *
 * Both places a pack is created use this. The Products & Materials page, and the
 * packing run form's quick-create — so a run is never abandoned mid-fill because no
 * pack exists for its bulk yet.
 */
export function PackDefDialog({
  open,
  editing,
  seedBulk,
  onClose,
}: {
  open: boolean
  editing?: PackDef
  /** Bulk to pre-assign as a new pack's first recipe; the quick-create names the
   *  bulk it is filling. */
  seedBulk?: string
  onClose: () => void
}) {
  const { state } = useApp()
  /**
   * Set while the packing-material form was opened from a pack's BOM row. `knownIds`
   * is the snapshot the new material is spotted against, because the create call
   * cannot hand its id back — it is assigned inside a setState updater that has not
   * run yet when the call returns.
   */
  const [pendingBom, setPendingBom] = useState<{ idx: number; knownIds: string[] } | null>(null)
  const [materialOpen, setMaterialOpen] = useState(false)

  // Stable, so the pack form's fill effect does not re-run on every render.
  const clearPendingBom = useCallback(() => setPendingBom(null), [])

  const pmItems = state.items.filter((i) => i.type === 'Packing Material')

  // The material lands in state a render after it is saved; this is it coming back
  // to the BOM row it was created for.
  const filledMaterial = useMemo(() => {
    if (!pendingBom) return null
    const created = pmItems.find((i) => !pendingBom.knownIds.includes(i.id))
    return created ? { idx: pendingBom.idx, itemId: created.id } : null
  }, [pendingBom, pmItems])

  /** Opens the packing-material form over the pack form, to fill BOM row `idx`. */
  const startNewMaterial = (idx: number) => {
    setPendingBom({ idx, knownIds: pmItems.map((i) => i.id) })
    // The pack form stays open underneath, so a half-filled pack is not thrown away
    // to add a carton to it.
    setMaterialOpen(true)
  }

  return (
    <>
      <PackDefForm
        open={open}
        editing={editing}
        seedBulk={seedBulk}
        onClose={onClose}
        onNewMaterial={startNewMaterial}
        fillMaterial={filledMaterial}
        onMaterialFilled={clearPendingBom}
      />

      <MaterialForm
        open={materialOpen}
        initial={blankMaterial('Packing Material', 'Piece')}
        onClose={() => {
          // Dismissed without saving: the BOM row it was opened for gets nothing.
          setPendingBom(null)
          setMaterialOpen(false)
        }}
        // Saved: `pendingBom` is left alone so the new material can find its way back
        // to the row that asked for it, on the render after it reaches state.
        onSaved={() => setMaterialOpen(false)}
      />
    </>
  )
}
