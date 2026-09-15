import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Which record a page's View dialog is showing, opened by `?view=` as well as by a click.
 *
 * Every page kept its open record in local state only, so there was no address for a
 * record: nothing could link to a batch, and a link from a QC verdict had nowhere to
 * land. The record is in the URL now, which also means the browser's Back button walks
 * back along the chain the way it was followed.
 *
 * `exists` keeps a stale or mistyped `?view=` from opening an empty dialog.
 */
export function useLinkedView(exists: (id: string) => boolean) {
  const [params, setParams] = useSearchParams()
  const linked = params.get('view') || ''
  const [viewId, setViewId] = useState(() => (linked && exists(linked) ? linked : ''))

  useEffect(() => {
    if (linked && exists(linked)) setViewId(linked)
    // Follows the address, not the lookup: `exists` is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked])

  const closeView = () => {
    setViewId('')
    if (!params.has('view')) return
    const next = new URLSearchParams(params)
    next.delete('view')
    setParams(next, { replace: true })
  }

  return [viewId, setViewId, closeView] as const
}
