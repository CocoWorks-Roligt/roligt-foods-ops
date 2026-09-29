/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /**
   * WorkOS AuthKit public client id. Used only as a build-time flag telling the
   * SPA a real auth server exists — the browser never talks to WorkOS directly.
   * Absent means the dev fallback session (no /api/auth/* traffic at all).
   */
  readonly VITE_WORKOS_CLIENT_ID?: string
  /**
   * Zoho Apptics app token (the aaID inside the console's snippet). A staging
   * trial flag: present = the init script loads and the SDK boots; absent =
   * nothing is fetched at all. Must never be set in the Vercel Production
   * environment.
   */
  readonly VITE_APPTICS_APP_TOKEN?: string
  /** Apptics org id, from the same snippet's init URL. Staging trial only. */
  readonly VITE_APPTICS_ZSOID?: string
  /** Apptics project id, from the same snippet's init URL. Staging trial only. */
  readonly VITE_APPTICS_PROJECT_ID?: string
  /** Optional Apptics data-center code (IN, EU…) as the console snippet shows it. */
  readonly VITE_APPTICS_DC?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
