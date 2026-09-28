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
   * trial flag: present = the SDK script is emitted and boots; absent = the
   * build carries no SDK at all (vite.config.ts gates on this same value).
   * Must never be set in the Vercel Production environment.
   */
  readonly VITE_APPTICS_APP_TOKEN?: string
  /** Optional Apptics data-center code (IN, EU…) as the console snippet shows it. */
  readonly VITE_APPTICS_DC?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
