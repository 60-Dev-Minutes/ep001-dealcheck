import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the static client only; the Worker is bundled by Wrangler.
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8787', '/health': 'http://localhost:8787' } },
});
