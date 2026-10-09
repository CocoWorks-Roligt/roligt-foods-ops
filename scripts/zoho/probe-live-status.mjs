/**
 * One spaced pair of criteria reads against a base's Config table — the exact
 * read shape readRevision makes. Answers "is Zoho throttling this API key right
 * now?", independent of the app's own budgets and caches.
 *
 *   node scripts/zoho/probe-live-status.mjs [baseId]
 *
 * Defaults to the PRODUCTION base (gerc53fe…) — the incident base. Reads only;
 * never writes. Two reads, spaced 8s: a throttle shows as the first failing and
 * the second passing (or both failing while the window stays hot).
 */
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.zoho.env', 'utf8').split('\n')) {
  const m = /^([A-Za-z_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1].toLowerCase()] = m[2]
}
const BASE = process.argv[2] || 'gerc53fe9f1e44e5f4a13809d9bd47367ba9d'
const CONFIG_TABLE = '0jAjUQ'
const SETTING_FIELD = 'batStA'

const tok = await fetch('https://accounts.zoho.in/oauth/v2/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    refresh_token: env.refresh_token,
    client_id: env.client_id,
    client_secret: env.client_secret,
    grant_type: 'refresh_token',
  }),
}).then((r) => r.json())
if (!tok.access_token) {
  console.error('token exchange failed:', JSON.stringify(tok).slice(0, 200))
  process.exit(1)
}

const readOnce = async (label) => {
  const res = await fetch('https://tables.zoho.in/api/v1/fetchRecordsWithCriteria', {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${tok.access_token}` },
    body: new URLSearchParams({
      base_id: BASE,
      table_id: CONFIG_TABLE,
      count: 10,
      criteria: `"${SETTING_FIELD}" = "app_revision"`,
      is_ids_used_in_params: 'true',
    }),
  })
  const text = await res.text()
  console.log(`[${label}] HTTP ${res.status} ${text.slice(0, 160)}`)
  return res.status
}

const a = await readOnce('t+0s')
await new Promise((r) => setTimeout(r, 8000))
const b = await readOnce('t+8s')
console.log(a === 200 && b === 200 ? 'VERDICT: Zoho is answering criteria reads — healthy' : 'VERDICT: Zoho is still refusing — throttled')
