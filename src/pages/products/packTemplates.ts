import type { Item } from '../../types'

/**
 * What a new pack's bill of materials usually is, by pack type — the starting rows
 * the "what one pack is made of" section offers so the admin is not staring at an
 * empty grid wondering what a BiB even consumes.
 *
 * A template names materials by the words the plant calls them, not by id: ids are
 * minted per install, but "pouch", "cap" and "label" are what the shelves say. Each
 * entry matches the FIRST material whose name carries its word; nothing is invented —
 * a part with no matching material on file is skipped, and the row can still be
 * added and created inline by hand.
 */
const PACK_TEMPLATES: Record<string, { word: RegExp; qty: number }[]> = {
  BiB: [
    { word: /pouch|\bbib\b/i, qty: 1 },
    { word: /cap/i, qty: 1 },
  ],
  'Glass Bottle': [
    { word: /bottle/i, qty: 1 },
    { word: /cap/i, qty: 1 },
    { word: /label|sticker/i, qty: 1 },
  ],
  'PET Bottle': [
    { word: /bottle/i, qty: 1 },
    { word: /cap/i, qty: 1 },
    { word: /label|sticker/i, qty: 1 },
  ],
  Pouch: [
    { word: /pouch/i, qty: 1 },
    { word: /cap|spout/i, qty: 1 },
  ],
  Can: [
    { word: /\bcan\b/i, qty: 1 },
    { word: /lid/i, qty: 1 },
    { word: /label|sticker/i, qty: 1 },
  ],
  Cover: [{ word: /film|sheet|cover/i, qty: 1 }],
}

/** The parts the pack type's template names, for the chips the form offers. */
export const templateParts = (type: string) => PACK_TEMPLATES[type] || []

/**
 * The template as filled-in BOM rows: each part matched against the packing
 * materials that exist, first match winning, parts with no match skipped. Empty
 * when nothing on file matches any part — then the chip is not offered at all,
 * because a button that fills nothing is worse than no button.
 */
export function suggestBom(
  pmItems: Item[],
  type: string,
): { item: string; qty: number }[] {
  const rows: { item: string; qty: number }[] = []
  for (const part of templateParts(type)) {
    const found = pmItems.find((i) => part.word.test(i.name))
    if (found) rows.push({ item: found.id, qty: part.qty })
  }
  return rows
}
