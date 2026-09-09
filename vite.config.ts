import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8097', changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8097', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
        },
      },
    },
  },
});
