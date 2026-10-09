/**
 * Where a fixed-position dropdown should sit under its trigger.
 *
 * Both poplists (Select and the batch autocomplete) anchor at the trigger's
 * bottom edge, which in a phone's full-screen modal can be a couple of taps
 * from the viewport's bottom — the list then ran past the screen and its last
 * options were unreachable, because the modal body had nowhere left to scroll
 * to. The list is clamped to the space the viewport actually offers below the
 * trigger, and flipped above the trigger when that space cannot hold a usable
 * list while there is more room above.
 */

/** `bottom` set (and `top` unset) pins the list's bottom edge just above the
 *  trigger; it grows upward, capped by `maxHeight`. */
export function placeDropdown(
  r: { top: number; bottom: number; left: number; width: number },
  maxListHeight: number,
): { top?: number; bottom?: number; left: number; width: number; maxHeight: number } {
  const below = window.innerHeight - r.bottom - 12
  const above = r.top - 12
  if (below < 160 && above > below) {
    return {
      bottom: window.innerHeight - r.top + 4,
      left: r.left,
      width: r.width,
      maxHeight: Math.min(maxListHeight, above),
    }
  }
  return {
    top: r.bottom + 4,
    left: r.left,
    width: r.width,
    // The floor keeps a usable list even when both sides are cramped (a
    // landscape phone's height) — it scrolls inside either way.
    maxHeight: Math.max(96, Math.min(maxListHeight, below)),
  }
}
