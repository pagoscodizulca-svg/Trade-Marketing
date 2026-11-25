import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createBuildVersionPlugin } from '../scripts/lib/buildVersionPlugin.ts';

// B-09: en producción la PWA se publica bajo `/logistica/` desde el mismo Express que la Torre de Control.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/logistica/' : '/',
  plugins: [
    react(),
    tailwindcss(),
    // PWA offline-first: precache del App Shell + Service Worker propio (src/sw.ts) con Background Sync.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false, // el registro se hace en src/lib/registerSw.ts (solo producción)
      manifest: false, // se usa public/manifest.json
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,json,woff2}'],
        globIgnores: ['**/version.json'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        rollupFormat: 'iife', // el SW se registra como script clásico
      },
      devOptions: { enabled: false },
    }),
    // Siempre al final: emite `version.json` y estampa `__APP_BUILD_ID__` en `dist/sw.js` tras VitePWA.
    createBuildVersionPlugin({
      appName: 'ruta-degustacion',
      stampFiles: ['sw.js'],
    }),
  ],
  server: { host: true, port: 5174, strictPort: true },
  preview: { host: true, port: 4174, strictPort: true },
}));
