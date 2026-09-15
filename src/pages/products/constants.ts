import type { PurchaseCategory, PurchaseProduct } from '../../types'

/**
 * The plain data the Products & Materials forms share, kept out of the component
 * files so each of those exports only components.
 */

/**
 * Formats the admin already packs in — free text, so this is a starting list only.
 * 'Carton' is deliberately not among them: an outer box is a packing material the
 * pack consumes, not a format the pack is sold in, and offering it in both places
 * is what made people create the same box twice.
 */
export const PACK_TYPES = ['BiB', 'Glass Bottle', 'PET Bottle', 'Cover', 'Pouch', 'Can']

/** What produce and packing material are counted in. */
export const UNITS = ['Piece', 'Kg', 'Litre']

/** Picked in a BOM row to create the material on the spot instead of picking one. */
export const NEW_MATERIAL = '__new_material__'

/**
 * Picked in a short list to type something the list does not offer.
 *
 * Underscored rather than the NUL character this used to be: the value ends up in a
 * DOM attribute, and a control character there is asking for trouble from anything
 * that later reads the markup. Nothing the plant would ever call a unit or a pack
 * type looks like this.
 */
export const OTHER = '__other__'

export const toggleVendor = (list: string[], id: string) =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

/** What the raw-material / packing-material form holds while it is being filled in. */
export interface MaterialDraft {
  name: string
  category: PurchaseCategory
  uom: string
  description: string
  vendorIds: string[]
}

export const blankMaterial = (category: PurchaseCategory, uom: string): MaterialDraft => ({
  name: '',
  category,
  uom,
  description: '',
  vendorIds: [],
})

export const materialFrom = (p: PurchaseProduct): MaterialDraft => ({
  name: p.name,
  category: p.category,
  uom: p.uom,
  description: p.description || '',
  vendorIds: [...(p.vendorIds || [])],
})
