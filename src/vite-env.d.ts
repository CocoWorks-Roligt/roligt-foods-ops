/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /**
   * WorkOS AuthKit public client id. Used only as a build-time flag telling the
   * SPA a real auth server exists — the browser never talks to WorkOS directly.
   * Absent means the dev fallback session (no /api/auth/* traffic at all).
   */
  readonly VITE_WORKOS_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
