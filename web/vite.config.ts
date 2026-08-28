import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client is a standalone static bundle. It talks to the API over HTTPS on a
 * different origin, so the API base URL is build-time configuration
 * (`VITE_API_URL`) rather than a same-origin assumption.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: { port: 5173 },
});
