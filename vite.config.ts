import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';
// Explicit extensions: Vite's native config loader (a future default) won't resolve bare paths.
import { telemetry } from './scripts/telemetry-plugin.ts';
import { upload } from './scripts/upload-plugin.ts';

// BASE_PATH is set by the GitHub Pages workflow (e.g. "/orrery-clock/").
const base = process.env.BASE_PATH ?? '/';
// HTTPS=1 serves the dev server over a self-signed certificate, so a headset on
// the same Wi-Fi can open it (WebXR only runs in a secure context).
const https = process.env.HTTPS === '1';

export default defineConfig({
  base,
  // One three.js build for everything: the example modules (controls, loaders)
  // import plain 'three', which must resolve to the same WebGPU build the app uses.
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  server: { host: '0.0.0.0', port: Number(process.env.DEV_PORT ?? 5173) },
  build: {
    target: 'es2022',
    // three.js (its WebGPU build) is ~1 MB minified on its own and can't usefully be split further;
    // every other chunk is far below this, so it still flags real growth.
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // three.js in a chunk of its own: it only changes when the dependency is upgraded, so a
          // deploy of app code leaves it cached (browser and service worker) instead of re-downloading ~1 MB.
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
  plugins: [
    ...(https ? [basicSsl()] : []),
    telemetry(process.cwd()),
    upload(process.cwd()),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'Orrery Clock',
        short_name: 'Orrery',
        description: 'A mechanical 3D orrery and clock showing the planets where they are right now.',
        theme_color: '#0b0a09',
        background_color: '#0b0a09',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // Take over as soon as a new version is installed, so returning
        // visitors never get stuck on a stale build.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Precache only the app shell. Textures are cached at runtime as they
        // are first requested, so the first visit never downloads anything twice.
        // Fonts: only the basic Latin subset is precached (so the first visit works offline); the others (Latin Extended,
        // Cyrillic, Greek, Vietnamese) are fetched and cached only if a page ever needs them.
        globPatterns: ['**/*.{js,css,html,svg}', 'assets/*-latin-[0-9]*.woff2'],
        globIgnores: ['textures/**'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/textures/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'textures-v1',
              expiration: { maxEntries: 160 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // The bundled VR controller model (Quest 3): cached when first loaded, so VR works offline after.
            urlPattern: ({ url }) => url.pathname.includes('/controllers/'),
            handler: 'CacheFirst',
            options: { cacheName: 'controllers-v1', cacheableResponse: { statuses: [0, 200] } },
          },
          {
            // Bundled font files outside the precache (file names are content-hashed, so never stale).
            urlPattern: ({ url }) => url.pathname.endsWith('.woff2'),
            handler: 'CacheFirst',
            options: { cacheName: 'fonts-v2', cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
  ],
});
