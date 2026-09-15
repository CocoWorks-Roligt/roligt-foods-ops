/**
 * Identity for a row of a form that is still being filled in.
 *
 * Every subform on this app — a batch's source lots, a pack's bill of materials, the
 * lines of a stock issue — keyed its rows by array index. That is the standard React
 * footgun: delete the second of three rows and the third slides into its place, so
 * React reuses the component that was rendering the second one. Anything those rows
 * hold privately goes with it — an open dropdown, the text box `ChoiceOrOther` swaps
 * in, the caret in a number field — and the operator watches a dropdown they did not
 * open appear on a line they did not touch.
 *
 * A draft row is not a document and has nothing to identify it by, so it is given
 * something. It exists only while the form is open and is dropped when the payload is
 * built, which every form does by naming its fields rather than spreading the row.
 */

let seq = 0

/** A row carrying its own key while it is being edited. */
export type Keyed<T> = T & { rowId: string }

/** Tags one draft row. */
export const keyed = <T extends object>(row: T): Keyed<T> => ({
  ...row,
  rowId: `row-${++seq}`,
})

/** Tags a list of draft rows — reopening a document to edit it, mainly. */
export const keyedAll = <T extends object>(rows: T[]): Keyed<T>[] => rows.map(keyed)

/**
 * The row without its editing key, ready to be saved.
 *
 * Most forms build their payload by naming each field, which drops `rowId` on its
 * own. The few that hand their rows straight to the posting call have to say so —
 * otherwise a key that means nothing outside an open dialog gets written into the
 * plant's records and stays there.
 */
export const bare = <T extends object>(row: Keyed<T>): T => {
  const { rowId: _rowId, ...rest } = row
  return rest as unknown as T
}

/** `bare` over a list. */
export const bareAll = <T extends object>(rows: Keyed<T>[]): T[] => rows.map(bare)
