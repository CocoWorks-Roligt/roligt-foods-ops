import { Link } from 'react-router-dom'
import type { KpiCard as KpiCardWire } from '../../lib/contracts.ts'
import { fmtQty } from '../../lib/utils'

/**
 * A stat tile, not a chart: one headline figure, its word, and the change
 * against the previous period as a signed percent with a direction glyph —
 * never colour alone (the arrow says up/down; the word says better/worse is
 * the reader's to judge — spoilage going up is not the same news as yield
 * going up, so `invertDelta` flips the tone for metrics where down is good).
 * Click-through (contracts KpiCard.href) lands on the filtered records.
 */
export function KpiCard({ card, invertDelta = false }: { card: KpiCardWire; invertDelta?: boolean }) {
  const delta = card.deltaPct
  const hasDelta = typeof delta === 'number' && Number.isFinite(delta)
  const up = hasDelta && delta! > 0
  const flat = hasDelta && Math.abs(delta!) < 0.05
  const good = flat ? null : invertDelta ? !up : up

  const body = (
    <>
      <div className="kpi-label">{card.label}</div>
      <div className="kpi-value">
        {fmtQty(card.value, card.value % 1 === 0 ? 0 : 2)}
        {card.unit ? <span className="kpi-unit">{card.unit}</span> : null}
      </div>
      {hasDelta ? (
        <div className={`kpi-delta${good === null ? ' flat' : good ? ' good' : ' bad'}`}>
          <span aria-hidden="true">{flat ? '→' : up ? '▲' : '▼'}</span>
          {flat ? 'no change' : `${up ? '+' : ''}${fmtQty(delta!, 1)}%`}
          <span className="kpi-delta-note">vs previous period</span>
        </div>
      ) : null}
    </>
  )

  return card.href ? (
    <Link to={card.href} className="kpi-card kpi-link">
      {body}
    </Link>
  ) : (
    <div className="kpi-card">{body}</div>
  )
}
