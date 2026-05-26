import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: '.',
  build: {
    outDir: '../../services/audio-pipeline/app/static',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        createProject: resolve(__dirname, 'create-project.html'),
        loading: resolve(__dirname, 'loading.html'),
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
      // aggregator REST — must be proxied or fetch() lands on the SPA's index.html
      '/session': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      // audio-pipeline batch analysis at session end (webm → STT + prosody)
      '/analyze': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/api/coach': {
        target: 'http://localhost:8002',
        changeOrigin: true,
      },
    },
  },
});
