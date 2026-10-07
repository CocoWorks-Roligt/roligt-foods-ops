import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The Apptics staging gate has to fold at BUILD time, not run time. Vite only
  // replaces import.meta.env.<KEY> for keys that are SET — an unset key stays a
  // live property read, so APPTICS_CONFIGURED stayed a runtime value and the
  // dynamic import behind it stayed a graph edge: the bundler emitted the SDK
  // chunk unreferenced, and the workbox precache glob shipped its bytes (and
  // the trial's ids) in every production bundle anyway. Defining the three ids
  // here turns the guard into `false && …` for a build that carries no ids, the
  // dead branch (with the dynamic import) is tree-shaken, and no chunk exists
  // for the precache to find. process.env wins over the .env files, matching
  // Vite's own precedence; vitest is exempt because vi.stubEnv() drives the
  // same expressions at run time in the tests.
  const apptics = {
    ...loadEnv(mode, process.cwd(), 'VITE_APPTICS_'),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith('VITE_APPTICS_')),
    ),
  }
  const defineApptics = (key: string): string =>
    apptics[key] === undefined ? 'undefined' : JSON.stringify(apptics[key])
  const appticsConfigured = Boolean(
    apptics.VITE_APPTICS_APP_TOKEN && apptics.VITE_APPTICS_ZSOID && apptics.VITE_APPTICS_PROJECT_ID,
  )
  return {
    define: process.env.VITEST
      ? {}
      : {
          'import.meta.env.VITE_APPTICS_APP_TOKEN': defineApptics('VITE_APPTICS_APP_TOKEN'),
          'import.meta.env.VITE_APPTICS_ZSOID': defineApptics('VITE_APPTICS_ZSOID'),
          'import.meta.env.VITE_APPTICS_PROJECT_ID': defineApptics('VITE_APPTICS_PROJECT_ID'),
        },
    // The define above folds the guard, but the bundler still records the
    // dynamic-import edge and EMITS the SDK chunk unreferenced (chunking runs
    // before dead-code pruning) — and the workbox precache glob then ships the
    // orphan's bytes. An unconfigured build wants the module out of the graph,
    // not merely unreachable: marking it external emits nothing. The edge is
    // dead anyway (the guard folded), so nothing in the output can follow it.
    build: process.env.VITEST || appticsConfigured ? {} : { rollupOptions: { external: [/appticsSdk/] } },
    plugins: [
      react(),
      VitePWA({
        // We show our own "new version available" prompt instead of silently reloading,
        // so an operator is never interrupted mid-entry.
        registerType: 'prompt',
        injectRegister: null,
        includeAssets: [
          'icons/favicon.svg',
          'icons/favicon-32.png',
          'icons/favicon-16.png',
          'icons/apple-touch-icon.png',
        ],
        manifest: {
          id: '/',
          name: 'Roligt Foods Operations',
          short_name: 'Roligt Ops',
          description:
            'Procurement, production, quality control and dispatch control for Roligt Foods.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#f2f5f4',
          theme_color: '#118275',
          lang: 'en',
          dir: 'ltr',
          categories: ['business', 'productivity'],
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            {
              src: 'icons/icon-maskable-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: 'icons/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
          shortcuts: [
            {
              name: 'New GRN',
              short_name: 'Procurement',
              url: '/procurement',
              icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
            },
            {
              name: 'Production',
              short_name: 'Production',
              url: '/production',
              icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
            },
            {
              name: 'Quality Control',
              short_name: 'Quality',
              url: '/quality',
              icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
          // SPA: any navigation that misses the cache falls back to the app shell —
          // except the BFF: /api/auth/* are top-level navigations (login redirect,
          // logout, callback) that must reach the server, or the worker serves the
          // cached shell instead and auth silently dead-ends.
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
          // Every built asset is precached above, so no runtime caching rule is needed.
          // Supabase traffic deliberately has none either — an operator must never act on
          // stale stock, QC or dispatch numbers.
        },
        devOptions: {
          // Lets the install prompt and offline shell be exercised with `npm run dev`.
          enabled: true,
          type: 'module',
          navigateFallback: 'index.html',
          // In dev there is no build output to precache, so the glob legitimately
          // matches nothing — that warning is noise, not a misconfiguration.
          suppressWarnings: true,
        },
      }),
    ],
  }
})
