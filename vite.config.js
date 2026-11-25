import { defineConfig } from 'vite';

// The page is static; its data comes from the Pages Functions under /api.
// `bun run dev` sends those calls to `bun run pages` (wrangler, port 8788).
export default defineConfig({
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8788' } },
});
