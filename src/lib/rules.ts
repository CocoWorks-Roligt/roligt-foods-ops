/**
 * The isomorphic rules module (ARCHITECTURE §5) — one barrel over `rules/`,
 * pure functions over documents. The client calls these for instant
 * pre-checks and plain-language refusals; api/ (commitGates → rulesGate)
 * calls the SAME functions as the authority. Zero api/ imports below this
 * line, and every relative import carries its `.ts` extension so the api
 * project's nodenext build compiles the chain (see src/lib/stock.ts).
 */
export * from './rules/flags.ts'
export * from './rules/stateMachines.ts'
export * from './rules/massBalance.ts'
export * from './rules/consumption.ts'
export * from './rules/spoilage.ts'
export * from './rules/cartons.ts'
