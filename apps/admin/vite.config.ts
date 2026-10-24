import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const api = process.env.API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Ops Dashboard',
        short_name: 'Ops',
        theme_color: '#3b3f46',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//] },
    }),
  ],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': { target: api, rewrite: (path) => path.replace(/^\/api/, '') },
      '/socket.io': { target: api, ws: true },
    },
  },
});
