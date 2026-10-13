/**
 * The date presets every filter bar offers (SHELL): one tap answers "over what
 * range?"; the pair is the exact shape /api/kpis?from=&to= reads. Lives in lib
 * (not beside the component) so tests and future report filters share one
 * definition of "this month".
 */
export interface DateRange {
  from: string
  to: string
}

const day = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (n: number) => day(new Date(Date.now() + n * 86_400_000))

export const DATE_PRESETS: { label: string; range: () => DateRange }[] = [
  { label: '7 days', range: () => ({ from: addDays(-7), to: addDays(1) }) },
  { label: '30 days', range: () => ({ from: addDays(-30), to: addDays(1) }) },
  { label: 'This month', range: () => {
    const now = new Date()
    return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: addDays(1) }
  } },
  { label: 'Last month', range: () => {
    const now = new Date()
    return {
      from: day(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: day(new Date(now.getFullYear(), now.getMonth(), 0)),
    }
  } },
  { label: '6 months', range: () => ({ from: addDays(-183), to: addDays(1) }) },
]
