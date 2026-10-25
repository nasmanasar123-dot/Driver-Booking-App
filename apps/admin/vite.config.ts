import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const api = process.env.API_URL ?? 'http://localhost:4000';

// In production all three apps are served from one address by the API (see apps/api/src/static.ts).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/admin/' : '/',
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
        start_url: '.',
        scope: '.',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//] },
    }),
  ],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': { target: api },
      '/socket.io': { target: api, ws: true },
    },
  },
}));
