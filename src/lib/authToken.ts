/** Hand-off between the auth layer and dbApi: the BFF token of the signed-in user. */
let token: string | null = null
export function setAuthToken(next: string | null): void {
  token = next
}
export function getAuthToken(): string | null {
  return token
}
