import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI lives in web/ and builds to dist/web, which the API server serves.
// In dev (`npm run dev`), Vite serves the UI on :5173 and proxies API calls to :3000.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/uploads': 'http://127.0.0.1:3000',
    },
  },
});
