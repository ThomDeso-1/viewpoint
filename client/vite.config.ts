import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Viewpoint',
        short_name: 'Viewpoint',
        description: 'Capture receipts and manage exam bookings.',
        theme_color: '#1a2332',
        background_color: '#f5f3ef',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // No runtime caching of /api responses. They carry patient names,
        // DOB, masked cards and the audit trail; a NetworkFirst cache
        // would leave that PHI in Cache Storage on the device, outside
        // the app's auth and audit (AUDIT P1-6). The precached app shell
        // still loads offline — it just can't show server data.
        //
        // Receipt photos: CacheFirst so a captured receipt is reviewable
        // over a flaky LAN, but a short window and a small cap.
        runtimeCaching: [
          {
            urlPattern: /^\/images\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/images': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
