/**
 * The WorkOS management client — M2M with the server API key, for the RBAC seed
 * script and the admin endpoints. Nothing the browser loads ever imports this.
 * The account lives in the EU region, so the API hostname is pinned there with
 * an env override for the rare case of a move.
 */
import { WorkOS } from '@workos-inc/node'

export const workos = new WorkOS(process.env.WORKOS_API_KEY ?? '', {
  clientId: process.env.WORKOS_CLIENT_ID,
  apiHostname: process.env.WORKOS_API_HOSTNAME ?? 'api.eu.workos.com',
  maxRetries: 2,
})
