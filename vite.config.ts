import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Storage, MP4 export and TTS now live on the shared spreadsheet-builder server
// (Google login + Drive-backed files). This app is just the SPA; the builder
// hosts its build under a path and proxies its API.
//
// `base` must match that mount: '/whiteboard/' for local dev, and the deployed
// value (e.g. '/builder/whiteboard/') for production — set WHITEBOARD_BASE when
// building for the server.
const base = process.env.WHITEBOARD_BASE || '/whiteboard/'

// Local dev: proxy the storage/render API + Google auth to the builder. Run the
// builder with BUILDER_PUBLIC_BASE_URL=http://localhost:5173 and add that origin's
// /auth/google/callback to the OAuth client, so the session cookie is set for this
// origin (cookieDomainRewrite makes proxied Set-Cookie apply to localhost).
const builderOrigin = process.env.BUILDER_ORIGIN || 'http://localhost:8787'
const proxyOpts = { target: builderOrigin, changeOrigin: true, cookieDomainRewrite: '' }

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split third-party deps (React, opentype.js, dnd-kit, zustand, …) into a
        // separate `vendor` chunk: it changes rarely, so it caches independently of
        // the app code (better repeat loads) and the main chunk drops back under the
        // 500 kB size-warning threshold.
        manualChunks(id) {
          if (id.includes('/node_modules/')) return 'vendor'
        },
      },
    },
  },
  server: {
    proxy: {
      '/whiteboard/api': proxyOpts,
      '/auth': proxyOpts,
    },
  },
})
