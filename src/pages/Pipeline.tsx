/**
 * Pipeline Home (WORKFLOW, behind the `pipeline` flag): the process as one
 * horizontal board — every stage with what waits in it, bottlenecks called out
 * in plain words, one click from a stage to its records. The board folds the
 * plant the tab already holds (src/lib/pipeline.ts), so its counts are the
 * same numbers the sidebar badges and the pages below show, live with the
 * same revision feed.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { DataTable, type Column, type DataTableProps } from '../components/shell/DataTable'
import { useApp } from '../context/AppContext'
import { STAGE_HELP } from '../lib/onboarding.ts'
import { pipelineStages, type PipelineRow, type PipelineStage } from '../lib/pipeline.ts'
import { toDateKey } from '../lib/utils.ts'

const FLAG_LABEL: Record<string, string> = {
  stuck: 'Stuck',
  hold: 'On hold',
  expiry: 'Expiring',
  overdue: 'Overdue',
}

function StageTile({
  stage,
  active,
  onSelect,
}: {
  stage: PipelineStage
  active: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        className={`pipeline-tile${active ? ' active' : ''}${stage.flag ? ' flagged' : ''}`}
        aria-pressed={active}
        // what the count means and what its rows owe — onboarding.ts's words (W16)
        title={STAGE_HELP[stage.id]}
        onClick={onSelect}
      >
        <span className="pipeline-count">{stage.count}</span>
        <span className="pipeline-label">{stage.label}</span>
        <span className="pipeline-kind">{stage.queue ? 'waiting' : 'today'}</span>
        {stage.flag ? <span className="pipeline-flag">{FLAG_LABEL[stage.flag.kind]}: {stage.flag.note}</span> : null}
      </button>
    </li>
  )
}

export function Pipeline() {
  const { state } = useApp()
  const navigate = useNavigate()
  const today = toDateKey()
  const stages = useMemo(() => pipelineStages(state, today), [state, today])

  const firstFlagged = stages.find((s) => s.flag)?.id
  const firstBusy = stages.find((s) => s.count > 0)?.id
  const [selected, setSelected] = useState<string>(firstFlagged ?? firstBusy ?? 'receipts')
  const stage = stages.find((s) => s.id === selected) ?? stages[0]

  const flagged = stages.filter((s) => s.flag)
  const onRowClick: DataTableProps<PipelineRow>['onRowClick'] = (row) => navigate(row.href)

  const columns: Column<PipelineRow>[] = [
    {
      key: 'label',
      label: 'What',
      render: (r) => (
        <div>
          <div>{r.label}</div>
          {r.detail ? <div className="cell-sub">{r.detail}</div> : null}
        </div>
      ),
      sort: (r) => r.label,
    },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} />, sort: (r) => r.status },
    { key: 'date', label: 'Date', sort: (r) => r.date ?? '', render: (r) => r.date ?? '—' },
  ]

  return (
    <div className="card">
      <div className="section-head">
        <div>
          {/* h2, not h3: the page card sits directly under the app's h1, and a
              skipped level is the heading-order a11y flag (Phase-6 QA §5). */}
          <h2>Pipeline</h2>
          <span>The process at a glance — bottlenecks first, one click to the records</span>
        </div>
      </div>

      {flagged.length ? (
        <ul className="pipeline-flags" aria-label="Bottlenecks">
          {flagged.map((s) => (
            <li key={s.id}>
              <strong>{s.label}:</strong> {s.flag!.note}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pipeline-clear">No bottlenecks — nothing stuck, held or overdue.</p>
      )}

      <ol className="pipeline-board" aria-label="Stages in process order" data-tour="pipeline-board">
        {stages.map((s) => (
          <StageTile key={s.id} stage={s} active={s.id === stage.id} onSelect={() => setSelected(s.id)} />
        ))}
      </ol>

      {stage.count === 0 ? (
        <EmptyState
          filtered={false}
          empty={stage.queue ? `Nothing waiting in ${stage.label.toLowerCase()}.` : `Nothing in ${stage.label.toLowerCase()} yet today.`}
          onClear={() => setSelected(stage.id)}
        />
      ) : (
        <>
          <h3 className="pipeline-drill-title">
            {stage.label} · {stage.queue ? 'waiting' : 'today'} · {stage.count}
          </h3>
          <DataTable
            id="pipeline-stage"
            columns={columns}
            rows={stage.rows}
            rowKey={(r) => r.id}
            empty=""
            onRowClick={onRowClick}
          />
        </>
      )}
    </div>
  )
}
