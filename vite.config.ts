import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH is set by the GitHub Pages workflow (e.g. "/orrery-clock/").
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  server: { host: '0.0.0.0', port: Number(process.env.DEV_PORT ?? 5173) },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  plugins: [
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
        globPatterns: ['**/*.{js,css,html,svg}'],
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
            urlPattern: ({ url }) =>
              url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'fonts-v1', cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
});
