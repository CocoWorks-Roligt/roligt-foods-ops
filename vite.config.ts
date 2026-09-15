import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
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
        background_color: '#f5f0e6',
        theme_color: '#253d2b',
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
        // SPA: any navigation that misses the cache falls back to the app shell.
        navigateFallback: '/index.html',
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
})
