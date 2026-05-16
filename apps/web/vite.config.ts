import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: '.',
  build: {
    outDir: '../../services/audio-pipeline/app/static',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        practice: resolve(__dirname, 'practice.html'),
        report: resolve(__dirname, 'report.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws/stt': {
        target: 'ws://localhost:8000',
        ws: true,
        changeOrigin: true,
      },
      '/ws/signals': {
        target: 'ws://localhost:8001',
        ws: true,
        changeOrigin: true,
      },
      '/api/coach': {
        target: 'http://localhost:8002',
        changeOrigin: true,
      },
    },
  },
});
