import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {createBuildVersionPlugin} from './scripts/lib/buildVersionPlugin.ts';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      createBuildVersionPlugin({
        appName: 'trade-marketing',
        stampFiles: ['sw.js'],
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    build: {
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            const norm = id.replace(/\\/g, '/');
            if (
              norm.includes('/node_modules/react/') ||
              norm.includes('/node_modules/react-dom/') ||
              norm.includes('/node_modules/scheduler/')
            ) {
              return 'vendor-react';
            }
            if (norm.includes('/node_modules/@supabase/')) {
              return 'vendor-supabase';
            }
            if (
              norm.includes('/node_modules/jszip/') ||
              norm.includes('/node_modules/pako/')
            ) {
              return 'vendor-jszip';
            }
            if (
              norm.includes('/node_modules/readable-stream/') ||
              norm.includes('/node_modules/saxes/') ||
              norm.includes('/node_modules/fast-csv/') ||
              norm.includes('/node_modules/@fast-csv/') ||
              norm.includes('/node_modules/archiver/') ||
              norm.includes('/node_modules/unzipper/')
            ) {
              return 'vendor-excel-streams';
            }
            if (norm.includes('/node_modules/exceljs/')) {
              return 'vendor-exceljs-core';
            }
            if (norm.includes('/node_modules/read-excel-file/')) {
              return 'vendor-excel-reader';
            }
            if (norm.includes('/node_modules/docx/')) {
              return 'vendor-docx';
            }
            if (
              norm.includes('/node_modules/jspdf/') ||
              norm.includes('/node_modules/jspdf-autotable/')
            ) {
              return 'vendor-jspdf';
            }
            if (
              norm.includes('/node_modules/html2canvas/') ||
              norm.includes('/node_modules/dompurify/') ||
              norm.includes('/node_modules/canvg/')
            ) {
              return 'vendor-pdf-canvas';
            }
            if (
              norm.includes('/node_modules/motion/') ||
              norm.includes('/node_modules/framer-motion/') ||
              norm.includes('/node_modules/motion-dom/') ||
              norm.includes('/node_modules/motion-utils/')
            ) {
              return 'vendor-motion';
            }
            if (norm.includes('/node_modules/lucide-react/')) {
              return 'vendor-icons';
            }
            if (norm.includes('/node_modules/zod/')) {
              return 'vendor-zod';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});