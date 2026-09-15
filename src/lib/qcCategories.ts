import type { TestCategory } from '../types'

export const QC_CATEGORIES: { key: TestCategory; title: string }[] = [
  { key: 'micro', title: 'Microbiology' },
  { key: 'pesticides', title: 'Pesticide Residues' },
  { key: 'heavyMetals', title: 'Heavy Metals' },
  { key: 'physico', title: 'Physicochemical' },
]

export function categoryTitle(key: TestCategory | string): string {
  return QC_CATEGORIES.find((c) => c.key === key)?.title || key
}
