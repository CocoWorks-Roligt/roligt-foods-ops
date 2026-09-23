/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /** Kinde SPA credentials. All optional: absent means the dev fallback session. */
  readonly VITE_KINDE_DOMAIN?: string
  readonly VITE_KINDE_CLIENT_ID?: string
  readonly VITE_KINDE_REDIRECT_URI?: string
  readonly VITE_KINDE_LOGOUT_URI?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
