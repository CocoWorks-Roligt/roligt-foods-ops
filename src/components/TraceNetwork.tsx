/**
 * The traced chain as a network — records as nodes, "came from" as the edges between
 * them — built the way react-graph-gallery's network chart is: d3-force only computes
 * where each node goes, and React draws every element.
 *
 * Two departures from that tutorial, both because of the data rather than despite it.
 * It draws with SVG, not canvas: a trace is tens of records, not thousands, and SVG
 * gives every node a click, keyboard focus and a label for free — the canvas advice is
 * about the cost of thousands of DOM elements. And the force layout is pinned into
 * columns, left to right, by how many steps each record is from the start of the chain:
 * a free-floating tangle would lose the one thing a trace must show, which is the
 * direction the goods travelled.
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  NODE_KIND_LABEL,
  NODE_KIND_ORDER,
  type TraceGraph,
  type TraceNode,
} from '../lib/traceGraph'

type SimNode = TraceNode & SimulationNodeDatum
type SimLink = SimulationLinkDatum<SimNode>

/** Node radius, and the space kept round the edge of the chart. */
const R = 15
const PAD = 56
/** The narrowest a column gets before the chart scrolls sideways instead. */
const MIN_COLUMN = 140
/** Vertical room per record in the busiest column. */
const ROW = 74
/** Past this a network is a tangle nobody can read, and the chain view says it better. */
const MAX_NODES = 250

const shorten = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Everything upstream and downstream of one record — its whole line through the chain. */
function lineage(graph: TraceGraph, id: string) {
  const found = new Set([id])
  for (const [from, to] of [
    ['source', 'target'],
    ['target', 'source'],
  ] as const) {
    const seen = new Set([id])
    const stack = [id]
    while (stack.length) {
      const at = stack.pop()!
      for (const e of graph.edges) {
        if (e[from] !== at || seen.has(e[to])) continue
        seen.add(e[to])
        found.add(e[to])
        stack.push(e[to])
      }
    }
  }
  return found
}

export function TraceNetwork({ graph }: { graph: TraceGraph }) {
  const navigate = useNavigate()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  const [, redraw] = useState(0)
  const [focus, setFocus] = useState<string | null>(null)
  const simulation = useRef<Simulation<SimNode, SimLink> | null>(null)
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null)

  // Follow the container's width, so the columns spread across whatever room there is.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setAvailable(el.clientWidth)
    const observer = new ResizeObserver(([entry]) => setAvailable(Math.floor(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => {
    const perDepth = new Map<number, number>()
    for (const n of graph.nodes) perDepth.set(n.depth, (perDepth.get(n.depth) || 0) + 1)
    const columns = Math.max(1, ...graph.nodes.map((n) => n.depth + 1))
    const width = Math.max(available, PAD * 2 + (columns - 1) * MIN_COLUMN)
    const height = Math.max(300, Math.max(1, ...perDepth.values()) * ROW + PAD)
    const gap = columns > 1 ? (width - PAD * 2) / (columns - 1) : 0
    const columnX = (depth: number) => (columns > 1 ? PAD + depth * gap : width / 2)
    return { perDepth, width, height, gap, columnX }
  }, [available, graph])

  /** Copies, because the simulation writes positions onto what it is given. */
  const { nodes, links } = useMemo(() => {
    const seen = new Map<number, number>()
    const nodes: SimNode[] = graph.nodes.map((n) => {
      const i = seen.get(n.depth) || 0
      seen.set(n.depth, i + 1)
      const count = layout.perDepth.get(n.depth) || 1
      // Each record starts where it belongs, so the simulation only has to tidy up.
      return { ...n, x: layout.columnX(n.depth), y: ((i + 1) * layout.height) / (count + 1) }
    })
    const links: SimLink[] = graph.edges.map((e) => ({ source: e.source, target: e.target }))
    return { nodes, links }
  }, [graph, layout])

  useEffect(() => {
    if (!available || nodes.length > MAX_NODES) return
    const sim = forceSimulation<SimNode, SimLink>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(Math.max(80, layout.gap * 0.85))
          .strength(0.15),
      )
      .force('charge', forceManyBody<SimNode>().strength(-240))
      .force('collide', forceCollide<SimNode>(R + 20))
      // The columns are the point: a record sits as many steps along as it is from the start.
      .force('x', forceX<SimNode>((d) => layout.columnX(d.depth)).strength(1))
      .force('y', forceY<SimNode>(layout.height / 2).strength(0.05))
      .stop()
    // Settled before the first paint, so the chart arrives laid out rather than flying in.
    sim.tick(300)
    sim.on('tick', () => redraw((f) => f + 1))
    simulation.current = sim
    redraw((f) => f + 1)
    return () => {
      sim.stop()
      simulation.current = null
    }
  }, [available, layout, links, nodes])

  if (graph.nodes.length > MAX_NODES) {
    return (
      <div className="note">
        This trace reaches {graph.nodes.length} records — too many to draw as a network anyone
        could read. Narrow the search, or switch to the chain.
      </div>
    )
  }

  const { width, height } = layout
  const lit = focus ? lineage(graph, focus) : null
  const px = (n: SimNode) => Math.max(R + 2, Math.min(width - R - 2, n.x ?? 0))
  const py = (n: SimNode) => Math.max(R + 2, Math.min(height - R - 20, n.y ?? 0))

  const pointer = (e: PointerEvent<SVGGElement>) => {
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) * width) / rect.width,
      y: ((e.clientY - rect.top) * height) / rect.height,
    }
  }
  const open = (n: SimNode) => {
    if (n.href) navigate(n.href)
  }
  const onDown = (e: PointerEvent<SVGGElement>, n: SimNode) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = pointer(e)
    drag.current = { id: n.id, x: p.x, y: p.y, moved: false }
  }
  const onMove = (e: PointerEvent<SVGGElement>, n: SimNode) => {
    const d = drag.current
    if (!d || d.id !== n.id) return
    const p = pointer(e)
    if (!d.moved) {
      if (Math.hypot(p.x - d.x, p.y - d.y) < 4) return
      d.moved = true
      simulation.current?.alphaTarget(0.2).restart()
    }
    n.fx = p.x
    n.fy = p.y
  }
  const onUp = (n: SimNode) => {
    const d = drag.current
    drag.current = null
    // Let go, and the column pulls it back into line.
    n.fx = null
    n.fy = null
    simulation.current?.alphaTarget(0)
    // A press that did not travel is a click.
    if (d && d.id === n.id && !d.moved) open(n)
  }
  const onKey = (e: KeyboardEvent<SVGGElement>, n: SimNode) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    open(n)
  }

  const focused = focus ? nodes.find((n) => n.id === focus) : undefined
  const kinds = NODE_KIND_ORDER.filter((k) => graph.nodes.some((n) => n.kind === k))

  return (
    <div className="trace-network" ref={wrapRef}>
      <div className="trace-network-hint">
        Hover or tab to a record to light up everything it came from and went into · drag one to
        untangle it · click to open it
      </div>
      <div className="trace-network-scroll">
        <div className="trace-network-canvas" style={{ width, height }}>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label="Traceability network"
          >
            <defs>
              <marker
                id="trace-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" className="trace-network-arrowhead" />
              </marker>
            </defs>
            <g>
              {links.map((l, i) => {
                if (typeof l.source !== 'object' || typeof l.target !== 'object') return null
                const s = l.source
                const t = l.target
                const [sx, sy, tx, ty] = [px(s), py(s), px(t), py(t)]
                const len = Math.hypot(tx - sx, ty - sy) || 1
                const [ux, uy] = [(tx - sx) / len, (ty - sy) / len]
                const on = !!lit && lit.has(s.id) && lit.has(t.id)
                return (
                  <line
                    key={`${s.id}-${t.id}-${i}`}
                    x1={sx + ux * R}
                    y1={sy + uy * R}
                    x2={tx - ux * (R + 3)}
                    y2={ty - uy * (R + 3)}
                    className={`trace-network-link${lit ? (on ? ' lit' : ' dim') : ''}`}
                    markerEnd="url(#trace-arrow)"
                  />
                )
              })}
            </g>
            <g>
              {nodes.map((n) => {
                const on = !!lit && lit.has(n.id)
                return (
                  <g
                    key={n.id}
                    transform={`translate(${px(n)},${py(n)})`}
                    className={`trace-network-node kind-${n.kind}${n.href ? ' openable' : ''}${
                      lit ? (on ? ' lit' : ' dim') : ''
                    }`}
                    tabIndex={n.href ? 0 : -1}
                    role={n.href ? 'link' : undefined}
                    aria-label={`${NODE_KIND_LABEL[n.kind]} ${n.label}. ${n.detail}`}
                    onPointerEnter={() => setFocus(n.id)}
                    onPointerLeave={() => {
                      if (!drag.current) setFocus(null)
                    }}
                    onFocus={() => setFocus(n.id)}
                    onBlur={() => setFocus(null)}
                    onPointerDown={(e) => onDown(e, n)}
                    onPointerMove={(e) => onMove(e, n)}
                    onPointerUp={() => onUp(n)}
                    onKeyDown={(e) => onKey(e, n)}
                  >
                    <circle r={R} />
                    <text y={R + 14} textAnchor="middle" className="trace-network-label">
                      {shorten(n.label)}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>
          {focused ? (
            <div className="trace-network-tooltip" style={{ left: px(focused), top: py(focused) - R }}>
              <div className="small">{NODE_KIND_LABEL[focused.kind]}</div>
              <b>{focused.label}</b>
              <div>{focused.detail}</div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="trace-network-legend">
        {kinds.map((k) => (
          <span key={k} className={`kind-${k}`}>
            {NODE_KIND_LABEL[k]}
          </span>
        ))}
      </div>
    </div>
  )
}
