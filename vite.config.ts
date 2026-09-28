import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const require = createRequire(import.meta.url)

/**
 * Serves the Zoho Apptics SDK script at /vendor/apptics.js. The npm package
 * cannot be imported as a module (no exports; its IIFE binds `this`, which is
 * only window under a classic <script>), so src/lib/appticsSdk.ts injects that
 * script at runtime and this plugin is where the file comes from: emitted as a
 * build asset, served straight from node_modules in dev. It exists only in the
 * plugin list when the staging token is present — a production build neither
 * emits nor executes a byte of the SDK.
 */
function appticsVendorPlugin(): Plugin {
  const read = () => readFileSync(require.resolve('@zoho_apptics/apptics-js-sdk'), 'utf8')
  return {
    name: 'apptics-vendor-script',
    configureServer(server) {
      server.middlewares.use('/vendor/apptics.js', (_req, res) => {
        res.setHeader('content-type', 'application/javascript')
        res.end(read())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'vendor/apptics.js', source: read() })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The Apptics staging gate: the token is set in .env.local and Vercel
  // Preview/Development only. Absence removes the vendor plugin entirely, so
  // production builds carry no SDK script for the workbox precache to pick up.
  const appticsEnabled = Boolean(loadEnv(mode, process.cwd(), 'VITE_').VITE_APPTICS_APP_TOKEN)
  return {
    plugins: [
      react(),
      ...(appticsEnabled ? [appticsVendorPlugin()] : []),
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
