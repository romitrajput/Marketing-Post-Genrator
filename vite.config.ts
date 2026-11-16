import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// base './' makes the build work from any sub-path (GitHub Pages project sites,
// Cloudflare Pages, a USB stick...). Routing is hash-based so no server rewrites are needed.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  worker: { format: 'iife' },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
});
