/**
 * The state-machine rules — legality straight off the frozen LEGAL_TRANSITIONS
 * (contracts §3), plus the guard-evaluation hooks that let a caller judge a
 * transition's guards against facts it holds (ARCHITECTURE §3: the client
 * pre-checks the same keys the server enforces, so a disabled action can say
 * why in plain language).
 *
 * Pure data-in/data-out over the contract tables; nothing here reads a
 * document store, and the `.ts` import extensions follow the api-compile
 * convention (src/lib/stock.ts).
 */
import {
  GUARD_EXPLANATIONS,
  LEGAL_TRANSITIONS,
  type GuardKey,
  type StateMachineName,
} from '../contracts.ts'

/** The moves the machine allows out of `from` — terminal statuses answer []. */
export function legalTargets(entity: StateMachineName, from: string): readonly string[] {
  const machine = LEGAL_TRANSITIONS[entity]
  const moves = (machine.transitions as Record<string, readonly { to: string }[]>)[from]
  return moves ? moves.map((m) => m.to) : []
}

/** Whether `from → to` is a legal move on this entity's machine. A status the
 *  machine does not know, and a self-loop nobody listed, are both illegal. */
export function canTransition(entity: StateMachineName, from: string, to: string): boolean {
  return legalTargets(entity, from).includes(to)
}

/** Every guard that must pass for `from → to`, in the contract's order. An
 *  illegal transition answers [] — no guards to satisfy because there is no
 *  move to satisfy them for (canTransition is the legality question). */
export function guardsRequired(entity: StateMachineName, from: string, to: string): readonly GuardKey[] {
  const machine = LEGAL_TRANSITIONS[entity]
  const moves = (machine.transitions as Record<string, readonly { to: string; guards: readonly GuardKey[] }[]>)[from]
  const move = moves?.find((m) => m.to === to)
  return move ? move.guards : []
}

/** The plain-language refusal text for one guard — the single source the UI
 *  reads (contracts GUARD_EXPLANATIONS). */
export function explainGuard(guard: GuardKey): string {
  return GUARD_EXPLANATIONS[guard]
}

/** Why `from → to` is refused, in plain language — null when it is legal.
 *  An illegal move names the guard-shaped rule it broke; a legal one has
 *  nothing to explain. */
export function explainRefusal(entity: StateMachineName, from: string, to: string): string | null {
  if (canTransition(entity, from, to)) return null
  const known = legalTargets(entity, from)
  if (known.length === 0) {
    return `${from || 'this record'} is closed — nothing may move it to ${to}.`
  }
  return `${from} cannot move to ${to}. From there it may only move to ${known.join(', ')}.`
}

/**
 * The facts a guard is judged against, one boolean per GuardKey: true is
 * "passes", false is "fails". A guard ABSENT from the facts is treated as
 * passing — an evaluation only judges the guards its caller can see, and the
 * server's dedicated gates (rulesGate, RBAC, the CAS engine) remain the
 * authority for the ones it cannot. `role_allowed` and `cas_version` apply to
 * every transition and are judged where every transition is judged.
 */
export type GuardFacts = Partial<Record<GuardKey, boolean>>

/** One transition judged: legality plus which of its guards failed. */
export interface GuardEvaluation {
  entity: StateMachineName
  from: string
  to: string
  /** False when the move itself is illegal, or any judged guard failed. */
  allowed: boolean
  /** The guards whose fact was present and false, in contract order. */
  failed: readonly GuardKey[]
}

/**
 * The guard-evaluation hook: legality from the frozen table, then each of the
 * move's guards judged against the supplied facts. The same call serves a
 * client menu (facts it knows, absent guards pass) and a server gate (every
 * guard it enforces supplied).
 */
export function evaluateGuards(
  entity: StateMachineName,
  from: string,
  to: string,
  facts: GuardFacts,
): GuardEvaluation {
  const guards = guardsRequired(entity, from, to)
  const legal = canTransition(entity, from, to)
  const failed = legal ? guards.filter((g) => facts[g] === false) : []
  return { entity, from, to, allowed: legal && failed.length === 0, failed }
}

/** An evaluation's plain-language answer: every failed guard's explanation,
 *  or the illegality text — null when the move is allowed. */
export function explainEvaluation(evaluation: GuardEvaluation): string | null {
  if (evaluation.allowed) return null
  if (evaluation.failed.length) {
    return evaluation.failed.map((g) => GUARD_EXPLANATIONS[g]).join(' ')
  }
  return explainRefusal(evaluation.entity, evaluation.from, evaluation.to)
}
