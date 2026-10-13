import { useCallback, useEffect, useRef, useState } from 'react'
import type { KpiModule, KpiModuleResponse } from './contracts.ts'
import { useRevisionFeed } from './useRevisionFeed.ts'

/**
 * The dashboard's one data door (ARCHITECTURE §6): cards, charts, reports and
 * exports all read /api/kpis/:module, so numbers match by construction. The
 * hook owns fetching, the freshness verdict that rides the payload, and the
 * refetch the SSE revision feed asks for — a dashboard mounted under it never
 * shows silent stale data.
 */
export interface KpiState {
  data: KpiModuleResponse | null
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useKpis(module: KpiModule, from?: string, to?: string): KpiState {
  const [data, setData] = useState<KpiModuleResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
      const res = await fetch(`/api/kpis/${module}${qs.size ? `?${qs}` : ''}`)
      const body = (await res.json()) as KpiModuleResponse | { error?: string }
      if (mine !== seq.current) return // a newer ask already answered
      if (!res.ok) {
        setError('error' in body && body.error ? body.error : `Could not load figures (${res.status}).`)
        setData(null)
      } else {
        setData(body as KpiModuleResponse)
      }
    } catch {
      if (mine === seq.current) setError('Offline — figures cannot be reached right now.')
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [module, from, to])

  useEffect(() => {
    void load()
  }, [load])

  // Live: the token moved, so the fold behind these numbers may have too.
  useRevisionFeed(() => void load())

  return { data, loading, error, refresh: load }
}
